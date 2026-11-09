package ar.com.learnharness.tests;

import android.app.*;
import android.content.*;
import android.graphics.Bitmap;
import android.os.*;
import android.view.*;
import android.webkit.*;
import android.widget.TextView;
import org.json.*;
import java.io.*;
import java.lang.reflect.*;
import java.nio.file.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/** Test-only fixture: fullscreen/Back/state preservation and native startup. */
public final class DemoUiChecks extends Instrumentation {
    private WebView web;
    private int checks;
    @Override public void onCreate(Bundle args) { super.onCreate(args); start(); }
    private void check(boolean okay, String label) {
        if (!okay) throw new AssertionError(label);
        checks++; Bundle out = new Bundle(); out.putString("check", label); sendStatus(0,out);
    }
    private String evaluate(String script) throws Exception {
        AtomicReference<String> value = new AtomicReference<>(); CountDownLatch done = new CountDownLatch(1);
        runOnMainSync(() -> web.evaluateJavascript(script, result -> { value.set(result); done.countDown(); }));
        if (!done.await(5, TimeUnit.SECONDS)) throw new AssertionError("JavaScript timed out");
        return value.get();
    }
    private void until(String expression, long timeout) throws Exception {
        long end = SystemClock.uptimeMillis()+timeout;
        while(SystemClock.uptimeMillis()<end) { if("true".equals(evaluate(expression)))return;Thread.sleep(150); }
        throw new AssertionError("Timed out: "+expression);
    }
    private Object field(Object instance, String name) throws Exception {
        Field field=instance.getClass().getDeclaredField(name);field.setAccessible(true);return field.get(instance);
    }
    private void screenshot(String name) throws Exception {
        Bitmap bitmap=getUiAutomation().takeScreenshot();
        try(FileOutputStream out=new FileOutputStream(new File(getTargetContext().getExternalFilesDir(null),name))) { bitmap.compress(Bitmap.CompressFormat.PNG,100,out); }
        bitmap.recycle();
    }
    @Override public void onStart() {
        Bundle result=new Bundle();
        File fixture=new File(getTargetContext().getNoBackupFilesDir(),"learnharness/data/chats/chat_android_demo_ui_validation.json");
        boolean created=false;
        try {
            if(fixture.exists())throw new IOException("Fixture already exists; refusing overwrite");
            try(InputStream in=getContext().getAssets().open("demo-ui.json")) {
                JSONObject record=new JSONObject(new String(in.readAllBytes(),"UTF-8"));record.put("id","chat_android_demo_ui_validation");
                Files.write(fixture.toPath(),record.toString().getBytes("UTF-8"));created=true;
            }
            Activity activity=startActivitySync(new Intent(Intent.ACTION_MAIN).setClassName("ar.com.learnharness","ar.com.learnharness.MainActivity")
                .putExtra("learnharness.chat","chat_android_demo_ui_validation").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_CLEAR_TASK));
            web=(WebView)field(activity,"web");
            until("!!document.querySelector('[data-testid=demo-fullscreen-open]')",150000);
            Thread.sleep(1000);
            evaluate("window.__demoState=null;window.addEventListener('message',e=>{if(e.source===document.querySelector('[data-testid=demo-iframe]').contentWindow&&e.data?.type==='fixture-demo-state')window.__demoState=e.data});document.querySelector('[data-testid=demo-iframe]').contentWindow.postMessage({type:'fixture-increment'},'*')");
            until("window.__demoState?.count===1",10000);
            evaluate("window.__demoInstance=window.__demoState.instance;document.querySelector('[data-testid=demo-fullscreen-open]').click()");
            until("document.querySelector('[data-testid=demo-card]').matches(':modal')",10000);
            check("true".equals(evaluate("(()=>{const b=document.querySelector('[data-testid=demo-fullscreen-close]'),r=b.getBoundingClientRect();return r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight&&r.height>=44&&r.width>=44})()")),"Full-screen Close is visible and touch-sized");
            Thread.sleep(500); // Allow the top-layer layout to reach the compositor.
            screenshot("demo-fullscreen.png");
            evaluate("document.querySelector('[data-testid=demo-iframe]').focus()");
            sendKeyDownUpSync(KeyEvent.KEYCODE_BACK);
            until("!!document.querySelector('[data-testid=demo-fullscreen-open]')",10000);
            check("true".equals(evaluate("location.pathname.endsWith('/chat_android_demo_ui_validation')&&!document.querySelector('[data-testid=demo-card]').matches(':modal')")),"Android Back closes fullscreen without leaving the lesson");
            evaluate("window.__demoState=null;document.querySelector('[data-testid=demo-iframe]').contentWindow.postMessage({type:'fixture-status'},'*')");
            until("window.__demoState?.count===1",10000);
            check("true".equals(evaluate("window.__demoState.instance===window.__demoInstance")),"Demo state survives Android Back");
            evaluate("document.querySelector('[data-testid=demo-fullscreen-open]').click()");
            until("!!document.querySelector('[data-testid=demo-fullscreen-close]')",10000);
            evaluate("document.querySelector('[data-testid=demo-fullscreen-close]').click()");
            until("!!document.querySelector('[data-testid=demo-fullscreen-open]')",10000);
            check("true".equals(evaluate("!document.querySelector('[data-testid=demo-card]').matches(':modal')&&document.documentElement.style.overflow!==\"hidden\"")),"Close restores the inline demo and normal scrolling");
            check("true".equals(evaluate("document.querySelector('[data-testid=demo-iframe]').getAttribute('sandbox')==='allow-scripts'&&!document.querySelector('[data-testid=demo-download]')")),"Fullscreen replaces download and preserves iframe isolation");
            View startup=(View)field(activity,"loading");
            TextView note=(TextView)field(startup,"firstLaunchNote");
            TextView status=(TextView)field(startup,"status");
            Method first=startup.getClass().getDeclaredMethod("setFirstLaunch",boolean.class);first.setAccessible(true);
            runOnMainSync(()->{startup.animate().cancel();startup.setAlpha(1);startup.setVisibility(View.VISIBLE);});
            runOnMainSync(()->{try{first.invoke(startup,false);}catch(Exception e){throw new RuntimeException(e);}});
            Thread.sleep(600);
            check(note.getVisibility()==View.GONE,"First-launch note is absent on a returning launch");
            check(status.getText().toString().equals("Getting your workspace ready"),"Native startup copy is English");
            screenshot("startup-returning.png");
            runOnMainSync(()->{try{first.invoke(startup,true);}catch(Exception e){throw new RuntimeException(e);}});
            Thread.sleep(300);
            check(note.getVisibility()==View.VISIBLE,"First-launch note is available for a fresh installation");
            screenshot("startup-first.png");
            runOnMainSync(()->startup.setVisibility(View.GONE));
            result.putString("result","PASS: "+checks+" Android demo/startup checks");
        }catch(Throwable error){result.putString("error",error.toString());}
        finally {
            if(created&&!fixture.delete())result.putString("cleanupError","Could not delete fixture");
            finish(result.containsKey("error")||result.containsKey("cleanupError")?Activity.RESULT_CANCELED:Activity.RESULT_OK,result);
        }
    }
}
