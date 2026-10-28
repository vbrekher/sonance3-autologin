# Sonance v3.15 — report

**Version 3.15** (`config.xml` 3.15.0, Settings → About **V3.15**, APK versionName 3.15.0 and
versionCode 31500) adds an Android TV and Google TV app, from `tickets/prompt-3.xx-androidtv.md` /
`tickets/ticket-3.xx-androidtv.md` (requirements P1–P4, W1–W7, K1–K4, S1–S5, A1–A6, B1–B5 and V;
decisions D216–D235 in the ticket's §9). Built in five sessions on 2026-10-18 and 2026-10-19, on
the local branch `androidtv`, from `main` at 3.14 (`c4bd887`). Nothing is pushed, merged or tagged.

Your first SHIELD pass (2026-10-19) found two bugs: 24-bit FLAC played as static, and a remote key
ran away after a sign-out and sign-in. **Fix round 1** (`tickets/prompt-3.xx-androidtv-fix1.md`,
requirements X1–X5, decisions D236–D246, sessions F1 and F2 on 2026-10-19) fixed both, and took
your two decisions (§2): the sleep timer now fires in the background, and the keyboard opens only
on OK.

Every automated check ran on the Android SDK's Google TV emulator (Android 14, WebView 113).
**SHIELD re-test (2026-10-23 and 2026-10-28): passed.** 24-bit FLAC, the runaway key, the keyboard, the
background sleep timer and checklist items 3, 6 and 11 all work; Ogg Vorbis is untested (no files).
**§3 is the checklist for your SHIELD pass**; the fix round's re-test is its items 2, 3, 6, 11
and 13.

## 1. What shipped

- **An Android TV APK** (`android/`, built by `build-android.sh`). The system WebView runs the
  `.wgt`'s web payload, byte for byte, in a Java host on Android framework APIs only: no library,
  no Gradle. The host:
  - lays the page out at 1920 × 1080 CSS px, as on the Q90R, at any output (W2);
  - translates the remote's keys into Tizen's codes, so `focus.js` is unchanged (K1, K2);
  - plays through its own player behind a Tizen AVPlay shim, so the app runs its Tizen playback
    path, transcode rules included (A1–A6). Since fix round 1 (X1) that player is
    `MediaExtractor` and `MediaCodec` into an `AudioTrack` opened in the PCM encoding the decoder
    delivers, instead of `android.media.MediaPlayer` (§4.1, §4.7);
  - keeps the D-pad and OK away from the system keyboard unless Sonance opened it, opens the
    keyboard only on OK, and keeps the music playing while you type (X2, X4, X3);
  - keeps playing in the background through a `mediaPlayback` foreground service, and gives way to
    other apps' audio (B1, B2);
  - recovers from a lost WebView renderer without dying (W4), saves the queue when hidden (W5),
    and keeps the screen on only while playing (S5).
- **Two shared-code changes:** `SonancePlatform`, the platform seam (S3): Settings → About reads
  "Platform: Android TV 14" on the emulator, and Jellyfin's `Device=` is "Android TV", while on
  Tizen and in the browser both read as before. And (fix round 1, X5, D239) `SleepTimer` also
  checks its deadline on the player's progress events, so it fires in the background; on Tizen
  and in the browser it behaves as before.
- **Version 3.15** everywhere V lists (`config.xml`, About, the cache-bust) and in JellyfinAPI's
  `Version=` header (D234). Both `.wgt` packages are rebuilt; on Tizen only the version changes.
- **Packages:** `Sonance3.wgt` and `Sonance3-Oblong.wgt` (committed), and the debug APK
  `android/build/sonance-debug.apk` (local, not committed). **The release APK,
  `Sonance3-AndroidTV.apk`, is not built:** it is signed with your keystore, which no session
  creates or reads (§6).
- **Tests:** `e2e/android-shim.spec.ts` (37 tests, a fake bridge) and
  `e2e/sleep-timer-progress.spec.ts` (2) in the suite, now 425 tests; device checks
  `tests/tools/android-{keys,playback,background,engine,parity,devtools,seed-live}.js`.
- **Docs:** `docs/DEPLOYMENT-ANDROID-TV.md` (new), the README's "Android TV" section,
  `docs/ARCHITECTURE.md` §5a, the "Android TV" section of `CLAUDE.md`, `CHANGELOG-3.15.md`.

Commits on `androidtv`: S1 `fbfc3aa`, `03e86c3`, `71be9af`; S2 `a870540`, `ef4326a`, `fcae9a3`,
`5010557`; S3 `129aaf9`, `16f0bab`, `5b5afff`, `1197650`, `9374904`; S4 `59d0809`, `fa80b89`,
`84ebfb0`, `c9743de`, `0af9ab9`; S5 `1505b17` (version and packages) and the docs and report
commits after it.

## 2. Two decisions (taken in fix round 1)

Both were yours after S5; you chose on 2026-10-19, and fix round 1 F1 built them.

### 2.1 B4: the sleep timer while Sonance is in the background (decided: option 1, X5)

**Done (D239).** `SleepTimer` also checks its deadline on `Player`'s progress events. On the
emulator a 15-minute timer, set on Now Playing with Sonance then hidden, paused playback **0.2 s
after its deadline** (`android-background.js b4`). The text below is the S4 measurement that led
to the decision.

**Measured on the emulator.** A 15-minute sleep timer was set on Now Playing, and Home was pressed
1.3 s later. The deadline passed 15 minutes into the hidden period and nothing happened. Playback
stopped **181.6 s after the deadline**, 16 ms after the page became visible again, when the harness
brought Sonance back after 18 minutes. Had nobody come back, it would have played on. B4's
acceptance is "within 65 s of its deadline", so it is not met.

**Why.** WebView 113 stops a hidden page's timer chains about 5 minutes after it is hidden. A probe
(a 20 s `setTimeout` chain, plus a log of the player's native-driven `progress` events every 30 s)
showed the chain firing, about 1 s late each time, until 4.8 minutes after Home, then not at all
until the return. The `progress` events kept arriving the whole time: script that native code
starts keeps running, which is why background playback itself works.

**The options** (ticket §9, Session 4), smallest first:
1. **Shared code:** `SleepTimer` (`js/screens/nowplaying.js:171-240`) also checks its deadline on
   `Player`'s `progress` events, which keep arriving while anything plays, on Tizen too. Playback
   would stop within about 200 ms of the deadline on both platforms. It is a shared-code change,
   so it needs a D-number and the whole Tizen suite.
2. **Android only:** the host keeps the page "visible" while it plays in the background. That
   breaks W5 (the queue is saved when Sonance is hidden), so it is not recommended.
3. **Accept it:** the timer works in front; in the background it fires when you return.

Option 1 is the only one that meets B4, and the smallest change. Checklist item 13 shows whether
the SHIELD's newer WebView behaves the same; please choose after it.

### 2.2 D223: the keyboard reopens on Login (decided: it opens only on OK, X4)

**Done (D236, superseding D223).** The keyboard now opens only when you press OK on a field, as on
Tizen: not after a sign-out, not when moving between fields, and not when Sonance comes back to the
front. The text below is the S5 description that led to the decision.

If you leave Sonance (Home) while a Login field is selected, the TV keyboard opens again by itself
when you come back. WebView restores the keyboard for a focused text field when the window regains
focus; on Tizen it opens only on OK. Every Login function works, and one Back closes it. It is left
as it is: the keyboard is system UI, and Login is rarely seen.

**Do you want it changed?** The candidate fix is one manifest attribute on the activity,
`android:windowSoftInputMode="stateAlwaysHidden"`, untested. Checklist item 2 shows it.

## 3. SHIELD checklist (your final pass)

This is the first time Sonance runs on real hardware: the SHIELD's remote, NVIDIA's decoders,
4K output and a newer WebView. The emulator passes every automated check, which is necessary but
not sufficient.

### 3.1 Prepare the SHIELD and install

1. **Developer options:** Settings → Device Preferences → About → select **Build** seven times.
2. **Network debugging:** Settings → Device Preferences → Developer options → turn on **Network
   debugging**. Note the SHIELD's address (Settings → Network & Internet).
3. **Which APK.** Use the release APK, `Sonance3-AndroidTV.apk`, built with your keystore (§6
   steps 1–2): it is the one you will publish, and item 1 checks it. To try the build before
   making the keystore, use the debug APK, `android/build/sonance-debug.apk`; its signature
   differs, so run `adb uninstall dev.simmo.sonance` before installing the release APK later.
4. **Install from the Mac:**
   ```bash
   cd "/Users/agents/Agent Working Directory/sonance 3_AndroidTV"
   ADB=~/Library/Android/sdk/platform-tools/adb
   $ADB connect <shield-address>:5555        # on the SHIELD: "Allow network debugging?" → Always allow → OK
   $ADB install -r Sonance3-AndroidTV.apk    # or android/build/sonance-debug.apk
   ```
   **Downloader** (no computer) needs the APK at a web address, so it suits installs after the
   GitHub release (§6): install it from the Play Store, allow it under Settings → Device
   Preferences → Security & restrictions → Unknown sources, and enter the release asset's link
   (`docs/DEPLOYMENT-ANDROID-TV.md`, option B).
5. **The log,** for any failure: with the SHIELD connected,
   `$ADB logcat -d -s Sonance > ~/Desktop/sonance-shield.log`. It names the SHIELD's WebView version
   on its first line ("WebView …: screen … px"), and the app's events. It carries your server's
   address (as `scheme://host/path`) but no password or token.

### 3.2 The checklist

In order, with the SHIELD remote. For every item that fails, send what you saw, a photo of the
screen, and the log (§3.1 step 5); the item says what else helps.

1. **Install and launch.** The Sonance banner (the wide tile) is in the launcher's Apps row: the
   emulator's launcher could not show it (D219). On launch: no white flash, then the web splash,
   then a login screen that fills the screen.
   *Report:* a photo of the Apps row; whether any white frame or border showed.
2. **Sign in and browse.** Sign in to Navidrome with the TV keyboard: Next moves to the next field,
   and on the password field the action key signs in. Then browse every tab of Home, Library
   (Albums, Artists, Songs, Genres), Playlists, Queue, Search and Settings. Settings → About reads
   **V3.15** and "Platform: Android TV 11".
   *Also (fix round 1, X4 and X2):* the keyboard opens only on OK on a field, never by itself:
   after a sign-out, between fields with Down and Up, or when you select the Server field, press
   Home and return. Then sign out, sign in again (typing with the keyboard), and on Home press
   Right once: focus moves one step, and nothing keeps moving. With music playing, open the
   keyboard on Login: the music plays on (more quietly while the keyboard is up).
   *Report:* the field or key that did not work.
3. **Play.** Play an album. Pause, seek on the progress bar (Left and Right, ±10 s), and use next
   and previous, both with the on-screen controls and with the remote's Play/Pause, Rewind and
   Fast-forward.
   *Also, if your library has one:* a track the server cannot serve (for example a file moved or
   deleted since the last library scan) shows "… couldn't be loaded" within about 2 s and the next
   track plays. MediaPlayer alone would take 30 s; the host checks the stream's status after 2 s
   (D224).
   *Report:* which control or key did nothing, or did the wrong thing.
4. **Hold OK (the deciding K3 check).** Hold OK on a song: the options sheet opens after about half
   a second, and nothing plays. A short OK plays the song. The emulator could only hold OK with an
   injected key that has no repeats (`adb shell input keycombination`, D222); adb's own
   `--longpress` is a 400 ms hold, which is a short press by D207's 500 ms rule. Only a real remote
   decides it.
   *If it fails:* turn on Settings → Advanced → Performance overlay, open an album, hold OK on a
   song for two seconds, and photograph the overlay's key lines (top left, "keys, newest last").
5. **Lyrics and credits.** On Now Playing, open lyrics, then credits (ⓘ).
   *Report:* a photo of anything cut, misplaced or missing.
6. **Background and audio focus (the deciding B2 check).** Press Home while playing: the music
   continues. Open another app and play a video (YouTube, say): Sonance pauses. Return: Sonance
   shows paused, at the same place. The emulator could only simulate the other app with a second
   focus request from Sonance's own process (the drill, D228); a real app decides it.
   - While Sonance plays in the background, its notification is posted: "Sonance" with the track's
     title (D230; Android 13 and later, the emulator included, do not post it, because the app does
     not ask for the notification permission). Check with
     `$ADB shell dumpsys notification --noredact | grep -A4 "pkg=dev.simmo.sonance"`.
   - Leave it playing in the background past the screen-saver time: the screen saver may start, and
     the music keeps playing (the emulator keeps its screen on and never shows one).
   *Report:* whether it paused at all, whether it showed paused on return, and whether it played on
   by itself.
7. **Screen saver.** Leave Now Playing open while playing for 15 minutes: no screen saver. Pause:
   the screen saver starts after the SHIELD's usual timeout.
   *Report:* when the screen saver started.
8. **Exit.** Press Back to the root, choose "Exit Sonance?" and then Exit: the music stops.
   Relaunch: Sonance starts fresh, with the resume queue as set in Settings.
   *Report:* whether music kept playing after Exit.
9. **Reboot.** Reboot the SHIELD: you are still signed in, and your settings (interface size,
   accent colour) are kept.
10. **4K and 1080p.** Switch the SHIELD's output between 4K and 1080p (Settings → Device Preferences
    → Display & Sound → Resolution): Sonance still fills the screen exactly, at every Interface size.
    *Report:* a photo of any border, crop or blur.
11. **Codecs (A5).** Play one track of each format your library has, and fill the SHIELD column of
    the table in §4.1. In particular:
    - **24-bit FLAC (fix round 1, X1):** "Sad But True" (24/96) and "Back in Black" (24/192)
      sound right, with no static. The log (§3.1 step 5) has one `pcm` line per track, for
      example `player 7: pcm 16-bit -> 16-bit, 96000 Hz, 2 ch`.
    - **Ogg Vorbis (D226):** compare the total time Sonance shows with the real length, and seek
      near the end. Over HTTP MediaPlayer estimates a Vorbis file's length from its bitrate; on the
      emulator a 6 s file read 1.18 s.
    - **ALAC:** the emulator has no decoder, so it shows "format not supported" and skips. The
      SHIELD may have one.

    *Report:* the format, what happened (plays, the toast, silence), and for Vorbis the time shown
    against the real length. A format that plays on the Q90R but not here goes to ticket §8 Q3.
12. **Jellyfin.** Sign in to Jellyfin and play a track. Jellyfin's Dashboard → Devices lists
    "Sonance" on "Android TV".
13. **Sleep timer in the background (B4, §2.1; fix round 1, X5).** Set a 15-minute sleep timer on
    Now Playing, press Home, and leave Sonance in the background for 20 minutes: the music stops at
    about 15 minutes (on the emulator, 0.2 s after the deadline).
    *Report:* whether the music stopped at about 15 minutes, or only when you returned.
14. **(Optional) Another device.** Install on another Android TV or Google TV device (a Chromecast
    with Google TV, say) and repeat items 1–4 (ticket §8 Q5).

## 4. Results on the emulator

The `sonance-tv` AVD: Google TV, Android 14 (API 34, build `UTT1.240131.001.F1`), WebView
113.0.5672.136, 1920 × 1080 px at density 2.0, AOSP's software codecs.

### 4.1 Codecs (A5)

Through the shim, with 6 s samples generated by ffmpeg into a scratch folder (never committed). The
emulator column is fix round 1's engine (X1): the engine's `pcm` line (the encoding decoded, then
the AudioTrack's), which AudioFlinger's track for the app matched in format and rate every time
(`android-playback.js a5`).

| Format | Emulator (Android 14, AOSP software codecs) | SHIELD |
|---|---|---|
| FLAC 16/44.1 | Plays: `pcm 16-bit -> 16-bit, 44100 Hz, 2 ch` | Plays (re-test) |
| FLAC 24/96 | Plays at 16-bit (D244): `pcm 16-bit -> 16-bit, 96000 Hz, 2 ch` | Plays, no static (re-test) |
| FLAC 24/192 | Plays at 16-bit (D244): `pcm 16-bit -> 16-bit, 192000 Hz, 2 ch` | Plays, no static (re-test) |
| MP3 (192 kb/s) | Plays: `pcm 16-bit -> 16-bit, 44100 Hz, 2 ch` | |
| AAC (.m4a) | Plays: `pcm 16-bit -> 16-bit, 44100 Hz, 2 ch` | |
| ALAC (.m4a) | Fails at once: no decoder in AOSP (`no decoder for audio/alac`); the format toast | |
| Ogg Vorbis | Plays: `pcm 16-bit -> 16-bit, 44100 Hz, 2 ch`; the duration is a bitrate estimate (D226) | Not tested (no files) |
| Opus (transcoded) | Plays, as the server's MP3 (A4) | |
| WAV 16 | Plays: `pcm 16-bit -> 16-bit, 44100 Hz, 2 ch` | |
| WAV 24 | Plays at 16-bit (D244): `pcm 16-bit -> 16-bit, 44100 Hz, 2 ch` | |

Native Ogg Opus also plays (duration 0), but the app never uses it: Opus stays transcoded (D173).

**Why the SHIELD heard static, and why the emulator did not** (fix round 1, F2 T1). The SHIELD's
MediaPlayer took 24-bit FLAC from its FLACExtractor as float (`PCMe 4`) and opened its AudioTrack
as 16-bit (`format(0x1)`): Android 11 opens a non-offloaded sink as 16-bit whatever it is given.
On the emulator (Android 14) MediaPlayer's encodings agreed for every format: float into a float
track (`00000005`) for FLAC 24/96, 24/192 and WAV 24, and 16-bit (`00000001`) for the rest. The
new engine opens the track in the encoding the decoder reports. To an app's own process (rather
than to MediaPlayer's media server), Android's FLAC and WAV extractors deliver 24-bit files as
16-bit and say so (AOSP's `shouldExtractorOutputFloat`: float only for the media server's uid, on
Android 10, 11 and today), so 24-bit files play at 16-bit (D244). The output mixes to its own rate
anyway (48 kHz on the SHIELD, then E-AC3 to HDMI). **The sine probe** reads what the AudioTrack is
given: a −6 dBFS 1 kHz sine as 24/96 FLAC and as 16/44.1 FLAC reads peak 0.5000 and RMS 0.3536 for
both, as it should (0.50 ± 0.02, 0.354 ± 0.01).

### 4.2 Code-path audit (S2)

Every `Player.IS_TIZEN`, `typeof tizen`, `typeof webapis` and `window.webapis` site in `js/`, checked
at `5010557`. "In S2" means Android with the shim's `tizen.*` and `SonancePlatform`, but no
`webapis`; "from S3" means once the shim adds `webapis.avplay` and `webapis.appcommon`, which is
what ships. Every site keeps its Tizen path; none needed a deviation.

| Site | What it does | Android in S2 | Android from S3 |
|---|---|---|---|
| `app.js:255` | `registerTizenKeys` runs only if `tizen.tvinputdevice` exists | Runs: the shim defines it | Same |
| `app.js:266` | `tizen.tvinputdevice.registerKey(key)` for 12 media and colour keys | The shim's no-op; K1 translates the keys natively | Same |
| `app.js:1842` | `_exitApp` takes the Tizen branch if `tizen.application` exists | The Tizen branch | Same |
| `app.js:1844` | `tizen.application.getCurrentApplication().exit()` | The bridge's `exit()`: `finishAndRemoveTask()` (S4) | Also stops the player (S3) and the service (S4) |
| `jellyfin-api.js:120-121` | Jellyfin's `Device=` name | The seam (S3): `SonancePlatform.deviceName`, "Android TV". Without the seam it would read "Samsung TV", because the shim defines `tizen` | Same |
| `settings.js:326-328` | The About box's Platform row | The seam (S3): `SonancePlatform.platformLabel`, "Android TV 14" on the emulator. Without it, "Browser" in S2 and "Tizen 5.0" from S3 | Same |
| `nowplaying.js:622` | Sets `loading="lazy"` on the NP art when `webapis` is undefined | Lazy, as in the browser | Not lazy, as on Tizen |
| `player.js:24-25` | `IS_TIZEN`: `webapis.avplay` exists at load | false: the HTML5 path | true: the AVPlay path |
| `player.js:27` | Logs the backend | "Browser (HTML5 Audio)" | "Tizen (AVPlay)" |
| `player.js:236` | A transcode's seek reload (D174) | `_html5LoadAndPlay` | `_avplayLoadAndPlay` |
| `player.js:258` | `init`: the `<audio>` elements and the volume, HTML5 only | Set up | Skipped, as on Tizen |
| `player.js:270` | Logs `Tizen: IS_TIZEN` | false | true |
| `player.js:512-516` | `_suppressScreenSaver`: `webapis.appcommon.setScreenSaver` | Returns at once (no `webapis`) | The shim's `appcommon`: `FLAG_KEEP_SCREEN_ON` (S5) |
| `player.js:531` | `_avplayLoadAndPlay` reads `webapis.avplay` | Not reached | The shim's AVPlay (A1) |
| `player.js:725` | `_loadAndPlay` picks the backend | HTML5 | AVPlay |
| `player.js:976-978` | `play()`: resume a paused AVPlay | HTML5 | AVPlay |
| `player.js:1006-1007` | `pause()` | HTML5 | AVPlay |
| `player.js:1027-1029` | `stop()`: AVPlay stop and close | HTML5 | AVPlay |
| `player.js:1176-1178` | `seekTo()`: `avplay.seekTo(ms)` (never on a transcode, D173) | HTML5 | AVPlay |
| `player.js:1203-1208` | `setVolume()`: `tizen.tvaudiocontrol.setVolume` (no caller, so dead code) | The HTML5 branch | The shim's no-op |
| `player.js:1319` | `getActiveAudioElement()`: the `<audio>` element when not on Tizen | The element | null, as on Tizen |
| `player.js:1427` | Exports `IS_TIZEN` | false | true |

### 4.3 A missing or unreadable track (D224)

MediaPlayer's HTTP cache retries a failed request ten times, 3 s apart, and then reports an HTTP
error, an unreadable body and a missing decoder all alike (`1/-2147483648`). Measured on the
emulator, before D224:
- a 404 and a 500 each failed after **30.2 s**, as that generic error;
- an unreadable body failed in 23 ms, as the same error;
- ALAC prepared, then failed at `start()`.

The host now reads the stream's HTTP status itself (a one-byte GET to the same URL, on its own
thread, never logged) after 2 s of a pending prepare, and on a non-specific error before the stream
has played. Measured after: a 404 track shows "Track 02 — couldn't be loaded" after **2.0 s**
(`PLAYER_ERROR_CONNECTION_FAILED` at 2,058 ms), and an unreadable body shows "Track 03 — format not
supported" (`PLAYER_ERROR_NOT_SUPPORTED_FILE`). Both are skipped, and the next track plays.

### 4.4 Background playback, memory and the sleep timer (B3–B5)

**B3 and the soak** (`android-background.js soak 30 30`): a queue of 240 of the mock's 20 s WAV
tracks; 30 minutes in front with the UI browsed by D-pad every 15 s, then Home and 30 minutes with
the launcher in front, DevTools detached. 90 tracks started in the background, the last 30.0 minutes
after Home, one after another, with no error. The gap from a stream's `completed` to the next
stream's `started` (Logcat):

| Phase | Tracks | Median | Mean | Min | Max |
|---|---|---|---|---|---|
| Front (browsing) | 88 | 80 ms | 163 ms | 54 ms | 683 ms |
| Background | 90 | 47 ms | 56 ms | 29 ms | 163 ms |

B3's acceptance, read strictly (the worst background gap against the front's median plus 1.5 s),
holds with 1.4 s to spare. The service ran and the process kept one pid for the hour. The first
soak attempt was lost to the emulator, not the app: its own process hung and exited with signal 11
after 29 minutes (the app had played 86 tracks with no error); the rerun passed.

**B5** (`dumpsys meminfo`; the emulator's total RAM is 2,025,912 K). Indicative only: a real
device's WebView and drivers differ.

| When | Host PSS | Host RSS | Renderer PSS | Renderer RSS | Free RAM |
|---|---|---|---|---|---|
| After 30 min browsing and playing | 83,679 K | 218,436 K | 84,812 K | 199,632 K | 843,062 K |
| After the 60-minute soak (30 min in the background) | 83,487 K | 218,364 K | 87,996 K | 203,288 K | 798,876 K |

**B4:** met since fix round 1 (X5): 0.2 s after the deadline, hidden (§2.1).

### 4.5 A known race (D227)

If another app takes the audio while a track is still loading, the host holds that track's start,
so Sonance cannot play over the other app (`player.js` plays on prepare whatever happened
meanwhile). One race is left as it is: a track that ends in the same few milliseconds as the focus
loss arrives. Its `completed` is already on its way, so the app advances and the next track plays.
Item 6 would show it as Sonance playing on after the other app starts; it should be very rare.

### 4.6 Other emulator results

- **Viewport (W2):** `innerWidth` 1920, `innerHeight` 1080, `clientWidth` 1920, no page scroll, page
  scale 0.5 at DPR 2. At 100 % and 150 %, every non-text box (cards, art, the NP bar and controls,
  the progress bar) is within ±2 CSS px of desktop Chromium; boxes that follow text widths differ by
  the font (G1).
- **Keys (K1):** all 26 keys in K1's table arrive as specified; BACK at the root opens "Exit
  Sonance?", and Exit ends the task (K2). Hold OK for 800 ms opens the sheet (K3, D222).
- **Playback (A1–A6, S5):** play, pause, seek, resume, the next track at the end (52 ms from
  `completed` to the next `prepared`), ticks at 5 Hz, the transcode's seek by reload, a resumed
  queue starting at its saved position, and `KEEP_SCREEN_ON` only while playing.
- **Background (B1, B2):** the service starts on the first play in front, keeps one record across
  tracks, and stops on Exit, renderer loss and task removal; the focus drill's loss, transient loss,
  regain and duck behave as B2 says.
- **Renderer loss (W4):** `chrome://crash` recovers to a fresh app with the same process.

### 4.7 The engine (fix round 1, X1)

`PlayerEngine` on `MediaExtractor`, `MediaCodec` and `AudioTrack` (D240–D245), on the final debug APK of fix round 1
(`443f134`). Every check in §4.1–§4.6 ran again on it and passes; these are the engine's own
(`tests/tools/android-engine.js`, and `android-playback.js level`):

| Check | Result |
|---|---|
| The sine probe (−6 dBFS 1 kHz; 24/96 and 16/44.1 FLAC) | peak 0.5000, RMS 0.3536 at the AudioTrack's input, both |
| 10 missing tracks in a row | each "couldn't be loaded" within 2.0 s; their decode threads gone 28.6 s after the last |
| A FLAC and an MP3 cut off halfway | a connection error after 7.5 s and 8.5 s of play, never "completed" (D242) |
| 0.3 s and 6 s files, also paused in their last 300 ms | each completes once; after a resume, 164 ms and 190 ms later |
| A 6 s 8 kHz mono WAV, read in 2 s samples | completes once (a first version took it for cut off, D242) |
| A live-transcode stand-in (chunked, no frame count) | duration 0, plays to its end, completes once |
| A 5 s stall partway | one `bufferingstart` and one `bufferingcomplete`, then the end; 20 normal tracks: none (D243) |
| 200 tracks skipped | at most 1 decode thread at a time; then 1 AudioFlinger track and 1 codec; native heap +4.3 MB allocated |
| 50 random open/prepare/play/seek/pause/close cycles | no exception, no event from a closed session |
| Seeks (`a1`, `a6`) | `seeked` reports the target exactly; the first tick 181–226 ms after it |
| `soak 15 15` (15 min in front, browsing; 15 min hidden) | 45 tracks in the background; from "completed" to the next "started", a median of 196 ms in front and 24 ms hidden; no error |

## 5. What was not done

- **The release APK** (`Sonance3-AndroidTV.apk`): it needs your keystore (§6). The debug APK is
  built and passes every gate.
- **The SHIELD pass** (§3): yours. Your first pass led to fix round 1
  (`tickets/prompt-3.xx-androidtv-fix1.md`); its re-test (items 2, 3, 6, 11 and 13) passed on
  2026-10-23 and 2026-10-28. Ogg Vorbis on the SHIELD is still to test.
- **D226** (Ogg Vorbis's estimated duration) and **ALAC**: no rule changed; item 11 and ticket §8
  Q3 decide. On the new engine Vorbis still reads 1,177 ms for a 6 s file, and a seek lands in
  proportion to the real length.
- **24-bit resolution** (D244): 24-bit FLAC and WAV play at 16-bit. Keeping 24 bits would need
  Sonance's own FLAC and WAV parsing, because Android gives an app's extractor no deeper samples;
  not planned.
- **Unexercised on the emulator** (fix round 1): the engine's float AudioTrack and its conversion
  of 24- and 32-bit integer PCM (no AOSP extractor or decoder gives an app those, D244; they are
  there for a device's own decoders, which item 11's `pcm` lines show); Gboard's own audio focus
  while typing (the emulator's Gboard takes none; the focus drill stood in, X3); the keyboard
  backstop, a keyboard that shows without OK (no emulator path shows one, X4).
- **Not checkable on the emulator,** so on the checklist: the launcher banner (item 1), a real
  remote's hold and repeats (item 4), a real app taking the audio and the posted notification
  (item 6), Ambient Mode (items 6 and 7), 4K output (item 10), NVIDIA's decoders (item 11).
- **Non-goals** (ticket §4): MediaSession and the now-playing card, Google Play, phones and tablets,
  on-screen colour-key actions (§8 Q2), a bundled font (§8 Q1), raising targetSdk (§8 Q4).

## 6. Release steps (yours)

1. **Create the release keystore,** once, outside the repository, and back it up with its password.
   Losing it means no user can upgrade (`docs/DEPLOYMENT-ANDROID-TV.md`, "The release keystore"):
   ```bash
   keytool -genkeypair -v -keystore ~/sonance-release.jks -alias sonance -keyalg RSA -keysize 4096 -validity 10000
   ```
2. **Build the release APK** on the branch:
   ```bash
   cd "/Users/agents/Agent Working Directory/sonance 3_AndroidTV"
   export SONANCE_KEYSTORE=~/sonance-release.jks SONANCE_KEY_ALIAS=sonance
   read -rs SONANCE_KEYSTORE_PASS && export SONANCE_KEYSTORE_PASS
   export SONANCE_KEY_PASS="$SONANCE_KEYSTORE_PASS"
   ./build.sh && ./build-android.sh --release
   ```
   It must end with `apksigner verify: OK` and the badging line, and write `Sonance3-AndroidTV.apk`.
3. **Run the SHIELD checklist** (§3) with that APK. If anything fails, stop here: a fix round
   comes first.
4. **Commit the APK and merge** (the port is proven on the SHIELD):
   ```bash
   git add Sonance3-AndroidTV.apk
   git commit -m "Sonance3-AndroidTV.apk 3.15.0, release-signed (V)"
   git checkout main
   git merge --no-ff androidtv -m "Merge androidtv: Sonance 3.15, Android TV"
   git push origin main
   git tag -a v3.15 -m "Sonance 3.15"
   git push origin refs/tags/v3.15
   ```
   The Tizen working copy (`…/sonance 3`) then needs `git pull` before its next session.
5. **The GitHub release:**
   1. Open Releases and choose **Draft a new release**.
   2. Pick the tag `v3.15` and title it **Sonance 3.15**.
   3. For the description, paste `CHANGELOG-3.15.md`.
   4. Attach `Sonance3.wgt`, `Sonance3-Oblong.wgt` and `Sonance3-AndroidTV.apk`.
   5. Tick **Set as the latest release**, then choose **Publish**.

## 7. Verification (S5, 2026-10-19)

The suites ran with the emulator shut down, as S4's baseline did. The device checks ran on the final
debug APK (3.15.0, 31500), on the emulator, before the suites; no app file changed after them.

```
baseline (S4, 0af9ab9)           417 passed at 150 % (24.7m) and at 100 % (24.6m)
final, 150 %                     417 passed (25.4m)  exit=0
final, 100 %                     417 passed (25.0m)  exit=0
final, 200 % subset              97 passed (5.7m)  exit=0  (focus-paths 14, npbar 15, ui-scale 21,
                                 options-sheet 16, android-shim 31)
intermittents                    none appeared
./build.sh                       exit 0, with its gates (no ?. / ?? in the bundles; no
                                 backdrop-filter, transition: all or bare gap: in the CSS);
                                 index.html bundled, v3-15 on its three tags; in both packages
                                 version="3.15.0" and V3.15 in the bundle (V3.14: 0); icon.png
                                 256 x 256 (square) and 1920 x 1080 (oblong)
./build-android.sh --debug       exit 0: payload 4 files, identical to Sonance3.wgt; dex 38 classes,
                                 all in dev.simmo.sonance; apksigner verify OK; badging
                                 LEANBACK_LAUNCHER, banner, sdkVersion 26, targetSdkVersion 35;
                                 versionCode='31500' versionName='3.15.0'; 196K
./build-android.sh --release     not built: the four SONANCE_* variables are not set; without
                                 them it exits 1 and names all four
version grep                     v3-14 / V3.14 / 3.14.0 in index.html, tests/mock-index.html,
                                 build.sh, config.xml, settings.js, jellyfin-api.js and its spec:
                                 none
node --check                     11 files ok (the shim, jellyfin-api.js, settings.js, both
                                 bundles, the six tests/tools/android-*.js)
regression greps                 innerHTML: the nowplaying.js comment only; transition: all: the
                                 :90 comment only; layout transitions, backdrop-filter, gap:,
                                 max()/min()/clamp(), setInterval, zoom: none; .np-bg-image: no
                                 transform, no transition
device (emulator, final APK)     k1: PASS (26/26 keys as K1's table); a1: PASS; b1: PASS (9/9);
                                 b2: PASS (10/10); Settings -> About "V3.15", "Platform: Android TV 14"
docs                             every backticked path exists; no IPv4 address, credential or
                                 keystore value; the commands checked (below)
```

Commands from the docs, checked: `./build-android.sh --release` without the variables (exit 1, all
four named); `read -rs` in zsh and bash; `keytool -genkeypair -help` lists every option used; `adb
help` lists `connect`, `pair`, `install -r` and `uninstall`; on the emulator, `adb uninstall
dev.simmo.sonance` and `adb install -r android/build/sonance-debug.apk` (Success), and `adb logcat -d
-s Sonance`, whose first line is `[Sonance] WebView 113.0.5672.136: screen 1920 px, initialScale 100,
textZoom 100, debug true`. `dumpsys notification --noredact` runs, but the emulator had no posted
notification of any app, so item 6's `pkg=` line is first seen on the SHIELD.

Screenshot (read back): `screenshots/androidtv/s5-settings-about.png`, Settings on the emulator
with the About box reading V3.15 and "Platform: Android TV 14". Earlier sessions' captures are in
the same folder (local, not committed).

### 7.1 Fix round 1 (F1 and F2, 2026-10-19)

F1 changed shared web code (X5's `SleepTimer`), so it ran the whole suite; F2 changed none (no file under `js/`, `css/`
or `index.html`, nor the shim or any spec), so it ran `e2e/android-shim.spec.ts` alone. The device checks ran on each
session's final debug APK.

```
F1, suites                       425 passed at 150 % (25.0m) and at 100 % (25.0m); the 200 % subset 103 (5.1m)
F1, device                       k5 23/23, x3 5/5, k1 26/26, k3, w5, w4, b1 9/9, b2 10/10, b4 (0.2 s after the deadline)
F2, e2e/android-shim.spec.ts     37 passed at 150 % (19.3s) and at 100 % (19.3s), unchanged since F1
F2, ./build-android.sh --debug   exit 0: payload 4 files, identical to Sonance3.wgt; dex 49 classes, all in
                                 dev.simmo.sonance; apksigner verify OK; badging LEANBACK_LAUNCHER, banner,
                                 sdkVersion 26, targetSdkVersion 35; 3.15.0 (31500)
F2, device (final APK 443f134)   a1, a3, a4, a5 (format check), a6, s5, w4, level; bad10, cut, ends, stall,
                                 skip200, cycles; b1 9/9, b2 10/10, x3 5/5; k1 26/26, k3, k5 23/23, w5: all PASS
F2, soak 15 15                   PASS: 45 tracks hidden, the last 14.9 min after Home; gaps (completed to started) a median
                                 of 196 ms in front (max 875) and 24 ms hidden (max 54); one pid, no error
F2, hygiene                      node --check on the shim and the three harness files; the regression greps hold
```

## 8. Decisions

D216–D235 (the programme) and D236–D246 (fix round 1), each with its reason, and how each
requirement's acceptance was read: `tickets/ticket-3.xx-androidtv.md` §9.
