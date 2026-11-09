package ar.com.learnharness;

import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.security.*;
import java.util.*;
import java.util.zip.*;
import org.json.*;

/** Runs with Android's org.json through app_process; never uses a real app profile. */
public final class BackupImportChecks {
    private static int passed;
    private static void check(boolean value, String message) {
        if (!value) throw new AssertionError(message);
        passed++;
    }
    private static byte[] bytes(String text) { return text.getBytes(StandardCharsets.UTF_8); }
    private static Map<String, byte[]> fixture() {
        Map<String, byte[]> files = new LinkedHashMap<>();
        files.put("chats/chat_test_1.json", bytes("{\"id\":\"chat_test_1\",\"messages\":[],\"title\":\"Saved session\"}"));
        files.put("jobs/job_test_1.json", bytes("{\"id\":\"job_test_1\",\"chatId\":\"chat_test_1\",\"status\":\"done\"}"));
        files.put("settings.json", bytes("{\"version\":1,\"models\":{}}"));
        return files;
    }
    private static String hash(byte[] bytes) throws Exception {
        StringBuilder out = new StringBuilder();
        for (byte b : MessageDigest.getInstance("SHA-256").digest(bytes)) out.append(String.format(Locale.ROOT, "%02x", b & 255));
        return out.toString();
    }
    private static byte[] archive(Map<String, byte[]> files, String mode) throws Exception {
        JSONArray entries = new JSONArray();
        for (Map.Entry<String, byte[]> file : files.entrySet()) entries.put(new JSONObject()
            .put("path", file.getKey()).put("bytes", file.getValue().length)
            .put("sha256", mode.equals("hash") ? "0".repeat(64) : hash(file.getValue())));
        JSONObject manifest = new JSONObject().put("format", "learnharness-backup").put("version", mode.equals("version") ? 999 : 1).put("files", entries);
        ByteArrayOutputStream result = new ByteArrayOutputStream();
        try (ZipOutputStream zip = new ZipOutputStream(result)) {
            zip.putNextEntry(new ZipEntry("learnharness-backup.json")); zip.write(bytes(manifest.toString())); zip.closeEntry();
            for (Map.Entry<String, byte[]> file : files.entrySet()) {
                if (mode.equals("missing") && file.getKey().startsWith("chats/")) continue;
                zip.putNextEntry(new ZipEntry("data/" + file.getKey())); zip.write(file.getValue()); zip.closeEntry();
            }
            if (mode.equals("extra")) {
                zip.putNextEntry(new ZipEntry("data/chats/chat_extra.json")); zip.write(bytes("{}")); zip.closeEntry();
            }
        }
        return result.toByteArray();
    }
    private static BackupImporter.Prepared prepare(byte[] zip, File root) throws Exception {
        return BackupImporter.prepare(new ByteArrayInputStream(zip), root);
    }
    private static void write(File root, String path, byte[] content) throws Exception {
        File file = new File(root, path); file.getParentFile().mkdirs(); Files.write(file.toPath(), content);
    }
    private static void reject(File root, byte[] zip, String name) throws Exception {
        boolean refused = false;
        try { prepare(zip, root); } catch (IOException expected) { refused = true; }
        check(refused, name + " must be rejected");
        check(root.listFiles().length == 0, name + " must clean its staging files");
    }
    public static void main(String[] args) throws Exception {
        File root = new File(args[0]);
        if (!root.mkdir()) throw new IOException("Use a fresh empty test path");
        Map<String, byte[]> fixture = fixture(); byte[] zip = archive(fixture, "valid");
        File fresh = new File(root, "fresh"); fresh.mkdir();
        write(fresh, "auth.json", bytes("credentials-must-stay"));
        BackupImporter.Prepared prepared = prepare(zip, fresh);
        check(prepared.sessions == 1 && prepared.jobs == 1, "Session and result counts");
        BackupImporter.queue(prepared, fresh);
        check(!new File(fresh, "data").exists(), "Queue must not mutate live data");
        BackupImporter.applyPending(fresh);
        for (String path : fixture.keySet()) check(Arrays.equals(fixture.get(path), Files.readAllBytes(new File(fresh, "data/" + path).toPath())), "Exact restore: " + path);
        check(new String(Files.readAllBytes(new File(fresh, "auth.json").toPath())).equals("credentials-must-stay"), "Credentials preserved");
        check(!new File(fresh, "import-pending").exists(), "Pending state cleared");
        BackupImporter.queue(prepare(zip, fresh), fresh); BackupImporter.applyPending(fresh);
        check(new File(fresh, "data/chats").list().length == 1, "Repeated import is idempotent");

        File merge = new File(root, "merge"); merge.mkdir();
        write(merge, "data/settings.json", bytes("{\"phone\":true}"));
        write(merge, "data/chats/chat_phone.json", bytes("phone-session"));
        BackupImporter.queue(prepare(zip, merge), merge); BackupImporter.applyPending(merge);
        check(new String(Files.readAllBytes(new File(merge, "data/settings.json").toPath())).equals("{\"phone\":true}"), "Phone settings win");
        check(new String(Files.readAllBytes(new File(merge, "data/chats/chat_phone.json").toPath())).equals("phone-session"), "Unrelated phone session preserved");

        File conflict = new File(root, "conflict"); conflict.mkdir();
        write(conflict, "data/chats/chat_test_1.json", bytes("different-phone-version"));
        BackupImporter.queue(prepare(zip, conflict), conflict);
        boolean refused = false;
        try { BackupImporter.applyPending(conflict); } catch (IOException expected) { refused = true; }
        check(refused, "Conflicting session refused");
        check(!new File(conflict, "data/jobs").exists(), "Conflict has no partial import");
        check(new String(Files.readAllBytes(new File(conflict, "data/chats/chat_test_1.json").toPath())).equals("different-phone-version"), "Conflict keeps original");

        for (String mode : Arrays.asList("hash", "missing", "extra", "version")) {
            File bad = new File(root, mode); bad.mkdir(); reject(bad, archive(fixture, mode), mode);
        }
        for (String path : Arrays.asList("../escape", "auth.json", "chatgpt-credentials.json", "chats/../../escape.json")) {
            File bad = new File(root, "path-" + passed); bad.mkdir();
            Map<String, byte[]> files = fixture(); files.put(path, bytes("secret")); reject(bad, archive(files, "valid"), path);
        }
        File running = new File(root, "running"); running.mkdir();
        Map<String, byte[]> active = fixture(); active.put("jobs/job_test_1.json", bytes("{\"id\":\"job_test_1\",\"chatId\":\"chat_test_1\",\"status\":\"running\"}"));
        reject(running, archive(active, "valid"), "Running job");
        File orphan = new File(root, "orphan"); orphan.mkdir();
        Map<String, byte[]> incomplete = fixture(); incomplete.put("jobs/job_test_1.json", bytes("{\"id\":\"job_test_1\",\"chatId\":\"chat_missing\",\"status\":\"done\"}"));
        reject(orphan, archive(incomplete, "valid"), "Orphaned job");
        File cancel = new File(root, "cancel"); cancel.mkdir(); prepare(zip, cancel).discard();
        check(cancel.list().length == 0, "Cancel removes staged backup");
        File large = new File(root, "large"); large.mkdir();
        Map<String, byte[]> huge = fixture(); huge.put("chats/chat_large.json", new byte[33 * 1024 * 1024]);
        reject(large, archive(huge, "valid"), "Oversized compressed entry");
        System.out.println("PASS: " + passed + " backup import checks");
    }
}
