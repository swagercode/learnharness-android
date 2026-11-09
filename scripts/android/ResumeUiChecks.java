package ar.com.learnharness.tests;

import android.app.*;
import android.content.*;
import android.graphics.Bitmap;
import android.os.*;
import android.view.*;
import android.webkit.*;
import org.json.*;
import java.io.*;
import java.lang.reflect.*;
import java.nio.file.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

/** Test-only: Chromium's unpainted surface and real background/return frames.
 * Only the disposable fixture is written; existing sessions are untouched. */
public final class ResumeUiChecks extends Instrumentation {
    private WebView web, blank;
    private Activity activity;
    private int checks, frames;
    @Override public void onCreate(Bundle args) { super.onCreate(args); start(); }
    private void check(boolean okay, String label) {
        if (!okay) throw new AssertionError(label);
        checks++; Bundle out = new Bundle(); out.putString("check", label); sendStatus(0, out);
    }
    private Object field(Object instance, String name) throws Exception {
        Field field=instance.getClass().getDeclaredField(name); field.setAccessible(true); return field.get(instance);
    }
    private String evaluate(String script) throws Exception {
        AtomicReference<String> value=new AtomicReference<>(); CountDownLatch done=new CountDownLatch(1);
        runOnMainSync(()->web.evaluateJavascript(script,result->{value.set(result);done.countDown();}));
        if(!done.await(5,TimeUnit.SECONDS))throw new AssertionError("JavaScript timed out");
        return value.get();
    }
    private void until(String expression, long timeout) throws Exception {
        long end=SystemClock.uptimeMillis()+timeout;
        while(SystemClock.uptimeMillis()<end){if("true".equals(evaluate(expression)))return;Thread.sleep(100);}
        throw new AssertionError("Timed out waiting for fixture");
    }
    private void shell(String command) throws Exception {
        try(ParcelFileDescriptor fd=getUiAutomation().executeShellCommand(command);
            InputStream in=new ParcelFileDescriptor.AutoCloseInputStream(fd)){in.readAllBytes();}
    }
    private Bitmap capture(String name) throws Exception {
        Bitmap bitmap=getUiAutomation().takeScreenshot();
        if(bitmap==null)throw new AssertionError("Screenshot unavailable");
        if(name!=null)try(FileOutputStream out=new FileOutputStream(new File(getTargetContext().getExternalFilesDir(null),name))){bitmap.compress(Bitmap.CompressFormat.PNG,100,out);}
        return bitmap;
    }
    private double whiteFraction(Bitmap bitmap) {
        int white=0,total=0;
        for(int y=bitmap.getHeight()/5;y<bitmap.getHeight()*4/5;y+=12)
            for(int x=bitmap.getWidth()/8;x<bitmap.getWidth()*7/8;x+=12){
                int color=bitmap.getPixel(x,y);
                if(((color>>16)&255)>240&&((color>>8)&255)>240&&(color&255)>240)white++;
                total++;
            }
        return (double)white/total;
    }
    @Override public void onStart() {
        Bundle result=new Bundle();
        File fixture=new File(getTargetContext().getNoBackupFilesDir(),"learnharness/data/chats/chat_android_resume_validation.json");
        boolean created=false;
        int resultCode=Activity.RESULT_CANCELED;
        try {
            // A killed test process can leave its own fixture behind.
            if(fixture.exists()) {
                JSONObject stale=new JSONObject(new String(Files.readAllBytes(fixture.toPath()),"UTF-8"));
                if("chat_android_resume_validation".equals(stale.optString("id"))&&"Resume display check".equals(stale.optString("title"))
                    &&stale.getJSONArray("messages").toString().contains("\"id\":\"resume-ready\""))fixture.delete();
            }
            if(fixture.exists())throw new IOException("Fixture already exists; refusing overwrite");
            JSONObject record;
            try(InputStream in=getContext().getAssets().open("demo-ui.json")){record=new JSONObject(new String(in.readAllBytes(),"UTF-8"));}
            record.put("id","chat_android_resume_validation").put("title","Resume display check");
            // End with a completed assistant reply, so opening this fixture
            // never requests a model continuation or spends provider tokens.
            JSONObject usage=new JSONObject("{\"input\":0,\"output\":0,\"cacheRead\":0,\"cacheWrite\":0,\"totalTokens\":0,\"cost\":{\"input\":0,\"output\":0,\"cacheRead\":0,\"cacheWrite\":0,\"total\":0}}");
            record.getJSONArray("messages").put(new JSONObject().put("id","resume-ready").put("role","assistant")
                .put("api","openai-responses").put("provider","openai").put("model","fixture-no-provider-calls")
                .put("content",new JSONArray().put(new JSONObject().put("type","text").put("text","The workspace is ready.")))
                .put("stopReason","stop").put("timestamp",System.currentTimeMillis()).put("usage",usage));
            Files.write(fixture.toPath(),record.toString().getBytes("UTF-8")); created=true;
            activity=startActivitySync(new Intent(Intent.ACTION_MAIN).setClassName("ar.com.learnharness","ar.com.learnharness.MainActivity")
                .putExtra("learnharness.chat","chat_android_resume_validation").addFlags(Intent.FLAG_ACTIVITY_NEW_TASK|Intent.FLAG_ACTIVITY_CLEAR_TASK));
            web=(WebView)field(activity,"web");
            until("!!document.querySelector('[data-testid=demo-fullscreen-open]')",180000);
            Thread.sleep(600);
            check(web.getVisibility()==View.VISIBLE&&((View)field(activity,"loading")).getVisibility()==View.GONE,"First rendered page replaces startup surface");

            // Exercise the same configuration with no HTML/CSS. This exposes
            // the exact fallback Chromium draws before it has page pixels.
            Method configure=activity.getClass().getDeclaredMethod("configure",WebView.class); configure.setAccessible(true);
            CountDownLatch painted=new CountDownLatch(1);
            runOnMainSync(()->{
                blank=new WebView(activity);
                try{configure.invoke(activity,blank);}catch(Exception error){throw new RuntimeException(error);}
                ((ViewGroup)web.getParent()).addView(blank,new ViewGroup.LayoutParams(-1,-1));
                blank.setWebViewClient(new WebViewClient(){@Override public void onPageFinished(WebView view,String url){
                    view.postVisualStateCallback(1,new WebView.VisualStateCallback(){@Override public void onComplete(long id){painted.countDown();}});
                }});
                blank.loadDataWithBaseURL("https://fixture.invalid/","<!doctype html><html><body></body></html>","text/html","UTF-8",null);
            });
            if(!painted.await(10,TimeUnit.SECONDS))throw new AssertionError("Blank surface did not render");
            Thread.sleep(300);
            Bitmap fallback=capture("resume-fallback.png");
            double fraction=whiteFraction(fallback); fallback.recycle();
            check(fraction<0.05,"Unpainted WebView is dark (white fraction "+fraction+")");
            runOnMainSync(()->{((ViewGroup)blank.getParent()).removeView(blank);blank.destroy();blank=null;});

            evaluate("window.__resumeValidation={token:'keep-this-page',url:location.href};");
            WebView original=web;
            for(int cycle=0;cycle<3;cycle++) {
                // Home and an external activity exercise app-switch returns;
                // screen off/on also exercises compositor surface recovery.
                if(cycle==0)shell("input keyevent KEYCODE_HOME");
                else if(cycle==1)shell("am start -a android.settings.SETTINGS");
                else shell("input keyevent KEYCODE_SLEEP");
                Thread.sleep(cycle==1?1200:400);
                if(cycle==2){shell("input keyevent KEYCODE_WAKEUP");shell("wm dismiss-keyguard");}
                shell("am start -W -n ar.com.learnharness/.MainActivity --activity-reorder-to-front");
                AtomicBoolean focused=new AtomicBoolean(false);
                long focusDeadline=SystemClock.uptimeMillis()+10000;
                do {
                    runOnMainSync(()->focused.set(activity.hasWindowFocus()));
                    if(!focused.get())Thread.sleep(16);
                } while(!focused.get()&&SystemClock.uptimeMillis()<focusDeadline);
                check(focused.get(),"Return "+cycle+" restores the app window");
                // Exclude the outgoing system Settings window's animation;
                // capture the app's own resumed surface, not another app.
                Thread.sleep(300);
                double worst=0;
                long end=SystemClock.uptimeMillis()+1200;
                do {
                    Bitmap frame=capture(frames==0?"resume-return-first.png":null);
                    worst=Math.max(worst,whiteFraction(frame)); frame.recycle(); frames++;
                } while(SystemClock.uptimeMillis()<end);
                check(worst<0.8,"Return "+cycle+" has no white screen (max white fraction "+worst+")");
                check(field(activity,"web")==original&&"true".equals(evaluate("window.__resumeValidation?.token==='keep-this-page'&&location.href===window.__resumeValidation.url")),"Return "+cycle+" keeps the same page and WebView");
            }
            result.putString("result","PASS: "+checks+" resume checks, "+frames+" transition frames");
            resultCode=Activity.RESULT_OK;
        } catch(Throwable error) {
            result.putString("error",error.toString());
        } finally {
            runOnMainSync(()->{if(blank!=null){((ViewGroup)blank.getParent()).removeView(blank);blank.destroy();blank=null;}});
            if(created)fixture.delete();
        }
        finish(resultCode,result);
    }
}
