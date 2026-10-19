package dev.simmo.sonance;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.util.SparseArray;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.IOException;

/**
 * Hosts the Sonance web app (the .wgt's payload, byte for byte) full-screen in the system
 * WebView, at the 1920x1080 CSS viewport Tizen gives it (ticket-3.xx-androidtv §2.6).
 *
 * S1: loading (W1), viewport (W2), settings and hardening (W3), first frame (W6), logging (W7),
 * and the debug-only harness hooks. S2: key translation (K1, K2), renderer recovery (W4), the
 * renderer's priority (W5) and exit (S4). S3: playback (PlayerEngine, A1-A4) and the screen saver
 * (S5). S4: the foreground service (B1) and, in debug builds, the audio-focus drill (B2). Fix round
 * 1: the system keyboard (SonanceWebView: X2, X4), closed when Sonance stops or loses window focus.
 */
public class MainActivity extends Activity implements SonanceWebView.Host {
    static final String TAG = "Sonance";

    private static final String APP_URL = "file:///android_asset/www/index.html";
    private static final String APP_PATH = "/android_asset/www/index.html";
    private static final String SHIM_ASSET = "www/$WEBAPIS/webapis/webapis.js";
    private static final String SHIM_PATH_SUFFIX = "/$WEBAPIS/webapis/webapis.js";
    private static final String EXTRA_URL = "sonance_url";
    private static final String EXTRA_FOCUS_DRILL = "sonance_focus_drill";
    private static final String CRASH_URL = "chrome://crash";

    // index.html's viewport meta: the app is laid out for 1920 CSS px, as on the Q90R.
    private static final int CSS_WIDTH = 1920;
    // --bg-primary, as the theme's window background: no white frame before the page paints (W6).
    private static final int BG_PRIMARY = 0xFF0A0A0C;

    /** A Tizen key as focus.js knows it: its keyCode and its KeyboardEvent.key. */
    private static final class TizenKey {
        final int code;
        final String name;

        TizenKey(int code, String name) {
            this.code = code;
            this.name = name;
        }
    }

    // K1's "Translate" group. MediaPlay, MediaPause and the track keys are registered on Tizen but
    // have no handler in focus.js, so they have no effect there either.
    private static final SparseArray<TizenKey> TRANSLATED = new SparseArray<>();
    static {
        TRANSLATED.put(KeyEvent.KEYCODE_BACK, new TizenKey(10009, "XF86Back"));
        TRANSLATED.put(KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE, new TizenKey(10252, "MediaPlayPause"));
        TRANSLATED.put(KeyEvent.KEYCODE_MEDIA_STOP, new TizenKey(10253, "MediaStop"));
        TRANSLATED.put(KeyEvent.KEYCODE_MEDIA_REWIND, new TizenKey(10412, "MediaRewind"));
        TRANSLATED.put(KeyEvent.KEYCODE_MEDIA_FAST_FORWARD, new TizenKey(10417, "MediaFastForward"));
        TRANSLATED.put(KeyEvent.KEYCODE_MEDIA_PLAY, new TizenKey(415, "MediaPlay"));
        TRANSLATED.put(KeyEvent.KEYCODE_MEDIA_PAUSE, new TizenKey(19, "MediaPause"));
        TRANSLATED.put(KeyEvent.KEYCODE_MEDIA_PREVIOUS, new TizenKey(10232, "MediaTrackPrevious"));
        TRANSLATED.put(KeyEvent.KEYCODE_MEDIA_NEXT, new TizenKey(10233, "MediaTrackNext"));
        TRANSLATED.put(KeyEvent.KEYCODE_PROG_RED, new TizenKey(403, "ColorF0Red"));
        TRANSLATED.put(KeyEvent.KEYCODE_PROG_GREEN, new TizenKey(404, "ColorF1Green"));
        TRANSLATED.put(KeyEvent.KEYCODE_PROG_YELLOW, new TizenKey(405, "ColorF2Yellow"));
        TRANSLATED.put(KeyEvent.KEYCODE_PROG_BLUE, new TizenKey(406, "ColorF3Blue"));
    }

    private boolean debug;
    private SonanceWebView webView;
    private PlayerEngine engine;

    // B1, on the UI thread: the activity is visible (onStart to onStop); the page has played since
    // the service last stopped; the service has been started.
    private boolean visible;
    private boolean serviceWanted;
    private boolean serviceStarted;
    // Debug builds: the drill's focus request, which takes the focus from the player (B2).
    private AudioFocusRequest drill;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // B1: a service still running here played for an earlier activity, whose WebView is gone.
        if (PlaybackService.stop(this)) Log.i(TAG, "[Sonance] service: stopped one left by an earlier activity");
        // Set by aapt2 link --debug-mode only, so a release APK can never turn DevTools on (W7, P1).
        debug = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(debug);
        engine = new PlayerEngine(this, debug, message -> runOnUiThread(() -> toPage(message)));
        webView = createWebView();
        setContentView(webView);
        String url = debugUrl(getIntent());
        webView.loadUrl(url != null ? url : APP_URL);
        focusDrill(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String url = debugUrl(intent);
        if (url != null) webView.loadUrl(url);
        focusDrill(intent);
    }

    @Override
    protected void onStart() {
        super.onStart();
        visible = true;
    }

    @Override
    protected void onResume() {
        super.onResume();
        startService();
    }

    @Override
    protected void onStop() {
        visible = false;
        // X4: the keyboard never outlives Sonance in front, and the field cannot reopen it (D223).
        if (webView != null) webView.closeKeyboard("Sonance stopped", true);
        super.onStop();
    }

    /** X4: losing the window's focus closes the keyboard, as onStop does. */
    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // Debug builds: X2 routes keys in the focused view's dispatchKeyEventPreIme, so record which view it is.
        if (debug && hasFocus) {
            View focused = getCurrentFocus();
            Log.i(TAG, "[Sonance] window focus: " + (focused != null ? focused.getClass().getSimpleName() : "no view"));
        }
        if (!hasFocus && webView != null) webView.closeKeyboard("window lost focus", true);
    }

    @Override
    protected void onDestroy() {
        engine.quit();
        stopService("the activity ends");
        if (drill != null) getSystemService(AudioManager.class).abandonAudioFocusRequest(drill);
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }

    /**
     * K1: every key falls into one of four groups (ticket K1's table).
     * - Translate: the page receives the Tizen key event focus.js handles, and the native event is
     *   consumed, so a media key never reaches AudioManager (another app's media session).
     * - Swallow: nothing, as Tizen does not deliver unregistered keys (WebView would scroll on some).
     * - System (HOME, VOLUME_*, MUTE, POWER, SEARCH, ASSIST, VOICE_ASSIST, SETTINGS, TV_INPUT,
     *   APP_SWITCH) and pass-through (anything unlisted) both go to super: Android handles the
     *   first, and WebView the second. The D-pad, DPAD_CENTER, ENTER and NUMPAD_ENTER mostly never
     *   get here: SonanceWebView gives them to the WebView before the IME stage (X2), which sends
     *   them as 37-40 and 13; only with Sonance's keyboard up do they come this way, after it.
     * K2: BACK is translated, so it never finishes the activity by itself. With the system keyboard
     * up, the keyboard takes BACK before the activity sees it, and closes.
     */
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int code = event.getKeyCode();
        TizenKey key = TRANSLATED.get(code);
        if (key != null) {
            int action = event.getAction();
            if (action == KeyEvent.ACTION_DOWN) injectKey("down", key, event.getRepeatCount() > 0);
            else if (action == KeyEvent.ACTION_UP) injectKey("up", key, false);
            return true;
        }
        if (isSwallowed(code)) return true;
        return super.dispatchKeyEvent(event);
    }

    /**
     * A translated key, as a synthetic keydown or keyup, through the shim's one entry point.
     * evaluateJavascript runs here on the UI thread, and its scripts run in the order they were
     * sent, so keys arrive in the order they were pressed.
     *
     * D220: keys are dropped before the shim has loaded on the current page by the script's own
     * guard, not by a ready flag the shim sets and onPageStarted clears: onPageStarted is posted to
     * this thread and can land after the new page's shim has already reported in, which would drop
     * every key on that page.
     */
    private void injectKey(String action, TizenKey key, boolean repeat) {
        toPage("{type:'key',action:'" + action + "',keyCode:" + key.code + ",key:'" + key.name
                + "',repeat:" + repeat + "}");
    }

    /**
     * A message for the shim's one entry point, on the UI thread (evaluateJavascript's thread).
     * Keys, player events and callbacks share the one queue, so each kind keeps its order. The
     * guard drops messages before the shim has loaded on the current page (D220).
     */
    @Override
    public void toPage(String message) {
        if (webView == null) return;
        webView.evaluateJavascript("window.SonanceShim&&SonanceShim.receive(" + message + ")", null);
    }

    /**
     * S5: SCREEN_SAVER_OFF sets FLAG_KEEP_SCREEN_ON, which keeps Ambient Mode away while Sonance
     * plays in front; SCREEN_SAVER_ON clears it. Then the page's success callback.
     */
    void keepScreenOn(boolean keep, int callback) {
        Log.i(TAG, "[Sonance] keep screen on: " + keep);
        if (keep) getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        else getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        toPage("{type:'callback',id:" + callback + "}");
    }

    /**
     * K1's "Swallow" group: the keys the ticket names, plus (D221) the TV-specific keys Tizen would
     * not deliver: tuner, teletext and audio-description keys, and the media keys Sonance does not
     * translate, which WebView would otherwise pass to AudioManager and so to another app. TV_INPUT_*
     * and the TV/STB/AVR power and input keys select inputs and power, so they pass to the system as
     * TV_INPUT does.
     */
    private static boolean isSwallowed(int code) {
        switch (code) {
            case KeyEvent.KEYCODE_CHANNEL_UP:
            case KeyEvent.KEYCODE_CHANNEL_DOWN:
            case KeyEvent.KEYCODE_PAGE_UP:
            case KeyEvent.KEYCODE_PAGE_DOWN:
            case KeyEvent.KEYCODE_INFO:
            case KeyEvent.KEYCODE_GUIDE:
            case KeyEvent.KEYCODE_MENU:
            case KeyEvent.KEYCODE_CAPTIONS:
            case KeyEvent.KEYCODE_TV:
            case KeyEvent.KEYCODE_DVR:
            case KeyEvent.KEYCODE_LAST_CHANNEL:
            case KeyEvent.KEYCODE_TV_DATA_SERVICE:
            case KeyEvent.KEYCODE_TV_RADIO_SERVICE:
            case KeyEvent.KEYCODE_TV_TELETEXT:
            case KeyEvent.KEYCODE_TV_NUMBER_ENTRY:
            case KeyEvent.KEYCODE_TV_TERRESTRIAL_ANALOG:
            case KeyEvent.KEYCODE_TV_TERRESTRIAL_DIGITAL:
            case KeyEvent.KEYCODE_TV_SATELLITE:
            case KeyEvent.KEYCODE_TV_SATELLITE_BS:
            case KeyEvent.KEYCODE_TV_SATELLITE_CS:
            case KeyEvent.KEYCODE_TV_SATELLITE_SERVICE:
            case KeyEvent.KEYCODE_TV_NETWORK:
            case KeyEvent.KEYCODE_TV_ANTENNA_CABLE:
            case KeyEvent.KEYCODE_TV_AUDIO_DESCRIPTION:
            case KeyEvent.KEYCODE_TV_AUDIO_DESCRIPTION_MIX_UP:
            case KeyEvent.KEYCODE_TV_AUDIO_DESCRIPTION_MIX_DOWN:
            case KeyEvent.KEYCODE_TV_ZOOM_MODE:
            case KeyEvent.KEYCODE_TV_CONTENTS_MENU:
            case KeyEvent.KEYCODE_TV_MEDIA_CONTEXT_MENU:
            case KeyEvent.KEYCODE_TV_TIMER_PROGRAMMING:
            case KeyEvent.KEYCODE_MEDIA_RECORD:
            case KeyEvent.KEYCODE_MEDIA_EJECT:
            case KeyEvent.KEYCODE_MEDIA_CLOSE:
            case KeyEvent.KEYCODE_MEDIA_AUDIO_TRACK:
            case KeyEvent.KEYCODE_MEDIA_TOP_MENU:
            case KeyEvent.KEYCODE_MEDIA_SKIP_FORWARD:
            case KeyEvent.KEYCODE_MEDIA_SKIP_BACKWARD:
            case KeyEvent.KEYCODE_MEDIA_STEP_FORWARD:
            case KeyEvent.KEYCODE_MEDIA_STEP_BACKWARD:
                return true;
            default:
                return false;
        }
    }

    /**
     * B1: the page asked the engine to play. The service starts on the first play, and only while
     * the activity is visible: Android 12+ refuses a foreground-service start from the background.
     * A play that lands after the user left (the bridge call is posted here) starts it on return.
     */
    void playing() {
        serviceWanted = true;
        startService();
    }

    private void startService() {
        if (!serviceWanted || serviceStarted) return;
        if (!visible) {
            Log.i(TAG, "[Sonance] service: not started while hidden; it starts when Sonance is back in front");
            return;
        }
        try {
            PlaybackService.start(this);
            serviceStarted = true;
            Log.i(TAG, "[Sonance] service: started");
        } catch (IllegalStateException e) {
            // ForegroundServiceStartNotAllowedException (31+) is one: tried again on the next resume.
            Log.w(TAG, "[Sonance] service: start refused: " + e.getMessage());
        }
    }

    /** B1: kept between tracks, and stopped only on exit, renderer loss and the activity's end. */
    private void stopService(String why) {
        serviceWanted = false;
        serviceStarted = false;
        if (PlaybackService.stop(this)) Log.i(TAG, "[Sonance] service: stopping (" + why + ")");
    }

    /** X3: the keyboard Sonance opened is up or gone; the engine ducks for it instead of pausing. */
    @Override
    public void typing(boolean typing) {
        engine.setTyping(typing);
    }

    /** B1: the current track's title, for the notification. */
    void nowPlaying(String title) {
        PlaybackService.setTitle(title);
    }

    /**
     * S4: the page's exit() stops and releases the player and the service, then ends the task.
     */
    void exitApp() {
        Log.i(TAG, "[Sonance] exit");
        engine.release();
        stopService("exit");
        finishAndRemoveTask();
    }

    /**
     * W4: the renderer is gone (a crash, or a low-memory kill). This WebView can never draw again.
     * Playback stops first (step 1), so nothing plays for a page that no longer exists, and the
     * screen may sleep again, and the service stops (B1). Then a new WebView boots the app as a
     * fresh launch, and the dead one is destroyed.
     */
    private void replaceWebView() {
        engine.release();
        stopService("renderer gone");
        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        SonanceWebView dead = webView;
        webView = createWebView();
        setContentView(webView);
        dead.destroy();
        webView.loadUrl(APP_URL);
    }

    private SonanceWebView createWebView() {
        SonanceWebView wv = new SonanceWebView(this, debug, this);
        wv.setBackgroundColor(BG_PRIMARY);

        WebSettings s = wv.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);

        // W2 mechanism (a): the meta's width=1920 is honoured, and the initial scale maps 1920 CSS px
        // onto the screen's width. setInitialScale is divided by the density (2.0 on Android TV), so
        // 100 gives 1 CSS px = 1 physical px on a 1920 px wide screen.
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        int widthPx = getResources().getDisplayMetrics().widthPixels;
        int initialScale = Math.round(100f * widthPx / CSS_WIDTH);
        wv.setInitialScale(initialScale);
        // The system font-size setting must not scale text: the layout is rem on a scaled root (D49).
        s.setTextZoom(100);

        // W3: no file access beyond android_asset (which setAllowFileAccess does not govern).
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSafeBrowsingEnabled(false);
        wv.setOverScrollMode(View.OVER_SCROLL_NEVER);
        wv.setVerticalScrollBarEnabled(false);
        wv.setHorizontalScrollBarEnabled(false);
        wv.setLongClickable(false);
        wv.setHapticFeedbackEnabled(false);
        // No "save password" prompts, as on Tizen.
        wv.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS);

        // W5: the renderer keeps its priority while Sonance is in the background (it plays there,
        // B3). Its timers are never paused: no pauseTimers(), which would stop every WebView's.
        wv.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);

        wv.addJavascriptInterface(new NativeBridge(this, engine, wv), "SonanceNative");
        wv.setWebViewClient(new Client());
        wv.setWebChromeClient(new Chrome());
        wv.setFocusable(true);
        wv.setFocusableInTouchMode(true);
        wv.requestFocus();

        Log.i(TAG, "[Sonance] WebView " + WebView.getCurrentWebViewPackage().versionName
                + ": screen " + widthPx + " px, initialScale " + initialScale
                + ", textZoom " + s.getTextZoom() + ", debug " + debug);
        return wv;
    }

    /**
     * Debug builds only: the harness may point the WebView at the Mac's dev server through
     * adb reverse (http://localhost:*), or at chrome://crash for the renderer-loss drill (W4).
     * Anything else is ignored, and release builds ignore the extra entirely (W3).
     */
    private String debugUrl(Intent intent) {
        if (!debug || intent == null) return null;
        String url = intent.getStringExtra(EXTRA_URL);
        if (url == null) return null;
        if (isDebugUrl(Uri.parse(url))) return url;
        Log.w(TAG, "[Sonance] ignored " + EXTRA_URL + " (http://localhost or " + CRASH_URL + " only)");
        return null;
    }

    /**
     * Debug builds only (B2's drill, prompt §A5): sonance_focus_drill=gain|transient|duck makes a
     * second focus request with its own listener, which takes the focus from the player as another
     * app would (permanent loss, transient loss, duck). Any other value (e.g. "release") abandons
     * it, and the focus goes back to the player if its request is still on the stack.
     */
    private void focusDrill(Intent intent) {
        if (!debug || intent == null) return;
        String kind = intent.getStringExtra(EXTRA_FOCUS_DRILL);
        if (kind == null) return;
        AudioManager audio = getSystemService(AudioManager.class);
        if (drill != null) {
            audio.abandonAudioFocusRequest(drill);
            drill = null;
        }
        int gain;
        switch (kind) {
            case "gain":
                gain = AudioManager.AUDIOFOCUS_GAIN;
                break;
            case "transient":
                gain = AudioManager.AUDIOFOCUS_GAIN_TRANSIENT;
                break;
            case "duck":
                gain = AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK;
                break;
            default:
                Log.i(TAG, "[Sonance] focus drill: released");
                return;
        }
        drill = new AudioFocusRequest.Builder(gain)
                .setAudioAttributes(PlayerEngine.ATTRIBUTES)
                .setOnAudioFocusChangeListener(change -> Log.i(TAG, "[Sonance] focus drill: change " + change))
                .build();
        int result = audio.requestAudioFocus(drill);
        Log.i(TAG, "[Sonance] focus drill: " + kind + " -> "
                + (result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED ? "granted" : "result " + result));
    }

    private boolean isDebugUrl(Uri uri) {
        return debug && (("http".equals(uri.getScheme()) && "localhost".equals(uri.getHost()))
                || CRASH_URL.equals(uri.toString()));
    }

    /** Scheme, host and path only: Subsonic URLs carry the auth token in their query. */
    static String describe(Uri uri) {
        if (uri.getScheme() == null) return String.valueOf(uri.getPath());
        return uri.getScheme() + "://" + (uri.getAuthority() != null ? uri.getAuthority() : "") + uri.getPath();
    }

    private final class Client extends WebViewClient {
        /** W3: the WebView never navigates away from the app's own page. */
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            boolean appPage = "file".equals(uri.getScheme()) && APP_PATH.equals(uri.getPath());
            if (appPage || isDebugUrl(uri)) return false;
            Log.w(TAG, "[Sonance] blocked navigation to " + describe(uri));
            return true;
        }

        /**
         * Debug harness: a page served by the dev server gets the shim where Tizen serves webapis.js,
         * so the bundled index.html runs as it does from the APK's assets.
         */
        @Override
        public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            String path = uri.getPath();
            if (!debug || !"http".equals(uri.getScheme()) || !"localhost".equals(uri.getHost())
                    || path == null || !path.endsWith(SHIM_PATH_SUFFIX)) {
                return null;
            }
            try {
                return new WebResourceResponse("application/javascript", "utf-8", getAssets().open(SHIM_ASSET));
            } catch (IOException e) {
                Log.e(TAG, "[Sonance] shim asset missing", e);
                return null;
            }
        }

        /** W4: returning true keeps the app alive when its renderer dies. */
        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            Log.w(TAG, "[Sonance] renderer gone (" + (detail.didCrash() ? "crashed" : "killed")
                    + "): starting the app afresh");
            if (view == webView) replaceWebView();
            return true;
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            Log.w(TAG, "[Sonance] request failed: " + describe(request.getUrl())
                    + " (" + error.getErrorCode() + " " + error.getDescription() + ")");
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            Log.w(TAG, "[Sonance] request failed: " + describe(request.getUrl())
                    + " (HTTP " + response.getStatusCode() + ")");
        }
    }

    /** W7: console messages go to Logcat under the tag Sonance; the app's own gating is unchanged. */
    private static final class Chrome extends WebChromeClient {
        @Override
        public boolean onConsoleMessage(ConsoleMessage m) {
            String text = m.message();
            switch (m.messageLevel()) {
                case ERROR:
                    Log.e(TAG, text + " (" + describe(Uri.parse(m.sourceId())) + ":" + m.lineNumber() + ")");
                    break;
                case WARNING:
                    Log.w(TAG, text + " (" + describe(Uri.parse(m.sourceId())) + ":" + m.lineNumber() + ")");
                    break;
                default:
                    Log.i(TAG, text);
            }
            return true;
        }
    }
}
