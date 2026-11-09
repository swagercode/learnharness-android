package ar.com.learnharness;

import android.app.Service;
import android.app.Presentation;
import android.content.Intent;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.os.*;
import android.view.View;
import android.view.WindowManager;
import android.webkit.*;
import org.json.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/** Bound to the runtime, not to the Activity. Its separate WebView profile
 * never contains sign-in cookies. Untrusted demos have no network or bridge. */
public final class DemoRendererService extends Service {
    private static boolean profileConfigured;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ThreadPoolExecutor worker = new ThreadPoolExecutor(1, 1, 0, TimeUnit.MILLISECONDS, new ArrayBlockingQueue<>(4));
    private final Set<String> scheduled = ConcurrentHashMap.newKeySet();
    private File directory;
    private FileObserver observer;
    private volatile boolean closed;
    private Run active;

    @Override public void onCreate() {
        super.onCreate();
        if (Build.VERSION.SDK_INT < 28) { stopSelf(); return; }
        if (!profileConfigured) {
            WebView.setDataDirectorySuffix("demo-verifier");
            CookieManager.getInstance().setAcceptCookie(false);
            profileConfigured = true;
        }
        directory = new File(getCacheDir(), "demo-verifier"); directory.mkdirs();
        observer = new FileObserver(directory.getAbsolutePath(), FileObserver.MOVED_TO | FileObserver.CLOSE_WRITE) {
            @Override public void onEvent(int event, String name) { if (name != null) enqueue(name); }
        };
        observer.startWatching();
        File[] files = directory.listFiles();
        if (files != null) for (File file : files) {
            if (System.currentTimeMillis() - file.lastModified() > 180_000) file.delete();
            else enqueue(file.getName());
        }
    }

    private void enqueue(String name) {
        if (closed || !name.matches("[a-f0-9-]{36}\\.request") || !scheduled.add(name)) return;
        try { worker.execute(() -> { try { process(name); } finally { scheduled.remove(name); } }); }
        catch (RejectedExecutionException error) {
            scheduled.remove(name);
            writeResult(name, failure("Android verifier is busy. Try this demo again shortly."));
        }
    }

    private void process(String name) {
        File request = new File(directory, name);
        if (!request.isFile() || closed) return;
        try {
            if (request.length() > 2_000_000) throw new IOException("Demo document is too large");
            JSONObject input = new JSONObject(new String(Files.readAllBytes(request.toPath()), StandardCharsets.UTF_8));
            if (System.currentTimeMillis() - input.getLong("createdAt") > 120_000) throw new IOException("Verification request expired");
            String document = input.getString("document");
            int settle = Math.min(5000, Math.max(0, input.optInt("settleMs", 2000)));
            CountDownLatch done = new CountDownLatch(1);
            AtomicReference<JSONObject> output = new AtomicReference<>();
            AtomicReference<Run> run = new AtomicReference<>();
            main.post(() -> {
                if (closed) { output.set(failure("Android verifier stopped")); done.countDown(); return; }
                Run task = new Run(document, settle, output, done); run.set(task); active = task; task.start();
            });
            if (!done.await(30, TimeUnit.SECONDS)) {
                main.post(() -> { Run task = run.get(); if (task != null) task.finish(failure("Android demo verification timed out")); });
                output.compareAndSet(null, failure("Android demo verification timed out"));
            }
            writeResult(name, output.get() == null ? failure("Android verifier returned no result") : output.get());
        } catch (Exception error) { writeResult(name, failure("Android demo verification failed: " + error.getClass().getSimpleName())); }
    }

    private static JSONObject failure(String message) {
        try { return new JSONObject().put("ok", false).put("consoleErrors", new JSONArray()).put("pageErrors", new JSONArray().put(message)).put("failedRequests", new JSONArray()); }
        catch (JSONException impossible) { throw new IllegalStateException(impossible); }
    }

    private void writeResult(String name, JSONObject result) {
        File request = new File(directory, name);
        // Caller timed out/cancelled: do not recreate an abandoned response.
        if (!request.isFile()) return;
        String response = name.replace(".request", ".response");
        File temp = new File(directory, response + ".tmp");
        try {
            Files.write(temp.toPath(), result.toString().getBytes(StandardCharsets.UTF_8));
            Files.move(temp.toPath(), new File(directory, response).toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (IOException ignored) { temp.delete(); }
    }

    private final class Run {
        private final String document;
        private final int settle;
        private final AtomicReference<JSONObject> result;
        private final CountDownLatch done;
        private final List<String> nativeErrors = Collections.synchronizedList(new ArrayList<>());
        private final List<String> blockedRequests = Collections.synchronizedList(new ArrayList<>());
        private WebView view;
        private VirtualDisplay display;
        private ImageReader frames;
        private Presentation presentation;
        private boolean finished, probing;
        private long loadedAt;
        private final Runnable tick = this::poll;
        private final Runnable timeout = () -> {
            // A stuck demo must not poison later jobs. The renderer process
            // belongs to this separate verifier profile, never the app window.
            if (Build.VERSION.SDK_INT >= 29 && view != null && view.getWebViewRenderProcess() != null) view.getWebViewRenderProcess().terminate();
            finish(failure("Android demo verification timed out"));
        };

        Run(String document, int settle, AtomicReference<JSONObject> result, CountDownLatch done) { this.document = document; this.settle = settle; this.result = result; this.done = done; }
        void start() {
            try {
                // A real private render surface keeps animation frames running
                // while the app's phone window is closed. It never mirrors or
                // captures the user's display and needs no overlay permission.
                frames = ImageReader.newInstance(412, 800, PixelFormat.RGBA_8888, 2);
                frames.setOnImageAvailableListener(reader -> { try (Image frame = reader.acquireLatestImage()) { } }, main);
                display = getSystemService(DisplayManager.class).createVirtualDisplay("LearnHarness demo verification", 412, 800, 160, frames.getSurface(), DisplayManager.VIRTUAL_DISPLAY_FLAG_OWN_CONTENT_ONLY | DisplayManager.VIRTUAL_DISPLAY_FLAG_PRESENTATION);
                if (display == null) throw new IOException("No private render surface");
                presentation = new Presentation(DemoRendererService.this, display.getDisplay());
                presentation.getWindow().addFlags(WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED);
                view = new WebView(presentation.getContext());
                WebSettings settings = view.getSettings();
                settings.setJavaScriptEnabled(true);
                settings.setDomStorageEnabled(false);
                settings.setAllowFileAccess(false); settings.setAllowContentAccess(false);
                settings.setAllowFileAccessFromFileURLs(false); settings.setAllowUniversalAccessFromFileURLs(false);
                settings.setBlockNetworkLoads(true); settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
                settings.setCacheMode(WebSettings.LOAD_NO_CACHE); settings.setMediaPlaybackRequiresUserGesture(true);
                settings.setSupportMultipleWindows(false); settings.setJavaScriptCanOpenWindowsAutomatically(false);
                CookieManager.getInstance().setAcceptThirdPartyCookies(view, false);
                view.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
                view.setWebChromeClient(new WebChromeClient() {
                    @Override public boolean onConsoleMessage(ConsoleMessage message) { if (message.messageLevel() == ConsoleMessage.MessageLevel.ERROR) add(nativeErrors, message.message()); return true; }
                    @Override public void onPermissionRequest(PermissionRequest request) { request.deny(); }
                    @Override public void onGeolocationPermissionsShowPrompt(String origin, GeolocationPermissions.Callback callback) { callback.invoke(origin, false, false); }
                    @Override public boolean onJsAlert(WebView v, String url, String message, JsResult r) { add(nativeErrors, "Demo opened an alert dialog"); r.cancel(); return true; }
                    @Override public boolean onJsConfirm(WebView v, String url, String message, JsResult r) { add(nativeErrors, "Demo opened a confirmation dialog"); r.cancel(); return true; }
                    @Override public boolean onJsPrompt(WebView v, String url, String message, String defaultValue, JsPromptResult r) { add(nativeErrors, "Demo opened a prompt dialog"); r.cancel(); return true; }
                });
                view.setWebViewClient(new WebViewClient() {
                    @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) { add(blockedRequests, "Navigation blocked: " + request.getUrl().getScheme()); return true; }
                    @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest request) {
                        // WebView asks for the synthetic host's favicon itself;
                        // it is not a dependency requested by the demo.
                        if ("https://learnharness-verifier.invalid/favicon.ico".equals(request.getUrl().toString())) return new WebResourceResponse("image/svg+xml", "UTF-8", new ByteArrayInputStream("<svg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/>".getBytes(StandardCharsets.UTF_8)));
                        String scheme = request.getUrl().getScheme();
                        if ("data".equals(scheme) || "blob".equals(scheme) || "about".equals(scheme)) return null;
                        add(blockedRequests, "Offline verifier blocked: " + request.getUrl().getScheme() + "://" + request.getUrl().getHost() + request.getUrl().getPath());
                        return new WebResourceResponse("text/plain", "UTF-8", 403, "Offline verifier", Collections.emptyMap(), new ByteArrayInputStream(new byte[0]));
                    }
                    @Override public void onReceivedError(WebView v, WebResourceRequest request, WebResourceError error) { add(blockedRequests, "Resource failed: " + error.getDescription()); }
                    @Override public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail detail) { finish(failure("Android System WebView stopped during demo verification")); return true; }
                });
                view.setDownloadListener((url, agent, disposition, mime, length) -> add(blockedRequests, "Downloads are not available in demos"));
                presentation.setContentView(view); presentation.show();
                presentation.getWindow().setLayout(412, 800);
                view.measure(View.MeasureSpec.makeMeasureSpec(412, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(800, View.MeasureSpec.EXACTLY)); view.layout(0, 0, 412, 800);
                view.onResume();
                view.loadDataWithBaseURL("https://learnharness-verifier.invalid/", document, "text/html", "UTF-8", null);
                main.postDelayed(timeout, 25_000); main.postDelayed(tick, 100);
            } catch (Throwable error) { finish(failure("Android System WebView could not start: " + error.getClass().getSimpleName())); }
        }

        void poll() {
            if (finished) return;
            view.evaluateJavascript("JSON.stringify({loaded:window.__lhLoaded===true,result:window.__lhResult||null})", value -> {
                if (finished) return;
                try {
                    Object decoded = new JSONTokener(value).nextValue();
                    if (decoded instanceof String) {
                        JSONObject state = new JSONObject((String) decoded);
                        if (state.optBoolean("loaded") && loadedAt == 0) loadedAt = SystemClock.elapsedRealtime();
                        if (!probing && loadedAt > 0 && SystemClock.elapsedRealtime() - loadedAt >= settle) {
                            probing = true; view.evaluateJavascript("window.__lhStartProbe()", null);
                        }
                        JSONObject output = state.optJSONObject("result");
                        if (output != null) {
                            JSONArray errors = output.optJSONArray("consoleErrors"), requests = output.optJSONArray("failedRequests");
                            if (errors == null || requests == null || output.optJSONArray("pageErrors") == null) throw new JSONException("Malformed verifier result");
                            synchronized (nativeErrors) { for (String error : nativeErrors) errors.put(error); }
                            synchronized (blockedRequests) { for (String error : blockedRequests) requests.put(error); }
                            output.put("ok", errors.length() == 0 && requests.length() == 0 && output.getJSONArray("pageErrors").length() == 0);
                            finish(output); return;
                        }
                    }
                } catch (Exception error) { finish(failure("Android verifier returned an invalid result")); return; }
                main.postDelayed(tick, 100);
            });
        }

        void finish(JSONObject output) {
            if (finished) return;
            finished = true; main.removeCallbacks(tick); main.removeCallbacks(timeout);
            if (view != null) { view.stopLoading(); view.destroy(); view = null; }
            if (presentation != null) { presentation.dismiss(); presentation = null; }
            if (display != null) { display.release(); display = null; }
            if (frames != null) { frames.close(); frames = null; }
            if (active == this) active = null;
            result.compareAndSet(null, output); done.countDown();
        }
        private void add(List<String> list, String value) { synchronized (list) { if (list.size() < 32) list.add(value.substring(0, Math.min(value.length(), 1000))); } }
    }

    @Override public IBinder onBind(Intent intent) { return new Binder(); }
    @Override public void onDestroy() {
        closed = true; if (observer != null) observer.stopWatching();
        if (active != null) active.finish(failure("Android verifier stopped"));
        worker.shutdownNow(); main.removeCallbacksAndMessages(null); super.onDestroy();
    }
}
