package ar.com.learnharness.tests;

import android.app.*;
import android.content.*;
import android.os.*;
import android.service.notification.StatusBarNotification;
import android.webkit.*;
import java.io.*;
import java.lang.reflect.*;
import java.util.*;
import java.util.concurrent.atomic.*;
import org.json.*;

/** Same-signer checks: real runtime/SSE, then deterministic native lifecycle
 * fixtures. No model calls, credentials, or saved session writes. */
public final class BackgroundChecks extends Instrumentation {
    private int checks;
    private boolean denied;
    private Class<?> runtime, monitorClass;
    private Object service, monitor;
    private NotificationManager notifications;
    private static final String CHAT = "chat_background_checks";
    private void check(boolean okay, String name) { if (!okay) throw new AssertionError(name); checks++; Bundle out = new Bundle(); out.putString("check", name); sendStatus(0, out); }
    private Object field(Class<?> cls, Object owner, String name) throws Exception { Field f = cls.getDeclaredField(name); f.setAccessible(true); return f.get(owner); }
    private void set(Class<?> cls, Object owner, String name, Object value) throws Exception { Field f = cls.getDeclaredField(name); f.setAccessible(true); f.set(owner, value); }
    private Object call(Class<?> cls, Object owner, String name, Class<?>[] types, Object... args) throws Exception { Method m = cls.getDeclaredMethod(name, types); m.setAccessible(true); return m.invoke(owner, args); }
    private void main(Runnable runnable) { runOnMainSync(runnable); }
    private void reflectMain(RunnableThrowing runnable) { AtomicReference<Throwable> error = new AtomicReference<>(); main(() -> { try { runnable.run(); } catch (Throwable e) { error.set(e); } }); if (error.get() != null) throw new AssertionError(error.get()); }
    private interface RunnableThrowing { void run() throws Exception; }
    private JSONObject snapshot(boolean busy, String ready, String error) throws Exception { return new JSONObject().put("busy", busy).put("sessions", new JSONArray().put(new JSONObject().put("id", CHAT).put("title", "Background check").put("busy", busy).put("readyVersion", ready).put("errorVersion", error))); }
    private void accept(boolean busy, String ready, String error) throws Exception { JSONObject state = snapshot(busy, ready, error); reflectMain(() -> call(monitorClass, monitor, "accept", new Class[]{JSONObject.class}, state)); }
    private void visible(boolean value) { reflectMain(() -> call(runtime, null, "setVisible", new Class[]{boolean.class}, value)); }
    private StatusBarNotification alert() { for (StatusBarNotification n : notifications.getActiveNotifications()) if (CHAT.equals(n.getTag())) return n; return null; }
    @Override public void onCreate(Bundle args) { super.onCreate(args); denied = args.getBoolean("denied") || "true".equals(args.getString("denied")); start(); }
    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            runtime = Class.forName("ar.com.learnharness.RuntimeService"); monitorClass = Class.forName("ar.com.learnharness.BackgroundMonitor");
            notifications = getTargetContext().getSystemService(NotificationManager.class);
            if (denied) getTargetContext().getSharedPreferences("notifications", Context.MODE_PRIVATE).edit().putBoolean("asked", true).commit();
            Activity activity = startActivitySync(new Intent(Intent.ACTION_MAIN).setClassName("ar.com.learnharness", "ar.com.learnharness.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            long deadline = SystemClock.uptimeMillis() + 150_000;
            while (SystemClock.uptimeMillis() < deadline) {
                service = field(runtime, null, "current");
                if (service != null) { monitor = field(runtime, service, "monitor"); if (monitor != null && field(monitorClass, monitor, "latest") != null) break; }
                Thread.sleep(300);
            }
            check(monitor != null && field(monitorClass, monitor, "latest") != null, "Native monitor receives authenticated live server state");
            check(notifications.areNotificationsEnabled() != denied, "Android notification permission matches the test case");
            reflectMain(() -> {
                call(monitorClass, monitor, "close", new Class[]{});
                ((Map<?, ?>) field(monitorClass, null, "settled")).clear(); set(monitorClass, null, "initialized", false);
                Constructor<?> constructor = monitorClass.getDeclaredConstructor(runtime); constructor.setAccessible(true); monitor = constructor.newInstance(service);
                set(runtime, service, "monitor", monitor);
            });
            notifications.cancel(CHAT, 2);
            visible(false); accept(false, "imported", ""); Thread.sleep(2200);
            check(alert() == null, "Old/imported sessions do not alert");
            if (denied) {
                accept(true, "imported", ""); accept(false, "finished-without-permission", ""); Thread.sleep(2300);
                check(alert() == null, "Denied notifications do not crash or post an alert");
                check(field(runtime, null, "failure") == null, "Runtime remains usable after notification denial");
                result.putString("result", "PASS: " + checks + " notification-denial checks"); finish(Activity.RESULT_OK, result); return;
            }
            visible(true); accept(false, "foreground", ""); Thread.sleep(2200);
            check(alert() == null, "Reading the foreground app stays quiet");
            accept(true, "foreground", "");
            PowerManager.WakeLock wake = (PowerManager.WakeLock) field(monitorClass, monitor, "wake");
            check(wake.isHeld(), "Active work holds a bounded CPU wake lock");
            main(activity::finishAndRemoveTask); Thread.sleep(1000);
            check(field(runtime, null, "current") == service, "Swiping away the activity does not stop its service or engine");
            visible(false); accept(false, "research", ""); Thread.sleep(500); accept(true, "research", ""); Thread.sleep(2200);
            check(alert() == null, "Research handoff waits for the still-running teaching turn");
            accept(false, "complete", ""); Thread.sleep(2300);
            StatusBarNotification ready = alert();
            check(ready != null && "Your session is ready".contentEquals(ready.getNotification().extras.getCharSequence(Notification.EXTRA_TITLE)), "Background completion posts a ready alert");
            check(!wake.isHeld(), "Completed work releases its CPU wake lock");
            long posted = ready.getPostTime(); accept(false, "complete", ""); Thread.sleep(2300);
            check(alert().getPostTime() == posted, "Reconnect or repeated state never posts a duplicate");
            notifications.cancel(CHAT, 2); accept(true, "complete", ""); accept(false, "complete", "failure"); Thread.sleep(2300);
            check("Session needs attention".contentEquals(alert().getNotification().extras.getCharSequence(Notification.EXTRA_TITLE)), "Failed work is not reported as ready");
            notifications.cancel(CHAT, 2); accept(true, "complete", "failure"); accept(false, "complete", "failure"); Thread.sleep(2300);
            check(alert() == null, "Cancellation without new output remains quiet");
            Activity reopened = startActivitySync(new Intent(Intent.ACTION_MAIN).setClassName("ar.com.learnharness", "ar.com.learnharness.MainActivity").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
            WebView web = (WebView) field(reopened.getClass(), reopened, "web");
            // Keep the navigation check free of AI calls: render a static local
            // response after Java has validated/routed the real PendingIntent.
            main(() -> web.setWebViewClient(new WebViewClient() {
                @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) { return new WebResourceResponse("text/html", "UTF-8", new ByteArrayInputStream("<html>Session destination</html>".getBytes())); }
            }));
            reflectMain(() -> set(reopened.getClass(), reopened, "opened", true));
            visible(false); accept(false, "next-complete", "failure"); Thread.sleep(2300);
            check(alert() != null, "Another completed response can notify again");
            alert().getNotification().contentIntent.send(); Thread.sleep(1500);
            AtomicReference<String> url = new AtomicReference<>(); main(() -> url.set(web.getUrl()));
            check(url.get() != null && url.get().endsWith("/chat/" + CHAT), "Tapping notification opens exactly its session");
            check(alert() == null, "Opening the session clears its ready alert");
            main(reopened::finishAndRemoveTask); visible(false); accept(false, "next-complete", "failure");
            Thread.sleep(31_000);
            check(field(runtime, null, "current") == null && !wake.isHeld(), "Idle background service stops and releases resources");
            result.putString("result", "PASS: " + checks + " native background/notification checks"); finish(Activity.RESULT_OK, result);
        } catch (Throwable error) { result.putString("error", error.toString()); finish(Activity.RESULT_CANCELED, result); }
    }
}
