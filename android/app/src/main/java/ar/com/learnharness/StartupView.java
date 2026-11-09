package ar.com.learnharness;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.*;
import android.graphics.drawable.Drawable;
import android.os.SystemClock;
import android.view.*;
import android.widget.*;

/** Native counterpart of android/preview/loading.html; available before Node starts. */
final class StartupView extends FrameLayout {
    static final int BACKGROUND = Color.rgb(17, 22, 18);
    private final Artwork artwork;
    private final TextView title, status, firstLaunchNote;
    private boolean failed;

    StartupView(Context context) {
        super(context);
        setBackgroundColor(BACKGROUND);
        artwork = new Artwork(context);
        addView(artwork, new LayoutParams(-1, -1));
        title = label("LearnHarness", 35, Color.rgb(237, 240, 231));
        try { title.setTypeface(Typeface.createFromAsset(context.getAssets(), "startup-serif.ttf")); }
        catch (RuntimeException missing) { title.setTypeface(Typeface.create("serif", Typeface.BOLD)); }
        status = label("Getting your workspace ready", 14, Color.rgb(164, 177, 159));
        status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        firstLaunchNote = label("The first launch can take a little longer.", 12, Color.rgb(127, 141, 122));
        // Unknown is deliberately hidden until the runtime has checked disk.
        firstLaunchNote.setVisibility(View.GONE);
    }

    private TextView label(String text, int sp, int color) {
        TextView view = new TextView(getContext());
        view.setText(text); view.setTextSize(sp); view.setTextColor(color);
        view.setGravity(Gravity.CENTER); view.setIncludeFontPadding(false);
        addView(view, new LayoutParams(-1, -2));
        return view;
    }

    void setFirstLaunch(boolean first) {
        int visibility = first && !failed ? View.VISIBLE : View.GONE;
        if (firstLaunchNote.getVisibility() != visibility) firstLaunchNote.setVisibility(visibility);
    }

    void showError(String message) {
        animate().cancel(); setAlpha(1); setVisibility(View.VISIBLE);
        failed = true; artwork.failed = true; artwork.invalidate();
        title.setText("Unable to open LearnHarness"); title.setTextSize(25);
        status.setText(message); setFirstLaunch(false); requestLayout();
    }

    @Override protected void onMeasure(int widthSpec, int heightSpec) {
        super.onMeasure(widthSpec, heightSpec);
        int width = Math.max(1, getMeasuredWidth() - dp(40));
        for (TextView text : new TextView[]{title, status, firstLaunchNote})
            text.measure(MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
                MeasureSpec.makeMeasureSpec(getMeasuredHeight(), MeasureSpec.AT_MOST));
    }

    @Override protected void onLayout(boolean changed, int left, int top, int right, int bottom) {
        int w = right - left, h = bottom - top;
        artwork.layout(0, 0, w, h);
        boolean compact = w > h || h < dp(520);
        float scale = Math.min(w / 412f, h / 780f);
        float centerY = h * (compact ? .28f : .39f);
        artwork.centerY = centerY;
        artwork.artScale = compact ? Math.min(scale, h / 640f) : scale;
        int y = Math.round(centerY + 153 * artwork.artScale);
        int footerSpace = firstLaunchNote.getVisibility() == View.VISIBLE ? firstLaunchNote.getMeasuredHeight() + dp(45) : dp(16);
        y = Math.min(y, h - footerSpace - title.getMeasuredHeight() - status.getMeasuredHeight() - dp(36));
        y = Math.max(dp(8), y);
        place(title, y, w);
        place(status, title.getBottom() + dp(8), w);
        artwork.dotsY = status.getBottom() + dp(25);
        place(firstLaunchNote, h - dp(38) - firstLaunchNote.getMeasuredHeight(), w);
    }

    private void place(TextView view, int y, int width) {
        int x = (width - view.getMeasuredWidth()) / 2;
        view.layout(x, y, x + view.getMeasuredWidth(), y + view.getMeasuredHeight());
    }

    private int dp(float value) { return Math.round(value * getResources().getDisplayMetrics().density); }

    private static final class Artwork extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Drawable mark;
        private final long started = SystemClock.uptimeMillis();
        private static final float[][] ANCHORS = {{-107,-35},{-78,-106},{9,-135},{97,-89},{128,1},{85,97},{-3,124},{-105,66}};
        private static final int[][] EDGES = {{0,1},{1,2},{2,3},{3,4},{4,5},{5,6},{6,7},{7,0},{1,7},{3,5}};
        private final float[][] points = new float[8][2];
        float centerY, artScale = 1, dotsY;
        boolean failed;

        Artwork(Context context) {
            super(context);
            mark = context.getDrawable(R.drawable.startup_mark);
            setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        }

        @Override protected void onWindowVisibilityChanged(int visibility) {
            super.onWindowVisibilityChanged(visibility);
            if (visibility == VISIBLE) invalidate();
        }

        @Override protected void onDraw(Canvas canvas) {
            boolean moving = !failed && ValueAnimator.areAnimatorsEnabled();
            float t = moving ? (SystemClock.uptimeMillis() - started) / 1000f : 3;
            float breath = .5f + .5f * (float)Math.sin(t * Math.PI / 3);
            float arrival = ease(t / 1.8f), cx = getWidth() / 2f;
            canvas.save(); canvas.translate(cx, centerY); canvas.scale(artScale, artScale);
            paint.setShader(new RadialGradient(0, 0, 300, new int[]{rgba(115,155,103,.09f + breath*.025f),Color.TRANSPARENT}, null, Shader.TileMode.CLAMP));
            canvas.drawCircle(0, 0, 300, paint); paint.setShader(null);
            for (int i = 0; i < points.length; i++) {
                points[i][0] = ANCHORS[i][0]*(1.2f-.2f*arrival) + (float)Math.sin(t*.45f+i)*3;
                points[i][1] = ANCHORS[i][1]*(1.2f-.2f*arrival) + (float)Math.cos(t*.5f+i*.8f)*3;
            }
            for (int i = 0; i < EDGES.length; i++) {
                float[] a = points[EDGES[i][0]], b = points[EDGES[i][1]];
                float p = smooth((t-.25f-i*.065f)/1.1f);
                paint.setColor(rgba(151,180,140,.12f*p)); paint.setStrokeWidth(.7f);
                canvas.drawLine(a[0], a[1], a[0]+(b[0]-a[0])*p, a[1]+(b[1]-a[1])*p, paint);
                if (t > 1.4f) {
                    float phase = ((t-1.4f)*.19f+i*.17f)%1;
                    dot(canvas,a[0]+(b[0]-a[0])*phase,a[1]+(b[1]-a[1])*phase,1.5f,rgba(185,215,164,(float)Math.sin(phase*Math.PI)*.5f));
                }
            }
            for (int i = 0; i < points.length; i++) {
                float a = smooth((t-.1f-i*.07f)/.65f), pulse = .5f+.5f*(float)Math.sin(t*1.1f-i*.7f);
                dot(canvas,points[i][0],points[i][1],i%3==0?2.5f:1.7f,rgba(192,213,176,a*(.35f+pulse*.45f)));
            }
            canvas.save();
            canvas.rotate((float)Math.toDegrees((1-ease(t/2.4f))*(-Math.PI/3)+Math.sin(t*.7)*.045));
            int radius = Math.round((77*(.92f+.08f*arrival)+breath*1.6f)/2);
            mark.setBounds(-radius,-radius,radius,radius); mark.setAlpha(Math.round(smooth(t/1.1f)*255)); mark.draw(canvas);
            canvas.restore();
            paint.setStyle(Paint.Style.STROKE); paint.setStrokeWidth(.6f); paint.setColor(rgba(172,203,150,.12f+.04f*breath));
            float haloRadius = 67+breath*2;
            canvas.drawArc(-haloRadius,-haloRadius,haloRadius,haloRadius,(float)Math.toDegrees(t*.11-.7),(float)Math.toDegrees(4.5),false,paint);
            paint.setStyle(Paint.Style.FILL); canvas.restore();
            if (!failed) for (int i = 0; i < 3; i++) {
                float pulse = .5f+.5f*(float)Math.sin(t*2.4-i*.75);
                dot(canvas,cx+(i-1)*10*artScale,dotsY,1.6f*artScale,rgba(181,206,159,.25f+.6f*pulse));
            }
            if (moving && isShown() && getWindowVisibility() == VISIBLE) postInvalidateOnAnimation();
        }

        private void dot(Canvas canvas, float x, float y, float r, int color) { paint.setColor(color); canvas.drawCircle(x,y,r,paint); }
        private static float clamp(float x) { return Math.max(0,Math.min(1,x)); }
        private static float smooth(float x) { x=clamp(x);return x*x*(3-2*x); }
        private static float ease(float x) { return 1-(float)Math.pow(1-clamp(x),3); }
        private static int rgba(int r, int g, int b, float a) { return Color.argb(Math.round(clamp(a)*255),r,g,b); }
    }
}
