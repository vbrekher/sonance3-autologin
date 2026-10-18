package dev.simmo.sonance;

import android.os.Build;
import android.webkit.JavascriptInterface;

/**
 * The shim's only door into native code (ticket-3.xx-androidtv §2.6), exposed to the page as
 * window.SonanceNative. Its presence is how the shim knows it runs on the Android host (S1).
 *
 * S2: platform identity (S3) and exit (S4). S3: the player (A1) and the screen saver (S5). S4: the
 * service's start on play and the notification's title (B1); audio focus (B2) is the engine's, on
 * play. @JavascriptInterface methods run on a binder thread, never the UI thread:
 * anything that touches the activity is posted to it, and the player's calls are posted to its own
 * thread, so none of them waits.
 */
final class NativeBridge {
    private final MainActivity activity;
    private final PlayerEngine engine;

    NativeBridge(MainActivity activity, PlayerEngine engine) {
        this.activity = activity;
        this.engine = engine;
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

    // A1: webapis.avplay's calls. open returns the new session's id; every event carries it.

    @JavascriptInterface
    public int playerOpen(String url) {
        return engine.open(url);
    }

    @JavascriptInterface
    public void playerPrepare(int session) {
        engine.prepare(session);
    }

    /** Also B1: the first play starts the service, while the activity is visible. */
    @JavascriptInterface
    public void playerPlay(int session) {
        engine.play(session);
        activity.runOnUiThread(activity::playing);
    }

    @JavascriptInterface
    public void playerPause(int session) {
        engine.pause(session);
    }

    @JavascriptInterface
    public void playerSeek(int session, int ms, int seek) {
        engine.seek(session, ms, seek);
    }

    @JavascriptInterface
    public void playerStop(int session) {
        engine.stop(session);
    }

    @JavascriptInterface
    public void playerClose(int session) {
        engine.close(session);
    }

    /** S5: webapis.appcommon.setScreenSaver; `callback` is answered once the flag is set. */
    @JavascriptInterface
    public void setKeepScreenOn(boolean keep, int callback) {
        activity.runOnUiThread(() -> activity.keepScreenOn(keep, callback));
    }

    /** B1: the current track's title ("" for none), for the service's notification. */
    @JavascriptInterface
    public void nowPlaying(String title) {
        activity.runOnUiThread(() -> activity.nowPlaying(title));
    }
}
