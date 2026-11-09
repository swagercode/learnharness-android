package ar.com.learnharness;

import android.app.*;
import android.content.*;
import android.os.*;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;

public final class RuntimeService extends Service {
    static volatile String origin, secret, failure, importMessage;
    static volatile boolean firstLaunch;
    private static boolean started;
    private static RuntimeService current;
    private BackgroundMonitor monitor;
    private boolean rendererBound;
    private final ServiceConnection rendererConnection = new ServiceConnection() {
        @Override public void onServiceConnected(ComponentName name, IBinder binder) { }
        @Override public void onServiceDisconnected(ComponentName name) { }
    };
    private static native int startNode(String script, String config, String cache);

    @Override public void onCreate() {
        super.onCreate();
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel("runtime", "Background work", NotificationManager.IMPORTANCE_LOW));
        current = this;
        startForeground(1, runtimeNotification("Starting your sessions…"));
        monitor = new BackgroundMonitor(this);
        monitor.start();
        if (Build.VERSION.SDK_INT >= 28) rendererBound = bindService(new Intent(this, DemoRendererService.class), rendererConnection, BIND_AUTO_CREATE);
        synchronized (RuntimeService.class) {
            if (started) return;
            started = true;
        }
        startRuntime();
    }

    Notification runtimeNotification(String text) {
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        return new Notification.Builder(this, "runtime")
            .setSmallIcon(ar.com.learnharness.R.drawable.ic_notification).setContentTitle("LearnHarness")
            .setContentText(text).setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true).build();
    }

    static void setVisible(boolean visible) {
        BackgroundMonitor.visible = visible;
        if (current != null && current.monitor != null) current.monitor.visibilityChanged();
    }

    private void startRuntime() {
        new Thread(() -> {
            try {
                JSONObject metadata;
                try (InputStream in = getAssets().open("bundle.json")) { ByteArrayOutputStream bytes = new ByteArrayOutputStream(); byte[] buffer = new byte[4096]; int count; while ((count = in.read(buffer)) != -1) bytes.write(buffer, 0, count); metadata = new JSONObject(bytes.toString("UTF-8")); }
                File privateDir = new File(getNoBackupFilesDir(), "learnharness");
                if (!privateDir.isDirectory() && !privateDir.mkdirs()) throw new IOException("Cannot create the app's private storage");
                File bundles = new File(privateDir, "bundles");
                firstLaunch = PayloadInstaller.isFirstLaunch(bundles);
                try { importMessage = BackupImporter.applyPending(privateDir); }
                catch (IOException error) {
                    importMessage = "Backup was not imported: " + error.getMessage();
                    new File(privateDir, "import-pending").renameTo(new File(privateDir, "import-failed-" + System.currentTimeMillis()));
                }
                File bundle = PayloadInstaller.install(getAssets().open("server.zip"), bundles, metadata.getString("sha256"));
                int port;
                try (ServerSocket socket = new ServerSocket(0, 1, InetAddress.getByName("127.0.0.1"))) { port = socket.getLocalPort(); }
                byte[] random = new byte[32]; new SecureRandom().nextBytes(random);
                StringBuilder token = new StringBuilder(); for (byte b : random) token.append(String.format("%02x", b & 255));
                secret = token.toString();
                JSONObject settings = new JSONObject().put("port", port).put("secret", secret).put("directory", privateDir.getAbsolutePath());
                if (Build.VERSION.SDK_INT >= 28) settings.put("rendererDirectory", new File(getCacheDir(), "demo-verifier").getAbsolutePath());
                File config = new File(privateDir, "launch.json");
                try (FileOutputStream out = new FileOutputStream(config)) { out.write(settings.toString().getBytes(StandardCharsets.UTF_8)); }
                System.loadLibrary("node"); System.loadLibrary("learnharness");
                origin = "http://127.0.0.1:" + port;
                int code = startNode(new File(bundle, "bootstrap.cjs").getAbsolutePath(), config.getAbsolutePath(), getCacheDir().getAbsolutePath());
                failure = "LearnHarness stopped unexpectedly (" + code + "). Close the app from recent apps and reopen it. Your sessions are saved.";
            } catch (Throwable error) {
                android.util.Log.e("LearnHarness", "Local runtime startup failed", error);
                failure = "LearnHarness could not start (" + error.getClass().getSimpleName() + "). Close the app from recent apps and reopen it. Your sessions are saved.";
            }
        }, "LearnHarnessRuntime").start();
    }
    @Override public int onStartCommand(Intent intent, int flags, int startId) { return START_NOT_STICKY; }
    @Override public IBinder onBind(Intent intent) { return null; }
    @Override public void onTaskRemoved(Intent rootIntent) { setVisible(false); }
    @Override public void onDestroy() {
        if (rendererBound) { unbindService(rendererConnection); rendererBound = false; }
        if (monitor != null) monitor.close();
        if (current == this) current = null;
        super.onDestroy();
    }
    @Override public void onTimeout(int startId, int fgsType) {
        // Android's dataSync budget is finite. Stop honestly; never silently
        // restart interrupted model calls (which could charge twice).
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager.areNotificationsEnabled()) manager.notify("timeout", 3,
            new Notification.Builder(this, BackgroundMonitor.READY_CHANNEL)
                .setSmallIcon(R.drawable.ic_notification).setContentTitle("Background work paused")
                .setContentText("Open LearnHarness to check your sessions.")
                .setContentIntent(PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT))
                .setAutoCancel(true).build());
        if (monitor != null) monitor.close();
        stopForeground(STOP_FOREGROUND_REMOVE); stopSelf();
        android.os.Process.killProcess(android.os.Process.myPid());
    }
}
