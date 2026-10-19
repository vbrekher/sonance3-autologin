package dev.simmo.sonance;

import android.content.Context;
import android.os.Build;
import android.util.Log;
import android.util.SparseIntArray;
import android.view.KeyEvent;
import android.view.WindowInsets;
import android.view.inputmethod.InputMethodManager;
import android.webkit.WebView;

/**
 * The app's WebView, with the system keyboard under Sonance's control (fix round 1: X2, X4).
 *
 * X2. ViewRootImpl hands every key to the bound IME before the view hierarchy sees it, whether
 * the keyboard is showing or not. On the SHIELD a hidden Gboard, still bound to Sonance's window
 * after a sign-out and sign-in, began its own repeat on a Right press, never took the release,
 * and sent Right every 88 ms until it was killed (PROGRESS 2026-10-19 11:20). On the emulator
 * the hidden Gboard receives every D-pad key too (atrace: ImeInputStage and aq:imm 1 then 0 for
 * the down and the up; ticket §9 fix round 1, F1). dispatchKeyEventPreIme runs before that stage,
 * so the D-pad, DPAD_CENTER, ENTER and NUMPAD_ENTER are given straight to the WebView here and
 * the IME never sees them, unless Sonance opened the keyboard and it is showing: then they go to
 * it, for its own key navigation. A key's route is chosen at its down; its repeats and its up
 * follow it, so the IME never sees a release without its press, nor a press without its release.
 * Back, the media keys and the colour keys keep their path (the activity's K1).
 *
 * X4 (D236, superseding D223). The keyboard opens only on OK on a text field, as on Tizen. The
 * shim keeps inputmode="none" on every editable until then, so Chromium never shows it by itself.
 * OK on a field is consumed (down and up: the page sees no Enter), the shim drops inputmode
 * ({type:'ime', action:'open'}), and on its imeReady() the keyboard is shown. It closes, and the
 * shim puts inputmode back ({action:'reset'}), on Back, when the page's editing ends (the shim's
 * imeEditing(false)), when the keyboard hides by itself (API 30+, from the IME insets), and when
 * the activity stops or its window loses focus. A keyboard that shows without OK is hidden.
 *
 * X3. While the keyboard Sonance opened is up, the engine knows it (Host.typing), so Gboard's
 * transient audio focus ducks the music instead of pausing it.
 *
 * Everything here runs on the UI thread.
 */
final class SonanceWebView extends WebView {
    /** What the keyboard needs from the activity. */
    interface Host {
        /** A message for the shim's one entry point (D220). */
        void toPage(String message);

        /** X3: the keyboard Sonance opened is up (true) or gone (false). */
        void typing(boolean typing);
    }

    private static final String TAG = MainActivity.TAG;
    private static final String IME_OPEN = "{type:'ime',action:'open'}";
    private static final String IME_RESET = "{type:'ime',action:'reset'}";

    // A routed key's way in.
    private static final int ROUTE_IME = 0;    // through the IME stage: the keyboard is up
    private static final int ROUTE_PAST = 1;   // straight to the WebView: the IME never sees it
    private static final int ROUTE_OPEN = 2;   // OK on a field: consumed, and it opens the keyboard

    private final Host host;
    private final boolean debug;
    private final InputMethodManager imm;
    // Per key code, the route its down took, for its repeats and its up.
    private final SparseIntArray routes = new SparseIntArray();

    // The page has an editable focused (the shim's imeEditing).
    private boolean editing;
    // Sonance opened the keyboard, and has not closed it since.
    private boolean keyboardOpen;
    // API 30+: the IME insets are visible; and they have been since the keyboard opened.
    private boolean imeVisible;
    private boolean imeSeen;
    // A Back press reached the open keyboard: its up closes it.
    private boolean backToKeyboard;

    SonanceWebView(Context context, boolean debug, Host host) {
        super(context);
        this.debug = debug;
        this.host = host;
        imm = context.getSystemService(InputMethodManager.class);
        // Below API 30 there is no IME visibility to read: the keyboard counts as up while open.
        if (Build.VERSION.SDK_INT >= 30) getViewTreeObserver().addOnGlobalLayoutListener(this::checkIme);
    }

    @Override
    public boolean dispatchKeyEventPreIme(KeyEvent event) {
        int code = event.getKeyCode();
        int action = event.getAction();
        if (code == KeyEvent.KEYCODE_BACK) {
            // The open keyboard takes Back and closes itself (K2). Its up closes Sonance's side
            // after that dispatch, so the IME still gets the up, and no 10009 reaches the page.
            if (action == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
                backToKeyboard = keyboardOpen;
            } else if (action == KeyEvent.ACTION_UP && backToKeyboard) {
                backToKeyboard = false;
                post(() -> closeKeyboard("Back", false));
            }
            return super.dispatchKeyEventPreIme(event);
        }
        if (!isRouted(code)) return super.dispatchKeyEventPreIme(event);

        int route;
        if ((action == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) || routes.indexOfKey(code) < 0) {
            route = route(code);
            routes.put(code, route);
            if (debug && action == KeyEvent.ACTION_DOWN) {
                Log.i(TAG, "[Sonance] key " + code + " down: " + (route == ROUTE_PAST ? "past the IME"
                        : route == ROUTE_OPEN ? "opens the keyboard" : "to the keyboard"));
            }
        } else {
            route = routes.get(code);
        }
        if (action == KeyEvent.ACTION_UP) routes.delete(code);

        if (route == ROUTE_PAST) {
            dispatchKeyEvent(event);
            return true;
        }
        if (route == ROUTE_OPEN) {
            if (action == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) openKeyboard();
            return true;
        }
        return super.dispatchKeyEventPreIme(event);
    }

    private static boolean isRouted(int code) {
        switch (code) {
            case KeyEvent.KEYCODE_DPAD_UP:
            case KeyEvent.KEYCODE_DPAD_DOWN:
            case KeyEvent.KEYCODE_DPAD_LEFT:
            case KeyEvent.KEYCODE_DPAD_RIGHT:
                return true;
            default:
                return isOk(code);
        }
    }

    private static boolean isOk(int code) {
        return code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER
                || code == KeyEvent.KEYCODE_NUMPAD_ENTER;
    }

    private int route(int code) {
        if (keyboardOpen && (imeVisible || Build.VERSION.SDK_INT < 30)) return ROUTE_IME;
        if (editing && isOk(code)) return ROUTE_OPEN;
        return ROUTE_PAST;
    }

    /** X4, OK on a field: the shim drops inputmode, and its imeReady() shows the keyboard. */
    private void openKeyboard() {
        keyboardOpen = true;
        imeSeen = false;
        if (debug) Log.i(TAG, "[Sonance] keyboard: opening (OK on a field)");
        host.toPage(IME_OPEN);
    }

    /** The shim has dropped inputmode (from the bridge). X3: the engine hears first. */
    void imeReady() {
        if (!keyboardOpen) return;
        host.typing(true);
        if (imm.showSoftInput(this, 0)) {
            if (debug) Log.i(TAG, "[Sonance] keyboard: open");
        } else {
            Log.w(TAG, "[Sonance] keyboard: showSoftInput refused");
            closeKeyboard("not shown", true);
        }
    }

    /** The page's editing state (the shim's imeEditing, from the bridge). Ended, the keyboard closes. */
    void editing(boolean editing) {
        this.editing = editing;
        if (!editing && keyboardOpen) closeKeyboard("editing ended", true);
    }

    /**
     * Sonance's keyboard is closed and the shim puts inputmode back, so nothing reopens it.
     * `hide`: ask the IME to hide too (not after Back, which the IME has taken itself).
     */
    void closeKeyboard(String why, boolean hide) {
        boolean wasOpen = keyboardOpen;
        keyboardOpen = false;
        imeSeen = false;
        backToKeyboard = false;
        if (wasOpen) host.typing(false);
        if (hide) imm.hideSoftInputFromWindow(getWindowToken(), 0);
        host.toPage(IME_RESET);
        if (debug && wasOpen) Log.i(TAG, "[Sonance] keyboard: closed (" + why + ")");
    }

    /** API 30+, on each layout (adjustResize relays the window out as the keyboard comes and goes). */
    private void checkIme() {
        WindowInsets insets = getRootWindowInsets();
        boolean visible = insets != null && insets.isVisible(WindowInsets.Type.ime());
        if (visible == imeVisible) return;
        imeVisible = visible;
        if (visible && keyboardOpen) {
            imeSeen = true;
        } else if (visible) {
            Log.w(TAG, "[Sonance] keyboard: shown without OK: hiding it");
            imm.hideSoftInputFromWindow(getWindowToken(), 0);
            host.toPage(IME_RESET);
        } else if (keyboardOpen && imeSeen) {
            closeKeyboard("hidden", false);
        }
    }
}
