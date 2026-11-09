package ar.com.learnharness;

import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.*;
import java.util.*;
import java.util.zip.*;

/** Session backups are staged while Node is running and applied before its next start. */
public final class BackupImporter {
    private static final long MAX_FILE = 32L * 1024 * 1024, MAX_TOTAL = 256L * 1024 * 1024;
    private static final int MAX_FILES = 2000;
    private static final String MANIFEST = "learnharness-backup.json";

    public static final class Prepared {
        final File directory;
        public final int sessions, jobs;
        Prepared(File directory, int sessions, int jobs) {
            this.directory = directory; this.sessions = sessions; this.jobs = jobs;
        }
        public void discard() { removeTree(directory); }
    }

    private static boolean allowed(String path) {
        return path.equals("settings.json") || path.matches("chats/chat_[a-zA-Z0-9_\\-]+\\.json")
            || path.matches("jobs/job_[a-zA-Z0-9_\\-]+\\.json");
    }

    private static File child(File root, String name) throws IOException {
        File result = new File(root, name);
        if (!result.getCanonicalPath().startsWith(root.getCanonicalPath() + File.separator))
            throw new IOException("Invalid backup path");
        File cursor = result;
        while (!cursor.equals(root)) {
            if (Files.isSymbolicLink(cursor.toPath())) throw new IOException("Symbolic links are not supported");
            cursor = cursor.getParentFile();
        }
        return result;
    }

    private static String sha256(File file) throws IOException {
        try {
            MessageDigest hash = MessageDigest.getInstance("SHA-256");
            try (InputStream in = new FileInputStream(file)) {
                byte[] buffer = new byte[32768]; int n;
                while ((n = in.read(buffer)) != -1) hash.update(buffer, 0, n);
            }
            StringBuilder out = new StringBuilder();
            for (byte b : hash.digest()) out.append(String.format(Locale.ROOT, "%02x", b & 255));
            return out.toString();
        } catch (NoSuchAlgorithmException error) { throw new IOException(error); }
    }

    private static JSONObject json(File file) throws IOException, JSONException {
        return new JSONObject(new String(Files.readAllBytes(file.toPath()), StandardCharsets.UTF_8));
    }

    private static LinkedHashMap<String, JSONObject> validate(File stage) throws IOException, JSONException {
        JSONObject manifest = json(new File(stage, MANIFEST));
        if (!"learnharness-backup".equals(manifest.optString("format")) || manifest.optInt("version") != 1)
            throw new IOException("This is not a supported LearnHarness backup");
        JSONArray files = manifest.getJSONArray("files");
        if (files.length() == 0 || files.length() > MAX_FILES) throw new IOException("Invalid backup file count");
        LinkedHashMap<String, JSONObject> result = new LinkedHashMap<>();
        Set<String> sessions = new HashSet<>();
        long total = 0;
        for (int i = 0; i < files.length(); i++) {
            JSONObject item = files.getJSONObject(i);
            String path = item.getString("path"), digest = item.getString("sha256");
            long bytes = item.getLong("bytes");
            if (!allowed(path) || result.containsKey(path) || !digest.matches("[a-f0-9]{64}") || bytes < 0 || bytes > MAX_FILE)
                throw new IOException("Invalid backup file record");
            total += bytes;
            if (total > MAX_TOTAL) throw new IOException("Backup is too large");
            File file = child(stage, "data/" + path);
            if (!file.isFile() || file.length() != bytes || !sha256(file).equals(digest))
                throw new IOException("Backup is incomplete or damaged");
            JSONObject record = json(file);
            if (!path.equals("settings.json")) {
                String id = record.getString("id");
                if (!path.substring(path.indexOf('/') + 1).equals(id + ".json")) throw new IOException("Session ID does not match its filename");
                if (path.startsWith("chats/")) {
                    record.getJSONArray("messages"); sessions.add(id);
                } else if (!Arrays.asList("done", "error", "cancelled", "canceled", "aborted").contains(record.optString("status"))) {
                    throw new IOException("Finish running background work before exporting");
                }
            }
            result.put(path, item);
        }
        if (sessions.isEmpty()) throw new IOException("This backup contains no saved sessions");
        for (String path : result.keySet()) {
            if (path.startsWith("jobs/") && !sessions.contains(json(child(stage, "data/" + path)).getString("chatId")))
                throw new IOException("A saved research result has no matching session");
        }
        return result;
    }

    public static Prepared prepare(InputStream input, File privateDir) throws IOException {
        if (!privateDir.isDirectory() && !privateDir.mkdirs()) throw new IOException("Cannot create import storage");
        File stage = new File(privateDir, "import-stage-" + UUID.randomUUID());
        if (!stage.mkdir()) throw new IOException("Cannot create import storage");
        Set<String> seen = new HashSet<>(); long total = 0;
        try (ZipInputStream zip = new ZipInputStream(input)) {
            ZipEntry entry;
            while ((entry = zip.getNextEntry()) != null) {
                String name = entry.getName();
                if (entry.isDirectory()) {
                    if (!Arrays.asList("data/", "data/chats/", "data/jobs/").contains(name)) throw new IOException("Unexpected backup directory");
                    continue;
                }
                if ((!name.equals(MANIFEST) && !(name.startsWith("data/") && allowed(name.substring(5))))
                        || !seen.add(name) || seen.size() > MAX_FILES + 1) throw new IOException("Unexpected or duplicate backup file");
                File file = child(stage, name);
                if (!file.getParentFile().isDirectory() && !file.getParentFile().mkdirs()) throw new IOException("Cannot unpack backup");
                long size = 0;
                try (FileOutputStream out = new FileOutputStream(file)) {
                    byte[] buffer = new byte[32768]; int n;
                    while ((n = zip.read(buffer)) != -1) {
                        size += n; total += n;
                        if (size > (name.equals(MANIFEST) ? 1024 * 1024 : MAX_FILE) || total > MAX_TOTAL + 1024 * 1024)
                            throw new IOException("Backup is too large");
                        out.write(buffer, 0, n);
                    }
                    out.getFD().sync();
                }
                zip.closeEntry();
            }
            LinkedHashMap<String, JSONObject> files = validate(stage);
            if (seen.size() != files.size() + 1 || !seen.contains(MANIFEST)) throw new IOException("Backup file list does not match its contents");
            int sessions = 0, jobs = 0;
            for (String name : files.keySet()) { if (name.startsWith("chats/")) sessions++; if (name.startsWith("jobs/")) jobs++; }
            return new Prepared(stage, sessions, jobs);
        } catch (Exception error) {
            removeTree(stage);
            throw error instanceof IOException ? (IOException) error : new IOException("Backup metadata is invalid", error);
        }
    }

    public static synchronized void queue(Prepared prepared, File privateDir) throws IOException {
        File pending = new File(privateDir, "import-pending");
        if (pending.exists()) throw new IOException("Reopen LearnHarness to finish the previous import first");
        if (!prepared.directory.renameTo(pending)) throw new IOException("Cannot save the pending import");
    }

    /** No runtime may be writing the data directory while this method runs. */
    public static synchronized String applyPending(File privateDir) throws IOException {
        File pending = new File(privateDir, "import-pending");
        if (!pending.exists()) return null;
        File data = new File(privateDir, "data");
        LinkedHashMap<String, JSONObject> files;
        try { files = validate(pending); }
        catch (JSONException error) { throw new IOException("Backup metadata is invalid", error); }
        // Preflight every conflict before creating any destination file. Phone settings win.
        for (String path : files.keySet()) {
            File destination = child(data, path);
            if (destination.exists() && !path.equals("settings.json")
                    && (!destination.isFile() || !sha256(destination).equals(files.get(path).optString("sha256"))))
                throw new IOException("The phone has a different version of a session in this backup. No sessions were replaced");
        }
        List<File> created = new ArrayList<>();
        int sessions = 0;
        try {
            for (String path : files.keySet()) {
                if (path.startsWith("chats/")) sessions++;
                File destination = child(data, path);
                if (destination.exists()) continue;
                if (!destination.getParentFile().isDirectory() && !destination.getParentFile().mkdirs()) throw new IOException("Cannot create session storage");
                File temp = new File(destination.getParentFile(), ".import-" + UUID.randomUUID());
                try {
                    try (InputStream in = new FileInputStream(child(pending, "data/" + path)); FileOutputStream out = new FileOutputStream(temp)) {
                        byte[] buffer = new byte[32768]; int n;
                        while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
                        out.getFD().sync();
                    }
                    if (!temp.renameTo(destination)) throw new IOException("Cannot save imported session");
                    created.add(destination);
                } finally { temp.delete(); }
            }
        } catch (IOException error) {
            for (File file : created) file.delete();
            throw error;
        }
        removeTree(pending);
        return "Imported " + sessions + " sessions from your backup.";
    }

    private static void removeTree(File file) {
        if (file.isDirectory() && !Files.isSymbolicLink(file.toPath())) {
            File[] children = file.listFiles();
            if (children != null) for (File child : children) removeTree(child);
        }
        file.delete();
    }
}
