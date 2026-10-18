package dev.simmo.sonance;

/**
 * The shim's only door into native code (ticket-3.xx-androidtv §2.6), exposed to the page as
 * window.SonanceNative. Its presence is how the shim knows it runs on the Android host (S1).
 *
 * S1: no methods yet. They arrive with the shim's parts: platform identity and key injection (S2),
 * playback (S3), and the service and audio focus (S4). @JavascriptInterface methods run on a
 * binder thread, never the UI thread.
 */
final class NativeBridge {
}
