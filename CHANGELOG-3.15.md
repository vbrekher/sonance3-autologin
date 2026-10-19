# Sonance 3.15

**Samsung TV:** install **one** package: `Sonance3.wgt` (square icon) or `Sonance3-Oblong.wgt` (wide home-row tile). **Android TV and Google TV:** install `Sonance3-AndroidTV.apk`. Settings → About reads **V3.15**.

3.15 brings Sonance to Android TV and Google TV. On the Samsung TV nothing changes but the version number.

## New

- **Sonance for Android TV and Google TV.** The same app, screens, settings and remote behaviour as on the Samsung TV, on any Android TV or Google TV device from Android 8.0: a TV, a streaming box such as the NVIDIA SHIELD, or a Chromecast with Google TV. It is sideloaded with `adb`, the Downloader app or Send Files to TV; `docs/DEPLOYMENT-ANDROID-TV.md` has the steps. Settings → About reads "Platform: Android TV" and the Android version, and Jellyfin lists the device as "Android TV".
- **Music keeps playing in the background.** Press Home or open another app, and Sonance plays on through the queue. When another app plays sound (a video, say), Sonance pauses, and shows paused when you come back; a short interruption, such as a notification sound, lowers the volume or pauses only for as long as it lasts.
- **The remote works as on the Samsung TV:** arrows, OK, Back and, where the remote has them, Play/Pause, Stop, Rewind, Fast-forward and the colour keys. Hold OK on a song for the options menu.

### Known differences on Android

- The text is in the system font (Roboto), because Samsung's SamsungOne font is not available. The layout is the same.
- The album's Yellow and Blue actions need a remote with colour keys; the SHIELD and Google TV remotes have none.
- There is no now-playing card on the Google TV home screen, and the media keys work while Sonance is in front, as on the Samsung TV. On Android 13 and later the playback notification is not shown.
- ALAC (Apple Lossless) plays only on devices that add their own decoder. Ogg Vorbis tracks may show an estimated length.
- With Sonance in the background, the sleep timer may not stop playback until you return to Sonance. A fix is being decided.

## For developers

- **`android/`**: a Java host on Android framework APIs only (no androidx, Media3, Leanback, Kotlin or Gradle). `MainActivity` hosts the `.wgt`'s web payload, byte for byte, in the system WebView at a 1920×1080 CSS viewport and translates the remote's keys into Tizen's key codes; `PlayerEngine` plays through `android.media.MediaPlayer` on its own thread and holds the audio focus; `PlaybackService` is the `mediaPlayback` foreground service. targetSdk is pinned at 35, minSdk 26.
- **The shim, `android/shim/webapis.js`**, served at `$WEBAPIS/webapis/webapis.js`, provides `webapis.avplay`, `webapis.appcommon` and the `tizen.*` calls over the host's bridge, so the app runs its Tizen (AVPlay) code path unchanged. Without the bridge it does nothing.
- **Shared code:** one seam, `SonancePlatform`, names the platform in Settings → About and in Jellyfin's `Device=` header. The Tizen package is otherwise unchanged. JellyfinAPI's `Version=` is 3.15.0.
- **Build:** `./build-android.sh --debug | --release` calls the SDK's aapt2, javac, d8, zipalign and apksigner directly. It fails if the APK's web payload differs from `Sonance3.wgt`, if the dex holds a class outside `dev.simmo.sonance`, or if the launcher entries or SDK levels are wrong. A release build is signed with your own keystore, from four `SONANCE_*` variables.
- **Tests:** `e2e/android-shim.spec.ts` (31 tests) drives the shim with a fake bridge; the suite has 417 tests. Device checks run on the Android SDK's Google TV emulator: `tests/tools/android-{keys,playback,background,parity,devtools,seed-live}.js`.
- **Report:** `docs/v3-15-report.md`, with the checklist for the first run on a real device.
