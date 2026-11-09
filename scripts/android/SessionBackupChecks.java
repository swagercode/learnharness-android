package ar.com.learnharness.tests;

import android.app.*;
import android.content.*;
import android.os.*;
import android.webkit.*;
import java.io.*;
import java.net.*;
import java.lang.reflect.*;
import java.nio.file.*;
import java.security.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import org.json.*;

/** Same-signer instrumentation. Snapshot before `adb install -r`; verify after.
 * Restore checks use a fresh cache directory, never the real session directory. */
public final class SessionBackupChecks extends Instrumentation {
    private String phase;
    private int checks;
    @Override public void onCreate(Bundle args) { super.onCreate(args); phase = args.getString("phase", "verify"); start(); }
    private void check(boolean okay, String name) {
        if (!okay) throw new AssertionError(name);
        checks++; Bundle state = new Bundle(); state.putString("check", name); sendStatus(0, state);
    }
    private String digest(File file) throws Exception {
        MessageDigest hash = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(file)) { byte[] bytes = new byte[32768]; int n; while ((n = in.read(bytes)) != -1) hash.update(bytes, 0, n); }
        StringBuilder result = new StringBuilder(); for (byte b : hash.digest()) result.append(String.format("%02x", b & 255)); return result.toString();
    }
    private JSONObject records(File data) throws Exception {
        JSONObject result = new JSONObject();
        for (String name : Arrays.asList("chats", "jobs")) {
            File[] files = new File(data, name).listFiles();
            if (files != null) for (File file : files) if (file.getName().endsWith(".json")) result.put(name + "/" + file.getName(), digest(file));
        }
        return result;
    }
    private String field(String name) throws Exception {
        Field f = Class.forName("ar.com.learnharness.RuntimeService").getDeclaredField(name); f.setAccessible(true); return (String) f.get(null);
    }
    private String evaluate(WebView web, String script) throws Exception {
        AtomicReference<String> result = new AtomicReference<>(); CountDownLatch done = new CountDownLatch(1);
        runOnMainSync(() -> web.evaluateJavascript(script, value -> { result.set(value); done.countDown(); }));
        if (!done.await(5, TimeUnit.SECONDS)) throw new AssertionError("JavaScript timeout");
        return result.get();
    }
    private void remove(File file) { if (file.isDirectory()) { File[] files = file.listFiles(); if (files != null) for (File f : files) remove(f); } file.delete(); }
    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            File base = new File(getTargetContext().getNoBackupFilesDir(), "learnharness");
            File saved = new File(getTargetContext().getCacheDir(), "session-upgrade-check.json");
            if (phase.equals("snapshot")) {
                JSONObject before = records(new File(base, "data"));
                check(before.length() > 0, "Existing session records available");
                Files.write(saved.toPath(), before.toString().getBytes("UTF-8"));
                result.putString("result", "PASS: saved pre-upgrade record hashes"); finish(Activity.RESULT_OK, result); return;
            }
            JSONObject before = new JSONObject(new String(Files.readAllBytes(saved.toPath()), "UTF-8"));
            JSONObject after = records(new File(base, "data"));
            check(before.toString().equals(after.toString()), "APK update preserves every session and job byte-for-byte");
            Activity activity = startActivitySync(new Intent(Intent.ACTION_MAIN).setClassName("ar.com.learnharness", "ar.com.learnharness.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
            Field webField = activity.getClass().getDeclaredField("web"); webField.setAccessible(true); WebView web = (WebView) webField.get(activity);
            long deadline = SystemClock.uptimeMillis() + 120000;
            while (SystemClock.uptimeMillis() < deadline && !"true".equals(evaluate(web, "!!document.querySelector('[data-testid=dictation-toggle]')"))) Thread.sleep(250);
            check("true".equals(evaluate(web, "!!document.querySelector('[data-testid=dictation-toggle]')")), "Updated Android runtime opens");
            HttpURLConnection request = (HttpURLConnection) new URL(field("origin") + "/api/backups/sessions").openConnection();
            request.setConnectTimeout(10000); request.setReadTimeout(60000);
            request.setRequestProperty("Cookie", "lh_android=" + field("secret"));
            check(request.getResponseCode() == 200, "Backup route succeeds with private app authorization");
            check(request.getHeaderField("Content-Disposition").contains(".lhbackup.zip"), "Export has a restorable backup filename");
            File scratch = new File(getTargetContext().getCacheDir(), "backup-roundtrip-" + UUID.randomUUID()); scratch.mkdir();
            try {
                Class<?> importer = Class.forName("ar.com.learnharness.BackupImporter");
                Object prepared;
                try (InputStream in = request.getInputStream()) { prepared = importer.getMethod("prepare", InputStream.class, File.class).invoke(null, in, scratch); }
                check(prepared.getClass().getField("sessions").getInt(prepared) > 0, "Android importer verifies exported archive and hashes");
                importer.getMethod("queue", prepared.getClass(), File.class).invoke(null, prepared, scratch);
                importer.getMethod("applyPending", File.class).invoke(null, scratch);
                JSONObject restored = records(new File(scratch, "data"));
                check(after.toString().equals(restored.toString()), "All sessions and saved jobs restore byte-for-byte");
                check(!new File(scratch, "auth.json").exists() && !new File(scratch, "data/auth.json").exists(), "Backup does not contain API keys or sign-ins");
            } finally { request.disconnect(); remove(scratch); }
            check(after.toString().equals(records(new File(base, "data")).toString()), "Export and restore test leave original sessions unchanged");
            result.putString("result", "PASS: " + checks + " update/export/restore checks");
            finish(Activity.RESULT_OK, result);
        } catch (Throwable error) { result.putString("error", error.toString()); finish(Activity.RESULT_CANCELED, result); }
    }
}
