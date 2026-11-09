package ar.com.learnharness.tests;

import android.app.*;
import android.content.*;
import android.os.*;
import android.webkit.*;
import org.json.*;
import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/** Exercises the real secondary-process WebView with generated test documents.
 * No model calls, sessions, sign-ins, or production auth files are touched. */
public final class DemoRendererChecks extends Instrumentation {
    private int checks;
    private final CountDownLatch bound = new CountDownLatch(1);
    private final ServiceConnection connection = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder service) { bound.countDown(); }
        @Override public void onServiceDisconnected(ComponentName name) { }
    };
    private void check(boolean okay, String name) { if (!okay) throw new AssertionError(name); checks++; Bundle out = new Bundle(); out.putString("check", name); sendStatus(0, out); }
    @Override public void onCreate(Bundle args) { super.onCreate(args); start(); }
    private JSONObject run(JSONObject fixture, File directory) throws Exception {
        String id = UUID.randomUUID().toString();
        File request = new File(directory, id + ".request"), response = new File(directory, id + ".response"), temp = new File(directory, id + ".tmp");
        JSONObject input = new JSONObject().put("document", fixture.getString("document")).put("settleMs", fixture.optInt("settleMs", 200)).put("createdAt", System.currentTimeMillis());
        try {
            Files.write(temp.toPath(), input.toString().getBytes("UTF-8")); Files.move(temp.toPath(), request.toPath(), StandardCopyOption.ATOMIC_MOVE);
            long deadline = SystemClock.uptimeMillis() + 40_000;
            while (!response.exists() && SystemClock.uptimeMillis() < deadline) Thread.sleep(50);
            if (!response.exists()) throw new AssertionError("Renderer did not respond: " + fixture.getString("name"));
            return new JSONObject(new String(Files.readAllBytes(response.toPath()), "UTF-8"));
        } finally { request.delete(); response.delete(); temp.delete(); }
    }
    @Override public void onStart() {
        Bundle result = new Bundle(); boolean connected = false;
        try {
            Intent service = new Intent().setClassName("ar.com.learnharness", "ar.com.learnharness.DemoRendererService");
            connected = getTargetContext().bindService(service, connection, Context.BIND_AUTO_CREATE);
            check(connected && bound.await(15, TimeUnit.SECONDS), "Android verifier binds without an open app window");
            File directory = new File(getTargetContext().getCacheDir(), "demo-verifier"); directory.mkdirs();
            CountDownLatch cookieDone = new CountDownLatch(1);
            runOnMainSync(() -> CookieManager.getInstance().setCookie("https://learnharness-verifier.invalid", "lh_verifier_check=retained", success -> cookieDone.countDown()));
            check(cookieDone.await(5, TimeUnit.SECONDS), "Main WebView test cookie set");
            JSONArray fixtures;
            try (InputStream in = getContext().getAssets().open("demo-fixtures.json")) { fixtures = new JSONArray(new String(in.readAllBytes(), "UTF-8")); }
            for (int i = 0; i < fixtures.length(); i++) {
                JSONObject fixture = fixtures.getJSONObject(i), output = run(fixture, directory);
                boolean expected = fixture.getBoolean("ok");
                check(output.getBoolean("ok") == expected, fixture.getString("name") + " " + (expected ? "passes" : "is rejected") + (output.getBoolean("ok") != expected ? ": " + output : ""));
                if (fixture.has("probeResult")) check(String.valueOf(output.opt("probeResult")).equals(String.valueOf(fixture.get("probeResult"))), fixture.getString("name") + " probe matches " + fixture.get("probeResult"));
            }
            AtomicReference<String> cookie = new AtomicReference<>(); runOnMainSync(() -> cookie.set(CookieManager.getInstance().getCookie("https://learnharness-verifier.invalid")));
            check(cookie.get() != null && cookie.get().contains("lh_verifier_check=retained"), "Verifier never clears or shares the app cookie profile");
            runOnMainSync(() -> CookieManager.getInstance().setCookie("https://learnharness-verifier.invalid", "lh_verifier_check=; Max-Age=0"));
            getTargetContext().unbindService(connection); connected = false; Thread.sleep(1200);
            CountDownLatch rebound = new CountDownLatch(1);
            ServiceConnection again = new ServiceConnection() { @Override public void onServiceConnected(ComponentName n, IBinder b) { rebound.countDown(); } @Override public void onServiceDisconnected(ComponentName n) { } };
            check(getTargetContext().bindService(service, again, Context.BIND_AUTO_CREATE) && rebound.await(15, TimeUnit.SECONDS), "Verifier rebinds after idle shutdown");
            try { check(run(fixtures.getJSONObject(0), directory).getBoolean("ok"), "Verification still works after service recreation"); }
            finally { getTargetContext().unbindService(again); }
            result.putString("result", "PASS: " + checks + " Android demo verification checks"); finish(Activity.RESULT_OK, result);
        } catch (Throwable error) { result.putString("error", error.toString()); finish(Activity.RESULT_CANCELED, result); }
        finally { if (connected) getTargetContext().unbindService(connection); }
    }
}
