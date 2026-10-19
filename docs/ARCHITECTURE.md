# Sonance — Architecture Document

## 1. Overview

Sonance is a music player application for Samsung Tizen Smart TVs that connects to a self-hosted Navidrome music server via the Subsonic REST API. It is designed specifically for TV remote (d-pad) navigation and optimised for the Samsung Q90R (Tizen 5.0, 1920×1080).

### Key Constraints
- **No build tooling.** The app is vanilla HTML/CSS/JS — no React, no Webpack, no npm runtime dependencies. This keeps packaging trivial (zip → rename to .wgt) and ensures compatibility with Tizen 5.0's Chromium ~v63 WebView.
- **D-pad only input.** All interaction is via Samsung TV remote: directional arrows, Enter, Back, media keys.
- **LAN-only networking.** The TV connects to Navidrome on the local network. No internet dependency at runtime (except optional cover art from external sources if Navidrome proxies them).

## 2. System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Samsung Q90R TV                          │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐  │
│  │              Tizen WebView (Chromium ~v63)              │  │
│  │                                                        │  │
│  │  ┌──────────────────────────────────────────────────┐  │  │
│  │  │               Sonance Web App                     │  │  │
│  │  │                                                   │  │  │
│  │  │  index.html ──┬── css/styles.css                  │  │  │
│  │  │               ├── js/app.js (Router + Init)       │  │  │
│  │  │               ├── js/api.js (Subsonic Client)     │  │  │
│  │  │               ├── js/auth.js (Session Mgmt)       │  │  │
│  │  │               ├── js/focus.js (D-Pad Nav)         │  │  │
│  │  │               ├── js/player.js (Audio Engine)     │  │  │
│  │  │               ├── js/screens/*.js (UI Screens)    │  │  │
│  │  │               └── js/utils.js (Helpers)           │  │  │
│  │  └──────────────────────────────────────────────────┘  │  │
│  └────────────────────────────────────────────────────────┘  │
│                            │                                  │
│                     HTTP (LAN)                                │
│                            │                                  │
└────────────────────────────┼──────────────────────────────────┘
                             │
                   ┌─────────▼─────────┐
                   │   Navidrome Server │
                   │   (192.168.0.2)    │
                   │                    │
                   │  /rest/* Subsonic  │
                   │  /api/*  Native    │
                   │                    │
                   │  Music Library     │
                   │  (FLAC/MP3/etc)    │
                   └────────────────────┘
```

## 3. Application Layer Architecture

### 3.1 Router (app.js)
Simple hash-based or state-based SPA router. Manages which screen is active.

```
Screens:
  login      → LoginScreen      (shown when no session)
  home       → HomeScreen       (default after login)
  library    → LibraryScreen    (albums/artists/songs/genres tabs)
  album      → AlbumScreen      (album detail + tracklist)
  search     → SearchScreen     (on-screen keyboard + results)
  nowplaying → NowPlayingScreen (full-screen player)
  queue      → QueueScreen      (up next list)
  playlists  → PlaylistsScreen  (playlist grid)
  settings   → SettingsScreen   (server info, logout)
```

### 3.2 SubsonicAPI (api.js)
Single class handling all Navidrome communication.

**Authentication:**
- Token auth: `token = MD5(password + salt)`
- Every request includes: `u`, `t`, `s`, `v=1.16.1`, `c=Sonance`, `f=json`
- Salt is a random 12-char hex string, regenerated per request

**Key Endpoints Used:**
| Method | Subsonic Endpoint | Purpose |
|--------|-------------------|---------|
| ping | `ping.view` | Connection/auth validation |
| getArtists | `getArtists.view` | All artists (ID3) |
| getArtist | `getArtist.view` | Artist detail + albums |
| getAlbum | `getAlbum.view` | Album detail + tracks |
| getAlbumList2 | `getAlbumList2.view` | Album lists (recent, frequent, newest, random) |
| search3 | `search3.view` | Full-text search |
| getPlaylists | `getPlaylists.view` | User playlists |
| getPlaylist | `getPlaylist.view` | Playlist detail + tracks |
| getGenres | `getGenres.view` | Genre list |
| getSongsByGenre | `getSongsByGenre.view` | Songs filtered by genre |
| stream | `stream.view` | Audio stream URL |
| getCoverArt | `getCoverArt.view` | Album/artist artwork |
| scrobble | `scrobble.view` | Mark song as played |
| star/unstar | `star.view` / `unstar.view` | Favourites |
| getStarred2 | `getStarred2.view` | Starred items |

**Response Handling:**
- All responses parsed as JSON (`f=json`)
- Check `subsonic-response.status === 'ok'`
- On error, surface `subsonic-response.error.message` to UI
- Network errors caught and shown as connection failure toast

### 3.2a JellyfinAPI (jellyfin-api.js) — v3.13
A second backend behind the same surface, by **translation**, not a second client. `JellyfinAPI`
inherits `SubsonicAPI.prototype` and replaces the transport: `_request(endpoint, params, opts)`
hands each Subsonic endpoint name the app uses (`getAlbumList2.view`, `search3.view`, …) to a
translator that calls Jellyfin 12.x and resolves to the same `subsonic-response` body the public
methods already parse. So both caches (memory LRU and the localStorage tier), in-flight joining,
`abortAll`, the library fan-out and merges, the album-list cursor (D23–D25), the song pager and the
memoised fields run unchanged for both servers, and the screens see the same objects
(ticket-3.xx-jellyfin P1, R4–R10; decisions D184–D201 in its §9).

- **Auth:** API calls carry `Authorization: MediaBrowser Client="Sonance", Device=…, DeviceId=…,
  Version="3.13.0", Token=…` (values URL-encoded). Stream URLs carry `ApiKey=`; image URLs carry
  nothing (anonymous on Jellyfin). The legacy query key and `X-Emby-*` headers are never sent
  (12.x answers them 401).
- **Overridden whole:** the constructor, `ping` (`/System/Info`; one silent re-sign-in on 401),
  `getStreamUrl` (`/Audio/{id}/stream?static=true`, or `stream.mp3` with `startTimeTicks` for a
  transcode), `getCoverArtUrl` (`/Items/{id}/Images/Primary`, the image tag carried inside
  `coverArt`), `savePlayQueue`/`getPlayQueue` (the queue is kept on the TV), `countAlbums` and the
  song pager's count (one `TotalRecordCount` request, D197), `clearMemoryCache`; `_buildUrl` throws.
- **Translator-private sub-requests** (the played-tracks aggregate behind Recently/Most played,
  the artist name lookup, the item fetch shared by an artist page) go through `_cachedRequest`
  under `jf:` endpoint names, so logout and library changes clear them with everything else.
- **The one seam in api.js:** `SubsonicAPI._trackRequest(rec)` puts an adapter fetch in the
  open-request registry, so `SubsonicAPI.abortAll()` cancels it (D196).
- **Selection:** `AuthManager` builds a `JellyfinAPI` when `sonance_backend` is `jellyfin`,
  otherwise a `SubsonicAPI` exactly as before. Login detects the server: the Subsonic login first;
  on a not-Subsonic failure (404, invalid response) a `GET /System/Info/Public` probe; with an empty
  password the probe first (§3.3).
- **Tests:** the mock answers as Jellyfin (`?mockBackend=jellyfin`) from the same fixtures;
  `e2e/jellyfin-parity.spec.ts` compares the two backends screen by screen and
  `e2e/navidrome-identity.spec.ts` holds every Navidrome request to 3.12's.

### 3.3 Auth Manager (auth.js)
Manages login/logout and session persistence. Since v3.13 it also selects the backend and keeps
the Jellyfin session (`sonance_backend`, `sonance_jf_token`, `sonance_jf_user_id`,
`sonance_jf_server_version`, cleared at logout; `sonance_jf_device_id`, kept), and a Jellyfin
logout revokes the token on the server.

**localStorage Keys:**
```
sonance_server_url    → "http://192.168.0.2:4534"
sonance_username      → "andy"
sonance_password      → "..." (stored for token generation)
sonance_salt          → last used salt
sonance_logged_in     → "true"
```

**Flow:**
1. App starts → check `sonance_logged_in`
2. If true → validate with `ping.view` → if OK, show Home; if fail, show Login with error
3. If false → show Login screen
4. Login: user enters server URL, port, username, password → call `ping.view` → if OK, store to localStorage, navigate to Home
5. Logout: clear all `sonance_*` keys → show Login screen

### 3.4 Focus Manager (focus.js)
Central d-pad navigation system.

**Concepts:**
- **Focus zones:** Named regions of the screen (e.g. `sidebar`, `content`, `nowplaying-bar`)
- **Focus items:** Individual focusable elements within a zone, arranged in a 2D grid
- **Focus ring:** Visual highlight (2px solid #e44d8a, 4px offset) applied to focused element

**Key Handling:**
- Arrow keys: move focus within current zone; if at edge, transition to adjacent zone
- Enter: activate focused element
- Back (keyCode 10009): navigate back (previous screen or close overlay)
- Escape (browser): mapped to Back for dev testing
- Media keys: forwarded directly to Player regardless of focus

**Zone Transitions:**
```
┌──────────┐    →    ┌──────────────┐
│ Sidebar  │  Right  │   Content    │
│          │  ←──────│              │
│          │  Left   │              │
└──────────┘         └──────┬───────┘
                            │ Down (at bottom)
                     ┌──────▼───────┐
                     │ NowPlaying   │
                     │    Bar       │
                     └──────────────┘
```

### 3.5 Player Engine (player.js)
Audio playback via **Tizen AVPlay API** (`webapis.avplay`) on TV, with HTML5 `<audio>` fallback for browser development.

**Platform Detection:**
```javascript
const IS_TIZEN = typeof window.webapis !== 'undefined' && typeof window.webapis.avplay !== 'undefined';
```

**State:**
```javascript
{
  currentTrack: null,     // Track object
  queue: [],              // Array of track objects
  queueIndex: 0,          // Current position in queue
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  volume: 0.7,            // 0-1
  shuffle: false,
  repeat: 'none',         // 'none' | 'all' | 'one'
}
```

**Features:**
- Play album (replace queue), play track (insert + play), add to queue
- Shuffle mode (Fisher-Yates on queue copy, preserving original order)
- Repeat: none, all (loop queue), one (loop current track)
- Scrobble to Navidrome when track reaches 50% or 4 minutes
- Emit events: `play`, `pause`, `trackchange`, `progress`, `queuechange`
- Now playing bar subscribes to events and updates reactively

**AVPlay Backend (Tizen):**
```javascript
// Lifecycle: open → setDisplayRect → prepareAsync → play → stop → close
webapis.avplay.open(streamUrl);
webapis.avplay.setDisplayRect(0, 0, 1, 1);  // 1×1 px off-screen for audio-only
webapis.avplay.prepareAsync(onPrepared, onError);

// In onPrepared callback:
webapis.avplay.play();

// Callbacks via setListener:
webapis.avplay.setListener({
  oncurrentplaytime: function(ms) { /* update progress */ },
  onstreamcompleted: function() { /* track ended, play next */ },
  onbufferingstart: function() { /* show buffering indicator */ },
  onbufferingcomplete: function() { /* hide buffering indicator */ },
  onerror: function(error) { /* log, skip to next track */ }
});

// Seek:
webapis.avplay.seekTo(ms);

// Stop current before loading new track:
webapis.avplay.stop();
webapis.avplay.close();
```

**HTML5 Audio Fallback (Browser Dev):**
```html
<audio id="sonance-audio" preload="auto"></audio>
```
- Used ONLY when `IS_TIZEN === false` (browser development/testing)
- Same public API, different internal implementation
- Source set to Subsonic `stream.view` URL with auth params

**Volume:**
- On Tizen: use `tizen.tvaudiocontrol.setVolume(level)` or let the TV's native volume control handle it
- On browser: use `audioElement.volume`
- Volume preference persists in localStorage

### 3.6 Screen Rendering
Each screen is a JS module exporting:
- `render(container)` — builds DOM and inserts into container
- `activate(params)` — called when navigating to this screen (fetch data, set focus)
- `deactivate()` — cleanup when navigating away
- `getFocusMap()` — returns focus zone configuration for FocusManager

Screens build DOM using helper functions (not template strings for complex layouts):
```javascript
// Example helper pattern
function el(tag, attrs, ...children) { ... }
```

## 4. Data Flow

```
User Input (Remote)
       │
       ▼
  FocusManager ──→ Active Screen Handler
       │                    │
       │              SubsonicAPI.fetch()
       │                    │
       │              Navidrome Server
       │                    │
       │              JSON Response
       │                    │
       │              Screen re-renders affected section
       │
       ├──→ Player (media key events)
       │         │
       │    AVPlay (Tizen) / <audio> (browser)
       │         │
       │    NowPlaying bar updates
       │
       └──→ Router (Back key)
                  │
             Screen transition
```

## 5. Packaging & Deployment

### Tizen Widget Structure
```
Sonance.wgt (ZIP archive)
├── config.xml          # Tizen manifest
├── icon.png            # 256×256 app icon
├── index.html
├── css/styles.css
└── js/
    ├── app.js
    ├── api.js
    ├── auth.js
    ├── focus.js
    ├── player.js
    ├── utils.js
    └── screens/*.js
```

### config.xml Key Settings
```xml
<?xml version="1.0" encoding="UTF-8"?>
<widget xmlns="http://www.w3.org/ns/widgets"
        xmlns:tizen="http://tizen.org/ns/widgets"
        id="http://simmo.dev/sonance"
        version="1.0.0"
        viewmodes="maximized">
    <name>Sonance</name>
    <icon src="icon.png"/>
    <content src="index.html"/>
    <access origin="*" subdomains="true"/>
    <tizen:application id="xxxxxxxx.Sonance" package="xxxxxxxx" required_version="5.0"/>
    <tizen:privilege name="http://tizen.org/privilege/internet"/>
    <tizen:privilege name="http://tizen.org/privilege/tv.audio"/>
    <tizen:privilege name="http://tizen.org/privilege/volume.set"/>
</widget>
```

### Deployment Steps
1. Enable Developer Mode on Q90R (Apps → type "12345" → toggle Developer Mode → set PC IP)
2. Build: `bash build.sh` → produces `Sonance.wgt`
3. Deploy via Jellyfin2Samsung: select custom `.wgt`, point to TV IP
4. App appears in Apps → Downloaded on TV

## 5a. Android TV host (v3.15)

Since 3.15 the same web app also ships as an Android TV APK (`tickets/ticket-3.xx-androidtv.md`,
decisions D216–D235 in its §9, and fix round 1's D236–D246). The system WebView hosts it, inside a
small native wrapper in Java that uses Android framework APIs only: no androidx, Media3/ExoPlayer,
Leanback or Kotlin.

```
Android TV device
└── dev.simmo.sonance (APK)
    ├── MainActivity (Java)     full-screen WebView, key translation (K1), lifecycle (W5), renderer recovery (W4)
    │     └── SonanceWebView   the WebView: keys before the IME (X2), the system keyboard only on OK (X4)
    │           │  file:///android_asset/www/index.html   ← the .wgt's web payload, byte for byte
    │           ├── $WEBAPIS/webapis/webapis.js  ← android/shim/webapis.js: window.webapis + window.tizen
    │           └── js/sonance-*.min.js          ← unchanged; runs its Tizen (AVPlay) code path
    ├── NativeBridge (@JavascriptInterface)       the shim's only door into native code
    ├── PlayerEngine (Java)     MediaExtractor + MediaCodec + AudioTrack (X1), a decoder thread per stream;
    │                           events → evaluateJavascript
    └── PlaybackService (Java)  mediaPlayback foreground service (B1); PlayerEngine holds the audio focus (B2)
```

**Why this shape:**
- **The web payload is the `.wgt`'s.** `build-android.sh` takes it from `Sonance3.wgt` (minus
  `config.xml` and `icon.png`) and fails if a staged file differs, so the two platforms cannot drift.
- **Android runs the Tizen code path.** The shim defines `webapis.avplay` before `player.js` loads,
  so `Player.IS_TIZEN` is true and the AVPlay branch runs as on the TV: the production path, with
  D173–D176's transcode rules and the load-generation guards. The HTML5 branch stays the
  browser-development path.
- **Keys arrive as on Tizen.** `MainActivity` translates the remote's keys into Tizen's codes
  (BACK → 10009, MEDIA_PLAY_PAUSE → 10252, the colour keys → 403–406, …), so `focus.js` is
  untouched (§3.4).
- **One shared-code seam.** `SonancePlatform` (set by the shim) names the platform in Settings →
  About and in Jellyfin's `Device=` header ("Android TV"); without it both read as before.

**Rejected:**
- a native UI (Leanback or Compose for TV): both are libraries, and the UI would be redrawn by
  hand, so it could not stay identical;
- the HTML5 `<audio>` path inside the WebView: it differs from the TV's path and has no
  foreground-service integration;
- an intercepted `https` origin (the `WebViewAssetLoader` pattern): every request to an `http://`
  server would become mixed content;
- Gradle: the user's decision; `build-android.sh` calls aapt2, javac, d8, zipalign and apksigner
  directly.

**The bridge** (`window.SonanceNative`, `NativeBridge.java`). Its methods run on a binder thread
and post their work; none blocks the UI thread.

| Method | What it does |
|---|---|
| `androidVersion()` | The Android release ("14"), for `SonancePlatform.platformLabel` |
| `exit()` | Stops the player and the service, then `finishAndRemoveTask()` (S4) |
| `playerOpen(url)` | Opens a new player session on `PlayerEngine`; returns its id |
| `playerPrepare(session)`, `playerPlay(session)`, `playerPause(session)`, `playerStop(session)`, `playerClose(session)` | AVPlay's calls, on that session. `playerPlay` also asks for the audio focus and starts the service (B1, B2) |
| `playerSeek(session, ms, seekId)` | A `SEEK_CLOSEST` seek; `seekId` matches its `seeked` event |
| `setKeepScreenOn(keep, callbackId)` | `FLAG_KEEP_SCREEN_ON` for AVPlay's screen-saver call (S5); answers with a callback |
| `nowPlaying(title)` | The current track's title, for the service's notification |
| `imeEditing(editing)` | An editable has focus in the page, or none has: reported once per change, after a `setTimeout(0)`, and "no" as each page loads (X2, X4, D236) |
| `imeReady()` | The shim has dropped `inputmode` after the host's `open`: the host shows the keyboard (X4) |

**Native to page.** Every message goes through `MainActivity.toPage()` on the UI thread, as
`SonanceShim.receive(msg)` (guarded by the page's own `window.SonanceShim`, D220):

| Message | Meaning |
|---|---|
| `{type:'key', action, keyCode, key, repeat}` | A translated key, injected as a synthetic `keydown` or `keyup` on the focused element; a held key repeats as further keydowns |
| `{type:'player', session, event}` | `prepared` (with `duration`), `tick` (with `position`, every 200 ms while playing), `seeked` (with `seek`, `position`), `completed`, `bufferingstart`, `bufferingcomplete`, `error` (with `error`, an AVPlayError value) |
| `{type:'callback', id}` | A bridge call has finished (`setKeepScreenOn`) |
| `{type:'focus', action:'pause'\|'resume'}` | Audio focus: another app took it (pause through `Player.pause()`), or gave a transient loss back (resume only what was paused, B2) |
| `{type:'ime', action:'open'\|'reset'}` | The system keyboard: OK on a field opens it (the shim drops every editable's `inputmode="none"`, then calls `imeReady()`), and it closes (the shim puts the attribute back) (X4) |

The shim drops player events from any session but the current one, and answers `getState` and
`getDuration` from its own state. Its AVPlay states and errors follow Samsung's AVPlay reference
(D225).

**Host behaviour:**
- **Viewport (W2).** `setUseWideViewPort`, `setLoadWithOverviewMode` and
  `setInitialScale(round(100 × screen width ÷ 1920))`, with `setTextZoom(100)`: the page is
  1920 × 1080 CSS px at any output, as on the Q90R. Never CSS `zoom` (D49).
- **Keys (K1).** Four groups: pass through (the D-pad and OK, which WebView already sends as 37–40
  and 13), translate (BACK, the media keys, the colour keys), swallow (channel, page, info, guide,
  menu, captions and other TV-only keys, D221) and system (Home, volume, power, search…).
- **Keys before the keyboard (X2, D237).** Android hands every key to the bound keyboard (IME)
  before the views see it, shown or not; on the SHIELD a hidden Gboard began its own repeat of a
  Right press and never stopped. `SonanceWebView.dispatchKeyEventPreIme` gives the D-pad, OK, ENTER
  and NUMPAD_ENTER straight to the WebView, unless Sonance opened the keyboard and it is showing.
  The route is chosen at a key's down; its repeats and its up follow it.
- **The keyboard only on OK (X4, D236).** As on Tizen. The shim keeps `inputmode="none"` on every
  editable while the keyboard is closed, so Chromium never shows it by itself (after a sign-out,
  between Login's fields, or when the window regains focus). OK on a field is consumed by the host
  (the page sees no Enter), the shim drops the attribute, and the host shows the keyboard. It
  closes on Back, when editing ends, when the activity stops or loses its window focus; a keyboard
  that shows without OK is hidden. The manifest has `stateAlwaysHidden|adjustResize`.
- **Typing (X3, D238).** While the keyboard Sonance opened is up, a transient audio-focus loss (the
  keyboard's own) ducks the music to 20 % instead of pausing it; a loss still held a second after
  the keyboard closes is taken back.
- **Lifecycle (W4, W5).** Leaving Sonance makes the page hidden, so the queue is saved as on Tizen;
  timers are never paused. A lost renderer is replaced by a fresh WebView that boots the app anew,
  after the player and the service stop.
- **Background (B1, B2).** `PlaybackService` is a `mediaPlayback` foreground service, started on the
  first play while Sonance is visible, kept between tracks, and stopped by Exit, renderer loss and
  the activity's end. `PlayerEngine` holds the audio focus: a loss pauses through the app, a
  transient loss resumes on regain, and a duck plays at 20 % without telling the page.
- **The sleep timer in the background (X5, D239).** A hidden WebView page's timer chains stop after
  about 5 minutes, but script that native code starts still runs. So `SleepTimer`
  (`js/screens/nowplaying.js`, shared code) also checks its deadline on `Player`'s `progress`
  events, which the engine's ticks drive; it fires within about 200 ms of the deadline.
- **The engine (X1, D240–D245).** `PlayerEngine` decodes with `MediaExtractor` and `MediaCodec` (no
  codec for a raw extractor track: the FLAC and WAV extractors decode themselves) and plays through
  an `AudioTrack` opened in the PCM encoding the decoder actually delivers. Android 11's
  `MediaPlayer` opened its sink as 16-bit whatever it was given, and played the SHIELD's float
  24-bit FLAC as static. Integer PCM wider than 16 bits becomes float on every API level. To an
  app's own process, Android's FLAC and WAV extractors deliver 24-bit files as 16-bit PCM, and say
  so (D244: float goes to mediaserver only), so on the emulator every format plays as 16-bit.
  - **Threads.** The engine thread owns the sessions, the audio focus, the ticks and the track's
    play, pause, volume and position. Each prepared stream has a decoder thread
    (`SonanceDecode-<session>`), which owns the extractor, the codec and the track's creation,
    writes and release. The engine thread never waits on it; a decoder stuck in a blocking HTTP
    call (which retries for about 30 s) releases its resources when the call returns.
  - **Start, seek and end.** A stream plays once 200 ms are queued. A seek pauses and flushes the
    track, seeks the extractor to the previous sync point and drops the decoded frames before the
    target; the latest seek wins and answers every pending one. A stream ends with a buffer of
    silence rather than `stop()` (after which the position reads 0), and "completed" follows its
    last frame's playing out (D241).
  - **Errors (D224, D242).** A missing decoder (ALAC on AOSP) is "format not supported" before any
    audio; D224's status check tells a bad request from a body no extractor reads; a direct stream
    whose data ends more than 1 s short of its duration was cut off, a connection error.
  - **Buffering (D243).** It starts when the track has under 100 ms queued, and completes at 1 s in
    the track and the extractor's cache, a ¾-full track, or the stream's end.
- **Network.** Cleartext is allowed to any server (`android/res/xml/network_security_config.xml`), and only system
  certificates are trusted. Safe Browsing and WebView metrics are off. The WebView never navigates
  away from the app's page.
- **Debug builds only:** WebView DevTools, a `sonance_url` intent extra (an `http://localhost` page
  or `chrome://crash`, for the device harness `tests/tools/android-*.js`), the audio-focus drill
  `sonance_focus_drill`, the key and keyboard log lines, and the engine's level probe (each
  stream's peak and RMS at the AudioTrack's input, logged at its end).
- **targetSdk 35, pinned (G9).** At 36, Android 16 stops delivering `KEYCODE_BACK`; 37 adds a
  local-network permission and stricter background audio. Sideloaded, so no store deadline applies.

## 6. Testing Strategy

### Browser Testing (Primary)
- All screens tested in Chrome at 1920×1080 viewport
- Keyboard navigation (arrows + Enter + Escape) simulates d-pad
- Dev server on port 8080 pointing at real Navidrome instance
- Network error simulation via browser DevTools throttling

### TV Testing (Post-deployment)
- D-pad navigation flow through all screens
- Audio playback of various formats (FLAC, MP3, AAC)
- Long playback session (queue of 20+ tracks)
- Network interruption recovery
- App resume after TV standby
- Remote media key responsiveness

### Test Harness
A simple browser test page (`tests/browser/index.html`) that:
- Validates SubsonicAPI against live Navidrome instance
- Checks all endpoint responses parse correctly
- Tests Focus Manager key handling
- Tests Player state transitions

## 7. Future Considerations
- Lyrics display (Navidrome supports synced lyrics via OpenSubsonic)
- Artist detail screen with biography
- Gapless playback (AVPlay supports this with `prepareAsync` on next track while current plays)
- Chromecast/DLNA output
- Multiple server profiles
- Transcoding preference configuration (bitrate/format selection via Subsonic params)
