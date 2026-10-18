package dev.simmo.sonance;

import android.os.Build;
import android.webkit.JavascriptInterface;

/**
 * The shim's only door into native code (ticket-3.xx-androidtv §2.6), exposed to the page as
 * window.SonanceNative. Its presence is how the shim knows it runs on the Android host (S1).
 *
 * S2: platform identity (S3) and exit (S4). Playback (S3) and audio focus (S4) join later.
 * @JavascriptInterface methods run on a binder thread, never the UI thread: anything that touches
 * the activity is posted to it.
 */
final class NativeBridge {
    private final MainActivity activity;

    NativeBridge(MainActivity activity) {
        this.activity = activity;
    }

    /** S3: the Android version, for the Platform row ("Android TV 11"). */
    @JavascriptInterface
    public String androidVersion() {
        return Build.VERSION.RELEASE;
    }

    /** S4: tizen.application.getCurrentApplication().exit(). */
    @JavascriptInterface
    public void exit() {
        activity.runOnUiThread(activity::exitApp);
    }
}
