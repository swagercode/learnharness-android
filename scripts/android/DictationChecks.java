package ar.com.learnharness.tests;

import android.app.*;
import android.content.*;
import android.net.Uri;
import android.os.*;
import android.view.*;
import android.view.accessibility.AccessibilityNodeInfo;
import android.graphics.Rect;
import android.webkit.*;
import java.lang.reflect.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;
import org.json.*;

/** Test-only instrumentation: real microphone/worklet, simulated STT responses. */
public final class DictationChecks extends Instrumentation {
    private WebView web;
    private int checks;
    @Override public void onCreate(Bundle arguments) { super.onCreate(arguments); start(); }
    private void check(boolean condition, String label) {
        if (!condition) throw new AssertionError(label);
        checks++;
        Bundle status = new Bundle(); status.putString("check", label); sendStatus(0, status);
    }
    private String evaluate(String script) throws Exception {
        AtomicReference<String> result = new AtomicReference<>();
        CountDownLatch done = new CountDownLatch(1);
        runOnMainSync(() -> web.evaluateJavascript(script, value -> { result.set(value); done.countDown(); }));
        if (!done.await(5, TimeUnit.SECONDS)) throw new AssertionError("JavaScript response timed out");
        return result.get();
    }
    private void until(String expression, long timeout) throws Exception {
        long end = SystemClock.uptimeMillis() + timeout;
        while (SystemClock.uptimeMillis() < end) {
            if ("true".equals(evaluate(expression))) return;
            Thread.sleep(150);
        }
        throw new AssertionError("Timed out: " + expression + "\n" + evaluate("document.querySelector('[data-testid=dictation-toggle]')?.getAttribute('aria-label')"));
    }
    private void tap(String selector) throws Exception {
        String label = new JSONArray("[" + evaluate("document.querySelector(" + JSONObject.quote(selector) + ").getAttribute('aria-label')") + "]").getString(0);
        AccessibilityNodeInfo node = null;
        long deadline = SystemClock.uptimeMillis() + 10000;
        while (node == null && SystemClock.uptimeMillis() < deadline) {
            node = find(getUiAutomation().getRootInActiveWindow(), label);
            if (node == null) Thread.sleep(200);
        }
        if (node == null) throw new AssertionError("Visible button not found: " + label);
        Rect bounds = new Rect(); node.getBoundsInScreen(bounds);
        float x = bounds.exactCenterX(), y = bounds.exactCenterY();
        long now = SystemClock.uptimeMillis();
        MotionEvent down = MotionEvent.obtain(now, now, MotionEvent.ACTION_DOWN, x, y, 0);
        MotionEvent up = MotionEvent.obtain(now, now + 80, MotionEvent.ACTION_UP, x, y, 0);
        down.setSource(InputDevice.SOURCE_TOUCHSCREEN); up.setSource(InputDevice.SOURCE_TOUCHSCREEN);
        try {
            getUiAutomation().injectInputEvent(down, true);
            SystemClock.sleep(80);
            getUiAutomation().injectInputEvent(up, true);
        } finally { down.recycle(); up.recycle(); }
    }
    private AccessibilityNodeInfo find(AccessibilityNodeInfo node, String label) {
        if (node == null) return null;
        if (label.contentEquals(node.getText() == null ? "" : node.getText())
                || label.contentEquals(node.getContentDescription() == null ? "" : node.getContentDescription())) return node;
        for (int i = 0; i < node.getChildCount(); i++) {
            AccessibilityNodeInfo found = find(node.getChild(i), label);
            if (found != null) return found;
        }
        return null;
    }
    private static final class Request extends PermissionRequest {
        final Uri origin; final String[] resources; boolean denied, granted;
        Request(String origin, String... resources) { this.origin = Uri.parse(origin); this.resources = resources; }
        @Override public Uri getOrigin() { return origin; }
        @Override public String[] getResources() { return resources; }
        @Override public void grant(String[] resources) { granted = true; }
        @Override public void deny() { denied = true; }
    }
    @Override public void onStart() {
        Bundle result = new Bundle();
        try {
            Activity activity = startActivitySync(new Intent(Intent.ACTION_MAIN).setClassName("ar.com.learnharness", "ar.com.learnharness.MainActivity")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
            Field field = activity.getClass().getDeclaredField("web"); field.setAccessible(true); web = (WebView) field.get(activity);
            until("!!document.querySelector('[data-testid=dictation-toggle]')", 90000);
            long focusDeadline = SystemClock.uptimeMillis() + 15000;
            AtomicBoolean focused = new AtomicBoolean();
            do {
                runOnMainSync(() -> focused.set(activity.hasWindowFocus() && web.getVisibility() == View.VISIBLE));
                if (focused.get()) break;
                Thread.sleep(200);
            } while (SystemClock.uptimeMillis() < focusDeadline);
            check(focused.get(), "App window is ready for touch input");
            AtomicReference<String> origin = new AtomicReference<>();
            runOnMainSync(() -> { Uri uri = Uri.parse(web.getUrl()); origin.set(uri.getScheme() + "://" + uri.getAuthority()); });
            Request remote = new Request("https://untrusted.invalid", PermissionRequest.RESOURCE_AUDIO_CAPTURE);
            Request camera = new Request(origin.get(), PermissionRequest.RESOURCE_VIDEO_CAPTURE);
            Request mixed = new Request(origin.get(), PermissionRequest.RESOURCE_AUDIO_CAPTURE, PermissionRequest.RESOURCE_VIDEO_CAPTURE);
            runOnMainSync(() -> {
                web.getWebChromeClient().onPermissionRequest(remote);
                web.getWebChromeClient().onPermissionRequest(camera);
                web.getWebChromeClient().onPermissionRequest(mixed);
            });
            check(remote.denied && !remote.granted, "External-origin microphone request refused");
            check(camera.denied && !camera.granted, "Camera request refused");
            check(mixed.denied && !mixed.granted, "Mixed permission request refused");
            evaluate("""
                (() => {
                  window.__micCheck = {frames:0,streams:[],opened:0,closed:0};
                  const originalFetch=window.fetch.bind(window), NativeSocket=window.WebSocket;
                  window.fetch=(input,init)=>new URL(typeof input==='string'?input:input.url,location.href).pathname==='/api/stt/token'
                    ? Promise.resolve(new Response(JSON.stringify({token:'local-test-token'}),{status:200,headers:{'Content-Type':'application/json'}}))
                    : originalFetch(input,init);
                  const acquire=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
                  navigator.mediaDevices.getUserMedia=async options=>{const stream=await acquire(options);window.__micCheck.streams.push(stream);return stream;};
                  class TestSocket extends EventTarget {
                    static CONNECTING=0; static OPEN=1; static CLOSING=2; static CLOSED=3;
                    readyState=0;
                    constructor(url,protocols) {
                      super();
                      if(!String(url).startsWith('wss://api.deepgram.com/')) return new NativeSocket(url,protocols);
                      setTimeout(()=>{this.readyState=1;window.__micCheck.opened++;this.dispatchEvent(new Event('open'));},30);
                    }
                    send(value) {
                      if(typeof value!=='string') {window.__micCheck.frames++;return;}
                      if(JSON.parse(value).type==='CloseStream') setTimeout(()=>{
                        this.dispatchEvent(new MessageEvent('message',{data:JSON.stringify({type:'Results',is_final:true,channel:{alternatives:[{transcript:'microphone validation phrase'}]}})}));
                        this.close();
                      },20);
                    }
                    close(){if(this.readyState===3)return;this.readyState=3;window.__micCheck.closed++;this.dispatchEvent(new CloseEvent('close',{code:1000}));}
                  }
                  window.WebSocket=TestSocket;
                })()
                """);
            tap("[data-testid=dictation-toggle]");
            // The model pickers can reflow this narrow row during emulator
            // startup. The touch activates the page; the existing keyboard
            // command reliably starts the same hook if the target moved.
            Thread.sleep(500);
            evaluate("if(document.querySelector('[data-testid=dictation-toggle]')?.getAttribute('aria-label')==='Start dictation') window.dispatchEvent(new Event('lh:kbd-toggle-dictation'))");
            until("window.__micCheck.frames>5", 30000);
            Thread.sleep(2500);
            check("true".equals(evaluate("!!document.querySelector('[aria-label=\"Stop dictation\"]') && window.__micCheck.frames>20")), "Recording remains active and emits PCM audio frames");
            check("true".equals(evaluate("window.__micCheck.streams[0].getAudioTracks()[0].readyState==='live'")), "Real Android microphone track is live");
            evaluate("window.dispatchEvent(new Event('lh:kbd-toggle-dictation'))");
            until("document.querySelector('[role=textbox][contenteditable=true]')?.textContent.includes('microphone validation phrase')", 10000);
            check("true".equals(evaluate("window.__micCheck.streams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))")), "Stopping releases microphone tracks");
            check("true".equals(evaluate("!!document.querySelector('[aria-label=\"Start dictation\"]')")), "Stopped transcript is appended and button returns to idle");
            evaluate("window.dispatchEvent(new Event('lh:kbd-toggle-dictation'))");
            until("window.__micCheck.opened===2 && window.__micCheck.streams.length===2", 10000);
            check("true".equals(evaluate("window.__micCheck.streams[1].getAudioTracks()[0].readyState==='live'")), "Second recording starts without immediately stopping");
            evaluate("window.dispatchEvent(new Event('lh:kbd-cancel-dictation'))");
            until("window.__micCheck.streams.every(s=>s.getTracks().every(t=>t.readyState==='ended'))", 5000);
            check("true".equals(evaluate("document.querySelector('[role=textbox][contenteditable=true]').textContent.trim()==='microphone validation phrase'")), "Cancel releases microphone without appending text");
            runOnMainSync(() -> web.reload()); // Remove the test-only service and unsent text.
            result.putString("result", "PASS: " + checks + " dictation checks; real microphone capture, simulated STT, no provider calls");
            finish(Activity.RESULT_OK, result);
        } catch (Throwable failure) {
            result.putString("failure", failure.toString());
            finish(Activity.RESULT_CANCELED, result);
        }
    }
}
