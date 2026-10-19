# Deployment Guide — Sonance on Android TV and Google TV

Sonance 3.15 runs on Android TV and Google TV as an APK: the same app as the Samsung version, in
the system WebView inside a small native host (`android/`, ticket `tickets/ticket-3.xx-androidtv.md`).
It is sideloaded; it is not on Google Play. Developed on the Android SDK's Google TV emulator
(Android 14) for an NVIDIA SHIELD TV Pro (2019, Android 11).

## Prerequisites

- An **Android TV or Google TV** device on **Android 8.0 or later** (a TV, a streaming box or a
  dongle). Phones and tablets are not supported: the app is for TV remotes only.
- A **Navidrome** (or Subsonic-compatible) or **Jellyfin 12.x** server on the same network.
- The APK:
  - `Sonance3-AndroidTV.apk`, from the [latest release](https://github.com/MrSimmo/sonance3/releases/latest),
    signed with the project's release key; or
  - one you build yourself (see [Building the APK](#building-the-apk)).
- To install from a computer: `adb`, from Google's
  [SDK Platform-Tools](https://developer.android.com/tools/releases/platform-tools).

## Step 1: Enable developer options

Needed for `adb`. The Downloader route (Step 2, option B) needs only "unknown sources".

**NVIDIA SHIELD:**
1. Settings → Device Preferences → About.
2. Select **Build** seven times, until it says you are a developer.
3. Settings → Device Preferences → Developer options → turn on **Network debugging** (or **USB
   debugging** when the SHIELD is cabled to the computer).

**Google TV** (Chromecast with Google TV, Google TV Streamer, Google TV televisions):
1. Settings → System → About.
2. Select **Android TV OS build** seven times, until it says you are a developer.
3. Settings → System → Developer options → turn on **USB debugging**. Some devices call it
   **Network debugging** or **Wireless debugging**; with Wireless debugging, pair first (Step 2).

**Other Android TV devices:** the same steps, under Settings → Device Preferences → About (or
Settings → System → About).

Find the device's IP address under Settings → Network & Internet, on the active connection.

## Step 2: Install

### Option A: adb from a computer

```bash
adb connect <tv-address>:5555
adb install -r Sonance3-AndroidTV.apk
```

With **Wireless debugging**, pair first: the TV shows a pairing code, an address and a port; run
`adb pair <tv-address>:<pairing-port>` with that code, then `adb connect` to the address and port the
Wireless debugging screen shows.

The first `adb connect` shows "Allow debugging?" on the TV: choose **Always allow from this
computer**, then **OK**. `adb devices` should list the device as `device`, not `unauthorized`.

### Option B: the Downloader app

1. On the TV, install **Downloader** (by AFTVnews) from the Play Store.
2. Allow it to install apps: Settings → Apps → Security & restrictions → **Unknown sources** →
   Downloader on (on the SHIELD: Settings → Device Preferences → Security & restrictions). The
   path varies by device; on some, Android asks the first time Downloader opens an APK.
3. In Downloader, enter the APK's download address (on the GitHub release page, the
   `Sonance3-AndroidTV.apk` asset's link) and choose **Go**, then **Install**.
4. Delete the downloaded APK when Downloader offers to.

### Option C: Send Files to TV

1. Install **Send Files to TV** on a phone and on the TV.
2. Send `Sonance3-AndroidTV.apk` from the phone. It lands in the TV's Download folder.
3. Open it on the TV with a file manager that is allowed to install apps (Unknown sources, as in
   option B), and choose **Install**.

## Step 3: First run

1. Open **Sonance** from the Apps row. Its banner is the wide Sonance tile.
2. The login screen opens. Select each field and type with the TV keyboard:
   - **Server:** the address, with `http://` or `https://`;
   - **Port:** Navidrome's (4533 by default) or Jellyfin's (8096 by default);
   - **Username** and **Password** (on Jellyfin, leave the password empty if the account has none).

   The keyboard's **Next** moves to the next field, and on the password field its action key
   signs in. **Back** closes the keyboard first, then leaves the field.
3. You are in. The remote works as on the Samsung version: arrows, OK, Back, and
   Play/Pause, Rewind and Fast-forward where the remote has them. Hold OK on a song for the options
   menu.

Music keeps playing after you press Home or open another app. It pauses when another app plays
sound (a video, say) and shows paused when you come back.

## Updating

Install the new APK over the old one. Your sign-in and settings are kept.

```bash
adb install -r Sonance3-AndroidTV.apk
```

Downloader and Send Files to TV update the same way: install the new file.

**The new APK must be signed with the same key as the installed one.** Otherwise Android refuses
the update (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`), and the only way forward is to uninstall
first (`adb uninstall dev.simmo.sonance`), which deletes the sign-in and settings. A debug build
and a release build have different keys, so switching between them also needs the uninstall.

## Building the APK

The build uses the Android SDK's own tools, with no Gradle and no downloads.

Needs:
- the Android SDK, at `$ANDROID_HOME` or `~/Library/Android/sdk`, with `build-tools;36.0.0`,
  `platforms;android-35` and `platform-tools`;
- a JDK 17 or later (`javac`, `keytool`), on `PATH` or at `$JAVA_HOME`;
- what `./build.sh` needs: `bash`, `zip`, `perl` and Node.js with `npx`.

```bash
./build.sh                       # the .wgt packages: the APK's web payload comes from Sonance3.wgt
./build-android.sh --debug       # android/build/sonance-debug.apk, signed with a local debug key
```

`build-android.sh` names any tool it cannot find. A debug build is debuggable and turns on WebView
DevTools; keep `android/build/debug.keystore`, which the first debug build generates, or the next
debug build cannot update the installed one.

### The release keystore

A release build (`./build-android.sh --release`) is signed with your own keystore.

> **Keep the keystore and its password safe, and back them up.** Every update of the app must be
> signed with the same key. If the keystore is lost, no later version can be installed over the
> existing one: every user has to uninstall Sonance, losing their sign-in and settings, and
> install a build signed with a new key.

Create it once, outside the repository. `keytool` asks for a password and a name:

```bash
keytool -genkeypair -v -keystore ~/sonance-release.jks -alias sonance -keyalg RSA -keysize 4096 -validity 10000
```

The build reads four variables, and never prints them:

| Variable | Value |
|---|---|
| `SONANCE_KEYSTORE` | the keystore's path |
| `SONANCE_KEYSTORE_PASS` | the keystore's password |
| `SONANCE_KEY_ALIAS` | the key's alias (`sonance` above) |
| `SONANCE_KEY_PASS` | the key's password; for a keystore made as above (PKCS12), the keystore's password |

```bash
export SONANCE_KEYSTORE=~/sonance-release.jks SONANCE_KEY_ALIAS=sonance
read -rs SONANCE_KEYSTORE_PASS && export SONANCE_KEYSTORE_PASS      # type the password; nothing echoes
export SONANCE_KEY_PASS="$SONANCE_KEYSTORE_PASS"
./build.sh && ./build-android.sh --release                         # Sonance3-AndroidTV.apk
```

Without all four, `--release` stops and names the missing ones. `.gitignore` ignores `*.jks` and
`*.keystore`, but keep the keystore out of the project folder anyway.

## Troubleshooting

### "Cannot reach server" on login
- Check the address and port as for the Samsung version (`docs/DEPLOYMENT.md`).
- Plain `http://` servers work: the app allows unencrypted connections to any server.
- An `https://` server needs a certificate the device trusts. The app trusts the system's
  certificates only: a self-signed certificate, or one installed by the user, is refused.

### Signs in, but nothing loads (Jellyfin)
Jellyfin allows any origin by default. If Dashboard → Networking → **CORS hosts** has been
restricted, add `*`: the app's pages come from the device itself (`file://`), so they have no
ordinary web origin. Navidrome allows any origin by default.

### A track shows "format not supported" and is skipped
Android plays FLAC (24-bit and up to 192 kHz from Android 10), MP3, AAC, Ogg Vorbis, WAV and,
through the server, Opus. **ALAC** (Apple Lossless, `.m4a`) depends on the device: Android itself
has no ALAC decoder, so it plays only where the device maker added one. Converting those files to
FLAC, which is lossless too, makes them play everywhere.

### An Ogg Vorbis track's time or progress bar is off
Android estimates an Ogg Vorbis file's length from its bitrate while streaming, so the total time
and the progress bar can be off, and a seek cannot go past the estimated length. Other formats
are exact.

### The update is refused
`INSTALL_FAILED_UPDATE_INCOMPATIBLE`: the APK is signed with another key. See [Updating](#updating).

### Known differences from the Samsung version
- **Font:** Samsung's SamsungOne font is not available, so the text is in the system font
  (Roboto). The layout is the same.
- **Album colour-key actions:** Yellow and Blue on an album's Play and Shuffle buttons need a
  remote with colour keys. The SHIELD and Google TV remotes have none.
- **Media keys** work while Sonance is in front, as on the TV. There is no now-playing card in the
  Google TV home screen.
- **Notification:** on Android 13 and later, the playback notification is not shown (the app does
  not ask for the notification permission). Playback is unaffected.
- **Sleep timer in the background:** with Sonance in the background, the sleep timer may not stop
  playback until you return to Sonance (see `docs/v3-15-report.md`, B4).
- **The keyboard on Login:** if you leave Sonance while a Login field is selected, the keyboard
  opens again when you return. Press Back to close it.
