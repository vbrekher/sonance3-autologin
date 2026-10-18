package dev.simmo.sonance;

import android.app.Activity;
import android.content.Intent;
import android.content.pm.ApplicationInfo;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.webkit.ConsoleMessage;
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
 * and the debug-only harness hooks. Keys, lifecycle and renderer recovery arrive in S2.
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

        wv.addJavascriptInterface(new NativeBridge(), "SonanceNative");
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
