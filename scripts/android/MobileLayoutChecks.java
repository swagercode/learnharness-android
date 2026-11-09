package ar.com.learnharness.tests;

import android.app.*;
import android.content.*;
import android.graphics.Bitmap;
import android.os.*;
import android.webkit.*;
import org.json.*;
import java.io.*;
import java.lang.reflect.*;
import java.nio.file.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/** Real phone-layout check with one synthetic unanswered question. Restores
 * settings byte-for-byte and deletes only its own fixture in finally. */
public final class MobileLayoutChecks extends Instrumentation {
    private int checks;
    private WebView web;
    private boolean artifacts;
    @Override public void onCreate(Bundle args) { super.onCreate(args); artifacts = "artifacts".equals(args.getString("phase")); start(); }
    private void check(boolean okay, String name) { if (!okay) throw new AssertionError(name); checks++; Bundle out = new Bundle(); out.putString("check", name); sendStatus(0, out); }
    private String evaluate(String script) throws Exception {
        AtomicReference<String> result = new AtomicReference<>(); CountDownLatch done = new CountDownLatch(1);
        runOnMainSync(() -> web.evaluateJavascript(script, value -> { result.set(value); done.countDown(); }));
        if (!done.await(5, TimeUnit.SECONDS)) throw new AssertionError("JavaScript timeout"); return result.get();
    }
    private void until(String expression, long timeout) throws Exception {
        long deadline = SystemClock.uptimeMillis() + timeout;
        while (SystemClock.uptimeMillis() < deadline) { if ("true".equals(evaluate(expression))) return; Thread.sleep(200); }
        throw new AssertionError("UI did not settle: " + expression);
    }
    private JSONObject geometry() throws Exception {
        String source = "JSON.stringify({problem:document.querySelector('[data-dock-scroll-area]').getBoundingClientRect().height,thinking:document.querySelector('[data-testid=thinking-field]')?.getBoundingClientRect().height||0,reading:document.querySelector('[data-testid=reading-thinking-field]')?.getBoundingClientRect().height||0,voice:!!document.querySelector('[data-testid=voice-answer-controls]')})";
        return new JSONObject((String) new JSONTokener(evaluate(source)).nextValue());
    }
    private void checkSubmitVisible(String mode) throws Exception {
        Thread.sleep(3000);
        String visible = "(()=>{const b=document.querySelector('[data-testid=question-dock] button[type=submit]');if(!b)return false;const r=b.getBoundingClientRect();if(r.width<1||r.height<1||r.top<0||r.bottom>innerHeight)return false;for(let p=b.parentElement;p;p=p.parentElement){if(/hidden|auto|scroll|clip/.test(getComputedStyle(p).overflowY)){const q=p.getBoundingClientRect();if(r.top<q.top-1||r.bottom>q.bottom+1)return false;}}return true})()";
        Bundle geometry = new Bundle();
        geometry.putString("layout", evaluate("JSON.stringify([...document.querySelectorAll('[data-dock-viewport],[data-testid=question-dock],[data-dock-scroll-area],[data-testid=question-dock] form,[data-testid=question-dock] button[type=submit]')].map(e=>({tag:e.tagName,test:e.getAttribute('data-testid'),rect:{top:e.getBoundingClientRect().top,bottom:e.getBoundingClientRect().bottom,height:e.getBoundingClientRect().height},parent:{class:e.parentElement.className,height:e.parentElement.getBoundingClientRect().height,style:e.parentElement.style.cssText},style:e.style.cssText})))"));
        sendStatus(0, geometry);
        check("true".equals(evaluate(visible)), mode + " submit button is visible without scrolling");
    }
    private void screenshot(String name) throws Exception {
        Bitmap image = getUiAutomation().takeScreenshot();
        File directory = getTargetContext().getExternalFilesDir(null);
        if (directory == null) throw new IOException("No screenshot directory");
        try (FileOutputStream out = new FileOutputStream(new File(directory, name))) { image.compress(Bitmap.CompressFormat.PNG, 100, out); }
        image.recycle();
    }
    private void bounds(String selector, String name) throws Exception {
        check("true".equals(evaluate("(()=>{const e=document.querySelector(" + JSONObject.quote(selector) + ");if(!e)return false;const r=e.getBoundingClientRect();return r.width>0&&r.height>0&&r.left>=-1&&r.right<=innerWidth+1&&r.top>=-1&&r.bottom<=innerHeight+1})()")), name);
    }
    @Override public void onStart() {
        if (artifacts) {
            Bundle out = new Bundle();
            try {
                File destination = getTargetContext().getExternalFilesDir(null);
                if (destination == null) throw new IOException("No artifact directory");
                File[] bundles = new File(getTargetContext().getNoBackupFilesDir(), "learnharness/bundles").listFiles();
                for (String name : new String[]{"question-compact.png", "question-dictation-only.png"}) {
                    boolean copied = false;
                    if (bundles != null) for (File bundle : bundles) {
                        File source = new File(bundle, name);
                        if (source.isFile()) { Files.copy(source.toPath(), new File(destination, name).toPath(), StandardCopyOption.REPLACE_EXISTING); source.delete(); copied = true; }
                    }
                    out.putBoolean(name, copied || new File(destination, name).isFile());
                }
                out.putString("directory", destination.getAbsolutePath()); finish(Activity.RESULT_OK, out);
            } catch (Exception error) { out.putString("error", error.toString()); finish(Activity.RESULT_CANCELED, out); }
            return;
        }
        Bundle result = new Bundle(); File fixture = null, settings = null; byte[] previousSettings = null; boolean settingsExisted = false, fixtureCreated = false;
        try {
            File data = new File(getTargetContext().getNoBackupFilesDir(), "learnharness/data");
            fixture = new File(data, "chats/chat_mobile_layout_check.json");
            if (fixture.exists()) throw new AssertionError("Fixture path already exists");
            settings = new File(data, "settings.json"); settingsExisted = settings.exists(); if (settingsExisted) previousSettings = Files.readAllBytes(settings.toPath());
            JSONObject record = settingsExisted ? new JSONObject(new String(previousSettings, "UTF-8")) : new JSONObject().put("version", 1);
            JSONObject appearance = record.optJSONObject("appearance"); if (appearance == null) appearance = new JSONObject(); appearance.put("dictationOnly", false); record.put("appearance", appearance);
            Files.write(settings.toPath(), record.toString().getBytes("UTF-8"));
            try (InputStream in = getContext().getAssets().open("mobile-layout-fixture.json")) { Files.write(fixture.toPath(), in.readAllBytes()); fixtureCreated = true; }
            Activity activity = startActivitySync(new Intent(Intent.ACTION_MAIN).setClassName("ar.com.learnharness", "ar.com.learnharness.MainActivity").putExtra("learnharness.chat", "chat_mobile_layout_check").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK));
            Field webField = activity.getClass().getDeclaredField("web"); webField.setAccessible(true); web = (WebView) webField.get(activity);
            until("!!document.querySelector('[data-testid=teach-check-reveal]')", 150_000); Thread.sleep(1000);
            check("true".equals(evaluate("document.querySelector('[data-testid=reading-thinking-field]').getBoundingClientRect().height>0")), "Reading thoughts are available before opening the problem");
            evaluate("document.querySelector('[data-testid=teach-check-reveal]').click()");
            until("document.querySelector('[data-testid=question-dock]').getBoundingClientRect().height>100", 10_000); Thread.sleep(700);
            JSONObject compact = geometry();
            check(compact.getDouble("reading") == 0, "Reading thoughts disappear when the problem opens");
            check(compact.getDouble("thinking") < 135, "Your thinking field is compact on the phone");
            check(compact.getDouble("problem") > 350, "The problem gets a large readable viewport");
            checkSubmitVisible("Compact");
            screenshot("question-compact.png");
            evaluate("window.__voiceSaved=false;fetch('/api/settings/appearance',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({dictationOnly:true})}).then(r=>{window.__voiceSaved=r.ok})");
            until("window.__voiceSaved===true", 10_000);
            runOnMainSync(() -> web.reload());
            until("!!document.querySelector('[data-testid=teach-check-reveal]')", 30_000); Thread.sleep(1000);
            evaluate("document.querySelector('[data-testid=teach-check-reveal]').click()");
            until("!!document.querySelector('[data-testid=voice-answer-controls]')", 10_000); Thread.sleep(700);
            JSONObject voice = geometry();
            check(voice.getBoolean("voice") && voice.getDouble("reading") == 0, "Dictation-only preference persists across reloads");
            check("true".equals(evaluate("[...document.querySelectorAll('[data-file-path-input]')].every(e=>e.getBoundingClientRect().height===0)")), "Dictation-only mode has no visible text boxes");
            check(voice.getDouble("problem") > compact.getDouble("problem") + 20, "Dictation-only mode gives the problem still more room");
            check("true".equals(evaluate("!!document.querySelector('[data-testid=dictation-toggle]')")), "Dictate control remains available");
            checkSubmitVisible("Dictation-only");
            screenshot("question-dictation-only.png");
            // Exercise the populated home without writing graph data. This
            // fetch double lives only in the test WebView's current document.
            String graph;
            try (InputStream in = getContext().getAssets().open("mobile-graph-fixture.json")) { graph = new String(in.readAllBytes(), "UTF-8"); }
            evaluate("window.__layoutFetch=window.fetch.bind(window);window.fetch=(input,init)=>new URL(typeof input==='string'?input:input.url,location.href).pathname==='/api/graph'?Promise.resolve(new Response(" + JSONObject.quote(graph) + ",{headers:{'Content-Type':'application/json'}})):window.__layoutFetch(input,init)");
            evaluate("document.querySelector('a[href=\"/\"]').click()");
            until("!!document.querySelector('input[aria-label=\"Search nodes\"]')", 30_000); Thread.sleep(3000);
            bounds("input[aria-label='Search nodes']", "Graph search fits the Android screen");
            bounds("[data-testid=open-chain-table]", "Chains control fits the Android screen");
            bounds("[data-testid=import-notes]", "Import control fits the Android screen");
            bounds("button[aria-label='Graph display settings']", "Graph settings control fits the Android screen");
            check("true".equals(evaluate("document.documentElement.scrollWidth<=innerWidth+1")), "Home has no page-level horizontal overflow");
            screenshot("home-bounded.png");
            evaluate("document.querySelector('button[aria-label=\"Graph display settings\"]').click()");
            until("!!document.querySelector('[data-testid=graph-settings-panel]')", 10_000); Thread.sleep(1000);
            bounds("[data-testid=graph-settings-panel]", "Graph settings popover stays on screen");
            evaluate("document.querySelector('button[aria-label=\"Graph display settings\"]').click();document.querySelector('[data-testid=open-chain-table]').click()");
            until("!!document.querySelector('[data-testid=chain-table-search]')", 10_000); Thread.sleep(1000);
            bounds("[data-testid=chain-table-search]", "Chains search fits the Android screen");
            bounds("[data-testid=chain-table-close]", "Chains close control remains reachable");
            screenshot("chains-bounded.png");
            evaluate("window.fetch=window.__layoutFetch;delete window.__layoutFetch");
            result.putString("geometry", compact + " -> " + voice);
            result.putString("result", "PASS: " + checks + " mobile layout checks");
        } catch (Throwable error) { result.putString("error", error.toString()); }
        finally {
            try {
                if (fixtureCreated) fixture.delete();
                if (settings != null) { if (settingsExisted) Files.write(settings.toPath(), previousSettings); else settings.delete(); }
            } catch (Exception error) { result.putString("cleanupError", error.toString()); }
            finish(result.containsKey("error") || result.containsKey("cleanupError") ? Activity.RESULT_CANCELED : Activity.RESULT_OK, result);
        }
    }
}
