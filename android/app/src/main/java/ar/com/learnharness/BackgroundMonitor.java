package ar.com.learnharness;

import android.app.*;
import android.content.*;
import android.net.Uri;
import android.os.*;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.*;

/** Watches the local engine directly, even after the WebView is destroyed. */
final class BackgroundMonitor implements AutoCloseable {
    static final String READY_CHANNEL = "session-ready";
    static final String CHAT_EXTRA = "learnharness.chat";
    static volatile boolean visible;
    // Retained across idle Service recreation in the same Node process.
    private static final Map<String, Versions> settled = new HashMap<>();
    private static boolean initialized;
    private final RuntimeService service;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final NotificationManager notifications;
    private final PowerManager.WakeLock wake;
    private volatile boolean closed;
    private volatile HttpURLConnection connection;
    private Thread worker;
    private JSONObject latest;
    private long lastSnapshot;
    private boolean busy = true;
    private boolean idleScheduled;
    private String runtimeText = "";
    private final Runnable readyCheck = this::deliver;
    private final Runnable idleCheck = this::stopIfIdle;

    private static final class Versions {
        final String ready, error;
        Versions(JSONObject session) { ready = session.optString("readyVersion"); error = session.optString("errorVersion"); }
    }

    BackgroundMonitor(RuntimeService service) {
        this.service = service;
        notifications = service.getSystemService(NotificationManager.class);
        NotificationChannel channel = new NotificationChannel(READY_CHANNEL, "Session ready", NotificationManager.IMPORTANCE_DEFAULT);
        channel.setDescription("Responses and research ready to read, or tasks that need your attention");
        channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        notifications.createNotificationChannel(channel);
        wake = service.getSystemService(PowerManager.class).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "LearnHarness:BackgroundWork");
        wake.setReferenceCounted(false);
    }

    void start() {
        wake.acquire(120_000); // Startup only; subsequent snapshots own the lock.
        worker = new Thread(this::listen, "LearnHarnessNotifications"); worker.start();
    }

    private void listen() {
        long delay = 500;
        while (!closed) {
            try {
                if (RuntimeService.origin == null || RuntimeService.secret == null) { Thread.sleep(500); continue; }
                HttpURLConnection request = (HttpURLConnection) new URL(RuntimeService.origin + "/api/android/background").openConnection();
                connection = request;
                request.setInstanceFollowRedirects(false);
                request.setConnectTimeout(5000); request.setReadTimeout(60_000);
                request.setRequestProperty("Cookie", "lh_android=" + RuntimeService.secret);
                request.setRequestProperty("Accept", "text/event-stream");
                if (request.getResponseCode() != 200) throw new IOException("Engine not ready");
                try (BufferedReader reader = new BufferedReader(new InputStreamReader(request.getInputStream(), StandardCharsets.UTF_8))) {
                    String line;
                    while (!closed && (line = reader.readLine()) != null) {
                        if (line.length() > 1_048_576) throw new IOException("Oversized background state");
                        if (line.startsWith("data: ")) {
                            JSONObject snapshot = new JSONObject(line.substring(6));
                            delay = 500;
                            main.post(() -> accept(snapshot));
                        }
                    }
                }
            } catch (Exception ignored) {
                // A reconnect pulls authoritative state; it never repeats an AI request.
            } finally { HttpURLConnection old = connection; connection = null; if (old != null) old.disconnect(); }
            if (!closed) try { Thread.sleep(delay); delay = Math.min(delay * 2, 10_000); } catch (InterruptedException ignored) { }
        }
    }

    void accept(JSONObject snapshot) {
        if (closed || !snapshot.has("busy") || snapshot.optJSONArray("sessions") == null) return;
        latest = snapshot; lastSnapshot = SystemClock.elapsedRealtime(); busy = snapshot.optBoolean("busy", true);
        JSONArray sessions = snapshot.optJSONArray("sessions");
        if (!initialized) {
            for (int i = 0; i < sessions.length(); i++) { JSONObject s = sessions.optJSONObject(i); if (valid(s)) settled.put(s.optString("id"), new Versions(s)); }
            initialized = true; // Existing imported sessions never generate a flood of alerts.
        }
        if (busy) wake.acquire(120_000); else releaseWake();
        String text = busy ? "Working on your sessions. You can leave the app." : "Your sessions are up to date";
        if (!text.equals(runtimeText)) { runtimeText = text; notifications.notify(1, service.runtimeNotification(text)); }
        main.removeCallbacks(readyCheck); main.postDelayed(readyCheck, 2000);
        if (busy || visible) { main.removeCallbacks(idleCheck); idleScheduled = false; }
        else if (!idleScheduled) { idleScheduled = true; main.postDelayed(idleCheck, 30_000); }
    }

    private static boolean valid(JSONObject session) {
        return session != null && session.optString("id").matches("[A-Za-z0-9_-]+") && session.has("readyVersion") && session.has("errorVersion");
    }

    private void deliver() {
        if (closed || latest == null || SystemClock.elapsedRealtime() - lastSnapshot > 60_000) return;
        JSONArray sessions = latest.optJSONArray("sessions");
        Set<String> present = new HashSet<>();
        for (int i = 0; i < sessions.length(); i++) {
            JSONObject s = sessions.optJSONObject(i); if (!valid(s)) continue;
            String id = s.optString("id"); present.add(id);
            if (s.optBoolean("busy", true)) continue;
            Versions next = new Versions(s), previous = settled.get(id);
            boolean failed = !next.error.isEmpty() && (previous == null || !next.error.equals(previous.error));
            boolean ready = !next.ready.isEmpty() && (previous == null || !next.ready.equals(previous.ready));
            settled.put(id, next);
            if ((ready || failed) && !visible) notifySession(id, s.optString("title", "LearnHarness"), failed);
        }
        settled.keySet().retainAll(present);
    }

    static Intent sessionIntent(Context context, String chatId) {
        return new Intent(context, MainActivity.class)
            .setData(Uri.parse("learnharness://session/" + chatId)).putExtra(CHAT_EXTRA, chatId)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
    }

    private void notifySession(String id, String title, boolean failed) {
        if (!notifications.areNotificationsEnabled()) return;
        PendingIntent open = PendingIntent.getActivity(service, 0, sessionIntent(service, id), PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        String label = failed ? "Session needs attention" : "Your session is ready";
        Notification notification = new Notification.Builder(service, READY_CHANNEL)
            .setSmallIcon(R.drawable.ic_notification).setContentTitle(label)
            .setContentText(title.length() > 100 ? title.substring(0, 100) : title)
            .setSubText("LearnHarness").setContentIntent(open).setAutoCancel(true)
            .setCategory(failed ? Notification.CATEGORY_ERROR : Notification.CATEGORY_STATUS)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .setPublicVersion(new Notification.Builder(service, READY_CHANNEL).setSmallIcon(R.drawable.ic_notification).setContentTitle("LearnHarness").setContentText(label).build())
            .build();
        try { notifications.notify(id, 2, notification); } catch (SecurityException ignored) { }
    }

    void visibilityChanged() {
        if (closed) return;
        main.removeCallbacks(idleCheck);
        idleScheduled = false;
        if (visible) {
            // Mark already-visible completed work read before the user leaves.
            deliver();
        } else {
            // Bridge a send/start-event race while the screen is going off.
            wake.acquire(60_000);
            idleScheduled = true;
            main.postDelayed(idleCheck, 30_000);
        }
    }

    private void stopIfIdle() {
        idleScheduled = false;
        if (closed || visible || busy || latest == null || SystemClock.elapsedRealtime() - lastSnapshot > 60_000) return;
        deliver();
        service.stopForeground(Service.STOP_FOREGROUND_REMOVE);
        service.stopSelf(); // Node may be cached; no active work is sacrificed.
    }

    private void releaseWake() { if (wake.isHeld()) wake.release(); }
    @Override public void close() {
        closed = true; main.removeCallbacksAndMessages(null); releaseWake();
        HttpURLConnection old = connection; if (old != null) old.disconnect();
        if (worker != null) worker.interrupt();
    }
}
