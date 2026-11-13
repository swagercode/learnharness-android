package ar.com.learnharness;

import android.app.*;
import android.Manifest;
import android.content.*;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.*;
import android.view.*;
import android.webkit.*;
import android.webkit.CookieManager;
import android.widget.*;
import android.database.Cursor;
import android.provider.OpenableColumns;
import java.io.*;
import java.net.*;
import java.util.*;

public final class MainActivity extends Activity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final List<WebView> popups = new ArrayList<>();
    private WebView web;
    private StartupView loading;
    private ValueCallback<Uri[]> fileCallback;
    private PermissionRequest microphoneRequest;
    private boolean microphonePermissionInFlight;
    private boolean opened, destroyed;
    private long pageGeneration;
    private long started;
    private static final int FILE_PICKER = 10;
    private static final int MICROPHONE_PERMISSION = 11;
    private static final int SAVE_EXPORT = 12;
    private static final int NOTIFICATION_PERMISSION = 13;
    private String pendingChat;
    private File exportFile;
    private boolean exportBusy;

    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        readSessionIntent(getIntent());
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(StartupView.BACKGROUND);
        getWindow().setStatusBarColor(StartupView.BACKGROUND);
        getWindow().setNavigationBarColor(StartupView.BACKGROUND);
        getWindow().getDecorView().setSystemUiVisibility(0);
        setContentView(root);
        if (Build.VERSION.SDK_INT >= 30) {
            getWindow().setDecorFitsSystemWindows(false);
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets safe = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime() | WindowInsets.Type.displayCutout());
                view.setPadding(safe.left, safe.top, safe.right, safe.bottom);
                return insets;
            });
        } else root.setFitsSystemWindows(true);
        web = new WebView(this);
        configure(web);
        web.setVisibility(View.INVISIBLE);
        root.addView(web, new FrameLayout.LayoutParams(-1, -1));
        loading = new StartupView(this);
        root.addView(loading, new FrameLayout.LayoutParams(-1, -1));
        web.setWebViewClient(client(false));
        web.setDownloadListener((url, agent, disposition, mime, length) -> prepareExport(url));
        web.setWebChromeClient(new WebChromeClient() {
            @Override public void onPermissionRequest(PermissionRequest request) {
                // Grant only this app's local page, and only audio capture. Never
                // forward a web request's entire resource array to grant().
                if (!mayRecord(request) || microphonePermissionInFlight) { request.deny(); return; }
                if (checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
                    return;
                }
                microphoneRequest = request;
                microphonePermissionInFlight = true;
                requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, MICROPHONE_PERMISSION);
            }
            @Override public void onPermissionRequestCanceled(PermissionRequest request) {
                if (microphoneRequest == request) microphoneRequest = null;
                // Keep the OS request in flight until its callback arrives, so
                // a canceled request cannot accidentally grant a later one.
            }
            @Override public boolean onCreateWindow(WebView source, boolean dialog, boolean gesture, Message result) {
                if (!gesture || popups.size() >= 3) return false;
                WebView popup = new WebView(MainActivity.this); configure(popup); popup.setWebViewClient(client(true));
                popup.setWebChromeClient(new WebChromeClient() {
                    @Override public void onCloseWindow(WebView window) { closePopup(window); }
                });
                popups.add(popup);
                ((WebView.WebViewTransport) result.obj).setWebView(popup); result.sendToTarget();
                return true;
            }
            @Override public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
                String[] types = FilePickerTypes.fromAcceptTypes(params.getAcceptTypes(),
                    extension -> MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension));
                if (types.length > 0) intent.putExtra(Intent.EXTRA_MIME_TYPES, types);
                intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE);
                try { startActivityForResult(intent, FILE_PICKER); }
                catch (ActivityNotFoundException error) { callback.onReceiveValue(null); fileCallback = null; Toast.makeText(MainActivity.this, "No file picker is available", Toast.LENGTH_LONG).show(); }
                return true;
            }
        });
        started = System.currentTimeMillis();
        poll();
    }

    @Override protected void onResume() {
        super.onResume();
        RuntimeService.setVisible(true);
        startForegroundService(new Intent(this, RuntimeService.class));
    }

    @Override protected void onPause() {
        RuntimeService.setVisible(false);
        super.onPause();
    }

    @Override protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent); setIntent(intent); readSessionIntent(intent);
        if (opened && pendingChat != null && RuntimeService.origin != null) openSession();
    }

    private void readSessionIntent(Intent intent) {
        String id = intent == null ? null : intent.getStringExtra(BackgroundMonitor.CHAT_EXTRA);
        if (id != null && id.matches("[A-Za-z0-9_-]+")) {
            pendingChat = id;
            getSystemService(NotificationManager.class).cancel(id, 2);
        }
    }

    private void openSession() {
        String path = pendingChat == null ? "" : "/chat/" + pendingChat;
        pendingChat = null;
        web.loadUrl(RuntimeService.origin + path);
    }

    private void requestNotifications() {
        if (Build.VERSION.SDK_INT < 33 || checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return;
        android.content.SharedPreferences preferences = getSharedPreferences("notifications", MODE_PRIVATE);
        if (preferences.getBoolean("asked", false) || microphonePermissionInFlight || isFinishing()) return;
        preferences.edit().putBoolean("asked", true).apply();
        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION);
    }

    @SuppressWarnings("SetJavaScriptEnabled")
    private void configure(WebView view) {
        // Chromium can briefly draw its background before a page/compositor
        // frame is available, including when returning from another app.
        view.setBackgroundColor(StartupView.BACKGROUND);
        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setSupportMultipleWindows(true); settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString() + " LearnHarnessAndroid/1");
        settings.setLoadWithOverviewMode(true); settings.setUseWideViewPort(true);
        settings.setMediaPlaybackRequiresUserGesture(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false);
        if (BuildConfig.DEBUG) WebView.setWebContentsDebuggingEnabled(true);
    }

    private boolean local(String url) {
        try { URI value = new URI(url), origin = new URI(RuntimeService.origin); return value.getRawUserInfo() == null && value.getScheme().equals(origin.getScheme()) && value.getHost().equals(origin.getHost()) && value.getPort() == origin.getPort(); }
        catch (Exception ignored) { return false; }
    }

    private boolean mayRecord(PermissionRequest request) {
        String[] resources = request.getResources();
        return !destroyed && local(request.getOrigin().toString()) && web != null && local(web.getUrl())
            && resources.length == 1 && PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resources[0]);
    }

    private void cancelMicrophoneRequest() {
        PermissionRequest request = microphoneRequest;
        microphoneRequest = null;
        if (request != null) request.deny();
    }

    @Override public void onRequestPermissionsResult(int code, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(code, permissions, results);
        if (code != MICROPHONE_PERMISSION) return;
        microphonePermissionInFlight = false;
        PermissionRequest request = microphoneRequest;
        microphoneRequest = null;
        if (request == null) return;
        if (mayRecord(request) && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED)
            request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});
        else request.deny();
    }

    private WebViewClient client(boolean popup) {
        return new WebViewClient() {
            @Override public void onPageStarted(WebView view, String url, android.graphics.Bitmap icon) {
                if (!popup) { pageGeneration++; cancelMicrophoneRequest(); }
            }
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                String url = request.getUrl().toString();
                if (url.equals("learnharness://notifications") && request.isForMainFrame() && request.hasGesture() && local(view.getUrl())) {
                    startActivity(new Intent(android.provider.Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(android.provider.Settings.EXTRA_APP_PACKAGE, getPackageName()));
                    return true;
                }
                if (url.equals("learnharness://app-settings") && request.isForMainFrame() && request.hasGesture() && local(view.getUrl())) {
                    startActivity(new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + getPackageName())));
                    return true;
                }
                if (url.equals("about:blank")) return false;
                if (local(url)) {
                    if (popup && !request.getUrl().getPath().equals("/api/subscriptions/browser")) { web.loadUrl(url); closePopup(view); return true; }
                    return false;
                }
                String scheme = request.getUrl().getScheme();
                if (request.isForMainFrame() && (popup || request.hasGesture()) && ("https".equals(scheme) || "http".equals(scheme))) {
                    try { startActivity(new Intent(Intent.ACTION_VIEW, request.getUrl()).addCategory(Intent.CATEGORY_BROWSABLE)); }
                    catch (ActivityNotFoundException error) { Toast.makeText(MainActivity.this, "Install a browser to sign in", Toast.LENGTH_LONG).show(); }
                }
                if (popup) closePopup(view);
                return true;
            }
            @Override public void onPageFinished(WebView view, String url) {
                if (!popup && local(url)) {
                    RuntimeService.firstLaunch = false;
                    // Page-finished does not guarantee a painted frame. Keep
                    // the native startup surface until Chromium can draw it;
                    // ordinary app resumes retain the existing WebView/page.
                    final long generation = pageGeneration;
                    view.postVisualStateCallback(generation, new WebView.VisualStateCallback() {
                        @Override public void onComplete(long requestId) {
                            if (destroyed || requestId != pageGeneration || !local(view.getUrl())) return;
                            view.setVisibility(View.VISIBLE);
                            if (loading.getVisibility() == View.VISIBLE) {
                                loading.animate().alpha(0).setDuration(240).withEndAction(() -> loading.setVisibility(View.GONE)).start();
                            }
                        }
                    });
                    requestNotifications();
                    String message = RuntimeService.importMessage;
                    if (message != null) {
                        RuntimeService.importMessage = null;
                        new AlertDialog.Builder(MainActivity.this).setTitle("Session backup").setMessage(message).setPositiveButton("OK", null).show();
                    }
                }
            }
            @Override public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (!popup && request.isForMainFrame()) {
                    pageGeneration++; // A pending paint callback must not hide the error surface.
                    showError("LearnHarness could not open. Close the app from recent apps and reopen it. Your sessions are saved.");
                }
            }
        };
    }

    private void closePopup(WebView popup) { handler.post(() -> { if (popups.remove(popup)) popup.destroy(); }); }
    private void showError(String message) {
        web.setVisibility(View.INVISIBLE); loading.showError(message);
    }
    private void poll() {
        if (destroyed || opened) return;
        loading.setFirstLaunch(RuntimeService.firstLaunch);
        if (RuntimeService.failure != null) { showError(RuntimeService.failure); return; }
        if (System.currentTimeMillis() - started > 180000) { showError("Startup is taking too long. Close LearnHarness from recent apps and reopen it. Your sessions are saved."); return; }
        String origin = RuntimeService.origin, secret = RuntimeService.secret;
        if (origin == null || secret == null) { handler.postDelayed(this::poll, 400); return; }
        new Thread(() -> {
            boolean ready = false;
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(origin + "/api/subscriptions").openConnection();
                connection.setConnectTimeout(1500); connection.setReadTimeout(2000);
                connection.setRequestProperty("Cookie", "lh_android=" + secret);
                connection.setRequestProperty("x-learnharness-subscriptions", "1");
                ready = connection.getResponseCode() == 200;
            } catch (Exception ignored) { } finally { if (connection != null) connection.disconnect(); }
            final boolean result = ready;
            handler.post(() -> {
                if (destroyed) return;
                if (!result) { handler.postDelayed(this::poll, 500); return; }
                opened = true;
                CookieManager cookies = CookieManager.getInstance(); cookies.setAcceptCookie(true);
                cookies.setCookie(origin, "lh_android=" + secret + "; Path=/; HttpOnly; SameSite=Strict", success -> {
                    if (!destroyed && success) { cookies.flush(); openSession(); }
                    else if (!destroyed) showError("Could not open the app's private connection. Please reopen LearnHarness.");
                });
            });
        }, "LearnHarnessReady").start();
    }

    @Override public void onBackPressed() {
        if (web == null || !local(web.getUrl())) { navigateBack(); return; }
        // The sandboxed demo cannot reach this control; it belongs to the app.
        web.evaluateJavascript("(()=>{const exit=document.querySelector('[data-testid=demo-fullscreen-close]');if(!exit)return false;exit.click();return true;})()",
            handled -> { if (!destroyed && !"true".equals(handled)) navigateBack(); });
    }
    private void navigateBack() { if (web != null && web.canGoBack()) web.goBack(); else super.onBackPressed(); }
    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (request == SAVE_EXPORT) {
            File ready = exportFile; exportFile = null;
            if (ready == null) { exportBusy = false; return; }
            if (result != RESULT_OK || data == null || data.getData() == null) { ready.delete(); exportBusy = false; return; }
            Uri destination = data.getData();
            new Thread(() -> {
                String failure = null;
                try (InputStream in = new FileInputStream(ready); OutputStream out = getContentResolver().openOutputStream(destination, "wt")) {
                    if (out == null) throw new IOException("Cannot write to the selected file.");
                    byte[] buffer = new byte[32768]; int n;
                    while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
                    out.flush();
                } catch (Exception error) { failure = "Could not save the export. Please choose a writable location and try again."; }
                finally { ready.delete(); }
                final String message = failure;
                handler.post(() -> {
                    exportBusy = false;
                    if (destroyed) return;
                    if (message != null) showExportError(message);
                    else Toast.makeText(this, "Export saved", Toast.LENGTH_LONG).show();
                });
            }, "LearnHarnessSaveExport").start();
            return;
        }
        if (request == FILE_PICKER && fileCallback != null) {
            List<Uri> selected = new ArrayList<>();
            if (result == RESULT_OK && data != null) {
                if (data.getClipData() != null) for (int i = 0; i < data.getClipData().getItemCount(); i++) selected.add(data.getClipData().getItemAt(i).getUri());
                else if (data.getData() != null) selected.add(data.getData());
            }
            ValueCallback<Uri[]> callback = fileCallback; fileCallback = null;
            if (selected.size() == 1 && isSessionBackup(selected.get(0))) {
                callback.onReceiveValue(null);
                importBackup(selected.get(0));
            } else callback.onReceiveValue(selected.isEmpty() ? null : selected.toArray(new Uri[0]));
        }
    }

    /** Download only explicit local exports, with the private app cookie.
     * Stage before opening Save so an HTTP error never becomes a fake backup. */
    private void prepareExport(String url) {
        if (exportBusy || !local(url) || !local(web.getUrl())) return;
        String path = Uri.parse(url).getPath();
        boolean backup = "/api/backups/sessions".equals(path);
        if (!backup && (path == null || !path.matches("/api/chats/[A-Za-z0-9_-]+/markdown"))) return;
        exportBusy = true;
        AlertDialog progress = new AlertDialog.Builder(this).setTitle("Preparing export…").setMessage("Saving a copy of your sessions.").setCancelable(false).create();
        progress.show();
        new Thread(() -> {
            File staged = null;
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) new URL(url).openConnection();
                connection.setInstanceFollowRedirects(false);
                connection.setConnectTimeout(10000); connection.setReadTimeout(60000);
                connection.setRequestProperty("Cookie", "lh_android=" + RuntimeService.secret);
                if (connection.getResponseCode() != 200) {
                    String message = "Could not prepare the export. Wait for active sessions and background jobs to finish, then try again.";
                    try (InputStream error = connection.getErrorStream()) {
                        if (error != null) {
                            ByteArrayOutputStream body = new ByteArrayOutputStream();
                            byte[] chunk = new byte[1024]; int read;
                            while (body.size() < 8192 && (read = error.read(chunk, 0, Math.min(chunk.length, 8192 - body.size()))) != -1) body.write(chunk, 0, read);
                            message = new org.json.JSONObject(body.toString("UTF-8")).optString("error", message);
                        }
                    } catch (Exception ignored) { }
                    throw new IOException(message);
                }
                String type = connection.getContentType();
                if (type == null || !(backup ? type.startsWith("application/zip") : type.startsWith("text/markdown"))) throw new IOException("The server did not return a valid export.");
                String filename = URLUtil.guessFileName(url, connection.getHeaderField("Content-Disposition"), backup ? "application/zip" : "text/markdown")
                    .replaceAll("[^A-Za-z0-9._-]", "_");
                if (filename.length() > 160) filename = backup ? "LearnHarness.lhbackup.zip" : "session.md";
                staged = File.createTempFile("lh-export-", ".tmp", getCacheDir());
                try (InputStream in = connection.getInputStream(); FileOutputStream out = new FileOutputStream(staged)) {
                    long size = 0; byte[] buffer = new byte[32768]; int n;
                    while ((n = in.read(buffer)) != -1) {
                        size += n;
                        if (size > 300L * 1024 * 1024) throw new IOException("The export is too large.");
                        out.write(buffer, 0, n);
                    }
                    out.getFD().sync();
                }
                final File ready = staged;
                final String name = filename;
                handler.post(() -> {
                    progress.dismiss();
                    if (destroyed) { ready.delete(); exportBusy = false; return; }
                    exportFile = ready;
                    Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
                        .setType(backup ? "application/zip" : "text/markdown").putExtra(Intent.EXTRA_TITLE, name);
                    try { startActivityForResult(save, SAVE_EXPORT); }
                    catch (ActivityNotFoundException error) { ready.delete(); exportFile = null; exportBusy = false; showExportError("No file-saving app is available."); }
                });
            } catch (Exception error) {
                if (staged != null) staged.delete();
                handler.post(() -> { exportBusy = false; if (!destroyed) { progress.dismiss(); showExportError(error.getMessage()); } });
            } finally { if (connection != null) connection.disconnect(); }
        }, "LearnHarnessExport").start();
    }

    private void showExportError(String message) {
        new AlertDialog.Builder(this).setTitle("Export was not saved").setMessage(message).setPositiveButton("OK", null).show();
    }

    private boolean isSessionBackup(Uri uri) {
        try (Cursor cursor = getContentResolver().query(uri, new String[]{OpenableColumns.DISPLAY_NAME}, null, null, null)) {
            return cursor != null && cursor.moveToFirst() && cursor.getString(0).toLowerCase(Locale.ROOT).endsWith(".lhbackup.zip");
        } catch (Exception ignored) { return false; }
    }

    private void importBackup(Uri uri) {
        AlertDialog progress = new AlertDialog.Builder(this).setTitle("Checking session backup…").setMessage("Checking the saved sessions before importing.").setCancelable(false).create();
        progress.show();
        File privateDir = new File(getNoBackupFilesDir(), "learnharness");
        new Thread(() -> {
            try {
                BackupImporter.Prepared prepared;
                try (InputStream in = getContentResolver().openInputStream(uri)) {
                    if (in == null) throw new IOException("Cannot open the selected backup");
                    prepared = BackupImporter.prepare(in, privateDir);
                }
                handler.post(() -> {
                    if (destroyed) { prepared.discard(); return; }
                    progress.dismiss();
                    new AlertDialog.Builder(this).setTitle("Import " + prepared.sessions + " saved sessions?")
                        .setMessage("This backup also includes " + prepared.jobs + " saved research results. Existing phone sessions and sign-in are kept. Model preferences are copied only if the phone has none.\n\nLearnHarness will close. Reopen it to finish importing.")
                        .setNegativeButton("Cancel", (dialog, which) -> prepared.discard())
                        .setOnCancelListener(dialog -> prepared.discard())
                        .setPositiveButton("Import & close", (dialog, which) -> {
                            try {
                                BackupImporter.queue(prepared, privateDir);
                                finishAndRemoveTask();
                                android.os.Process.killProcess(android.os.Process.myPid());
                            } catch (IOException error) { prepared.discard(); showBackupError(error.getMessage()); }
                        }).show();
                });
            } catch (Exception error) {
                handler.post(() -> { if (!destroyed) { progress.dismiss(); showBackupError(error.getMessage()); } });
            }
        }, "LearnHarnessBackup").start();
    }

    private void showBackupError(String message) {
        new AlertDialog.Builder(this).setTitle("Backup was not imported").setMessage(message).setPositiveButton("OK", null).show();
    }
    @Override protected void onDestroy() {
        destroyed = true; handler.removeCallbacksAndMessages(null);
        cancelMicrophoneRequest();
        if (fileCallback != null) fileCallback.onReceiveValue(null);
        if (exportFile != null) exportFile.delete();
        for (WebView popup : popups) popup.destroy(); popups.clear();
        if (web != null) web.destroy();
        super.onDestroy();
    }
}
