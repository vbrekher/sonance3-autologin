package dev.simmo.sonance;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.util.SparseArray;
import android.view.KeyEvent;
import android.view.View;
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
 * renderer's priority (W5) and exit (S4). Playback and the service join in S3 and S4.
 */
public class MainActivity extends Activity {
    static final String TAG = "Sonance";

    private static final String APP_URL = "file:///android_asset/www/index.html";
    private static final String APP_PATH = "/android_asset/www/index.html";
    private static final String SHIM_ASSET = "www/$WEBAPIS/webapis/webapis.js";
    private static final String SHIM_PATH_SUFFIX = "/$WEBAPIS/webapis/webapis.js";
    private static final String EXTRA_URL = "sonance_url";
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
    private WebView webView;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Set by aapt2 link --debug-mode only, so a release APK can never turn DevTools on (W7, P1).
        debug = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        WebView.setWebContentsDebuggingEnabled(debug);
        webView = createWebView();
        setContentView(webView);
        String url = debugUrl(getIntent());
        webView.loadUrl(url != null ? url : APP_URL);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        String url = debugUrl(intent);
        if (url != null) webView.loadUrl(url);
    }

    @Override
    protected void onDestroy() {
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
     *   APP_SWITCH) and pass-through (D-pad, DPAD_CENTER, ENTER, NUMPAD_ENTER, anything unlisted)
     *   both go to super: Android handles the first, and WebView sends the second as 37-40 and 13.
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
        if (webView == null) return;
        webView.evaluateJavascript("window.SonanceShim&&SonanceShim.receive({type:'key',action:'" + action
                + "',keyCode:" + key.code + ",key:'" + key.name + "',repeat:" + repeat + "})", null);
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

    /** S4: the page's exit(). The player and the service join in S3 and S4. */
    void exitApp() {
        Log.i(TAG, "[Sonance] exit");
        finishAndRemoveTask();
    }

    /**
     * W4: the renderer is gone (a crash, or a low-memory kill). This WebView can never draw again:
     * replace it with a new one that boots the app as a fresh launch, then destroy it. The player
     * and the service stop here too, from S3 and S4.
     */
    private void replaceWebView() {
        WebView dead = webView;
        webView = createWebView();
        setContentView(webView);
        dead.destroy();
        webView.loadUrl(APP_URL);
    }

    private WebView createWebView() {
        WebView wv = new WebView(this);
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

        wv.addJavascriptInterface(new NativeBridge(this), "SonanceNative");
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

    private boolean isDebugUrl(Uri uri) {
        return debug && (("http".equals(uri.getScheme()) && "localhost".equals(uri.getHost()))
                || CRASH_URL.equals(uri.toString()));
    }

    /** Scheme, host and path only: Subsonic URLs carry the auth token in their query. */
    private static String describe(Uri uri) {
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
