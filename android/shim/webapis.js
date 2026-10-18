// Sonance — Android TV shim (ticket-3.xx-androidtv S1).
//
// Served at $WEBAPIS/webapis/webapis.js, where Tizen serves its WebAPIs, so it runs before the
// app bundles (index.html). The shared-code rules apply: ES2017 in the var/function style, with no
// optional chaining, nullish coalescing or setInterval (Chromium 63).
//
// Inert unless the Android host's bridge (window.SonanceNative) is present, so it is safe to load
// anywhere else (S1). On the host it stands in for the Tizen APIs the app calls:
// - webapis.avplay: AVPlay over the host's PlayerEngine (A1-A3). It exists before the app bundles
//   load, so player.js fixes IS_TIZEN true and runs its AVPlay path, as on the TV;
// - webapis.appcommon.setScreenSaver: the window's keep-screen-on flag (S5);
// - tizen.tvinputdevice.registerKey: a no-op, because the host translates keys natively (K1);
// - tizen.application.getCurrentApplication().exit(): the host's exit (S4);
// - tizen.tvaudiocontrol.setVolume: a no-op (Player.setVolume has no caller);
// - window.SonancePlatform: the names the platform seam shows (S3);
// - window.SonanceShim.receive(msg): the one entry point for native calls (keys, player events,
//   callbacks and audio focus). Its presence is also the host's sign that the shim has loaded on
//   the current page (D220);
// - the current track's title, for the host's notification (B1).
(function() {
    'use strict';

    var bridge = window.SonanceNative;
    if (typeof bridge === 'undefined') return;

    function noop() {}

    window.tizen = {
        tvinputdevice: { registerKey: noop },
        application: {
            getCurrentApplication: function() {
                return { exit: function() { bridge.exit(); } };
            }
        },
        tvaudiocontrol: { setVolume: noop }
    };

    window.SonancePlatform = {
        deviceName: 'Android TV',
        platformLabel: 'Android TV ' + bridge.androidVersion()
    };

    // K1: a translated key as Tizen delivers it, to the focused element as a key event would be.
    // A synthetic event has no default action, so nothing scrolls or types.
    function injectKey(msg) {
        var target = document.activeElement || document.body;
        target.dispatchEvent(new KeyboardEvent(msg.action === 'up' ? 'keyup' : 'keydown', {
            key: msg.key,
            keyCode: msg.keyCode,
            which: msg.keyCode,
            repeat: !!msg.repeat,
            bubbles: true,
            cancelable: true
        }));
    }

    // A1: webapis.avplay, the AVPlay contract player.js uses (tests/avplay-stub.js models it). The
    // state is the shim's own, so getState and getDuration answer synchronously. The engine works
    // on its own thread and reports back through receive(): every event carries the session that
    // open() created, and only the current session's events reach the app.
    var avState = 'NONE';      // NONE -> IDLE -> READY -> PLAYING / PAUSED; stop -> IDLE; close -> NONE
    var session = 0;           // the engine's session for the stream opened now (ids start at 1)
    var listener = null;
    var duration = 0;          // ms, from the engine's "prepared"
    var preparing = null;      // { ok, err } while a prepareAsync is pending
    var failed = false;        // an error ended the session: nothing more from it reaches the app
    var seeks = {};            // seek id -> its ok callback, until the engine's "seeked"
    var nextSeek = 1;
    var startAt = null;        // a seekTo made in IDLE, { ms, ok }: the engine seeks once prepared
    var heldSession = 0;       // D227: a focus pause came while this session prepared
    var held = false;          // its first play was held, and the app must be told it is paused

    // D225: the states each call is allowed in are those of Samsung's AVPlay API reference.
    function stateError(call) {
        var e = new Error(call + '() is not allowed in state ' + avState);
        e.name = 'InvalidStateError';
        return e;
    }

    // A call in the wrong state throws, as AVPlay's WebAPIException does, and reaches nothing.
    function allow(call, states) {
        if (states.indexOf(avState) < 0) throw stateError(call);
    }

    // A callback on a later task, as AVPlay's are.
    function later(callback, arg) {
        if (typeof callback === 'function') setTimeout(function() { callback(arg); }, 0);
    }

    // A3: prepareAsync's error callback gets a WebAPIException, as on Tizen: NotSupportedError for
    // media the engine cannot play (player.js's _avplayCause turns it into the format toast), and
    // UnknownError otherwise (D225: the reference lists no network type). Its message is the
    // engine's AVPlayError value.
    function webApiError(text) {
        var e = new Error(text);
        e.name = /NOT_SUPPORTED/.test(text) ? 'NotSupportedError' : 'UnknownError';
        return e;
    }

    function fire(name, arg) {
        if (listener && typeof listener[name] === 'function') listener[name](arg);
    }

    function seek(ms, ok) {
        var id = nextSeek++;
        seeks[id] = ok;
        bridge.playerSeek(session, Math.round(ms), id);
    }

    // What belongs to the stream opened now.
    function dropStream() {
        duration = 0;
        preparing = null;
        seeks = {};
        startAt = null;
        heldSession = 0;
    }

    var avplay = {
        // In IDLE, the stream opened (and not yet prepared) is replaced.
        open: function(url) {
            allow('open', ['NONE', 'IDLE']);
            if (avState === 'IDLE') {
                bridge.playerClose(session);
                dropStream();
            }
            session = bridge.playerOpen(String(url));
            avState = 'IDLE';
            failed = false;
        },
        // Audio only: nothing is drawn.
        setDisplayRect: function() {
            allow('setDisplayRect', ['IDLE', 'READY', 'PLAYING', 'PAUSED']);
        },
        setListener: function(l) { listener = l; },
        // Never throws: a wrong state reaches the error callback. Already prepared, it succeeds.
        prepareAsync: function(ok, err) {
            if (avState === 'READY') {
                later(ok);
            } else if (avState !== 'IDLE') {
                later(err, stateError('prepareAsync'));
            } else {
                preparing = { ok: ok, err: err };
                bridge.playerPrepare(session);
            }
        },
        play: function() {
            allow('play', ['READY', 'PLAYING', 'PAUSED']);
            if (avState === 'PLAYING') return;
            // D227: the app plays as its prepare succeeds, whatever happened meanwhile. After a
            // focus pause, that play stays in the page (the engine never starts, so the focus is
            // not taken back) and the stream waits, paused, for the next play.
            if (avState === 'READY' && heldSession === session) {
                heldSession = 0;
                held = true;
                avState = 'PAUSED';
                return;
            }
            avState = 'PLAYING';
            focusPaused = false;
            bridge.playerPlay(session);
        },
        pause: function() {
            allow('pause', ['PLAYING', 'PAUSED']);
            if (avState === 'PAUSED') return;
            avState = 'PAUSED';
            bridge.playerPause(session);
        },
        // A1: the engine seeks to the closest frame. ok follows its completion, then the position.
        // Never throws: a wrong state reaches the error callback. In IDLE, MediaPlayer cannot seek
        // yet, so the seek waits for the stream to be prepared.
        seekTo: function(ms, ok, err) {
            if (avState === 'IDLE') {
                startAt = { ms: ms, ok: ok };
            } else if (avState === 'NONE') {
                later(err, stateError('seekTo'));
            } else {
                seek(ms, ok);
            }
        },
        stop: function() {
            if (avState === 'NONE') return;
            avState = 'IDLE';
            preparing = null;
            seeks = {};
            startAt = null;
            bridge.playerStop(session);
        },
        close: function() {
            if (avState === 'NONE') return;
            bridge.playerClose(session);
            avState = 'NONE';
            session = 0;
            listener = null;
            dropStream();
        },
        getState: function() { return avState; },
        getDuration: function() { return duration; }
    };

    // A2: the engine's events. Position events need a prepared stream (a tick still in flight
    // after stop() is dropped); buffering may come while it prepares. After an error the session
    // is over, so no completion follows it (A3).
    function onPlayer(msg) {
        if (msg.session !== session || failed) return;
        var e = msg.event;
        if (e === 'prepared') {
            if (!preparing) return;
            var p = preparing;
            preparing = null;
            duration = msg.duration;
            avState = 'READY';
            if (startAt) {
                var at = startAt;
                startAt = null;
                seek(at.ms, at.ok);
            }
            if (p.ok) p.ok();
            // D227: the app's play was held; its pause path makes it show paused.
            if (held) {
                held = false;
                if (window.Player) window.Player.pause();
            }
        } else if (e === 'error') {
            failed = true;
            var q = preparing;
            preparing = null;
            if (q) {
                if (q.err) q.err(webApiError(msg.error));
            } else {
                fire('onerror', msg.error);
            }
        } else if (e === 'bufferingstart' || e === 'bufferingcomplete') {
            fire('on' + e);
        } else if (avState !== 'IDLE') {
            if (e === 'tick') {
                fire('oncurrentplaytime', msg.position);
            } else if (e === 'seeked') {
                var done = seeks[msg.seek];
                delete seeks[msg.seek];
                if (done) done();
                fire('oncurrentplaytime', msg.position);
            } else if (e === 'completed') {
                fire('onstreamcompleted');
            }
        }
    }

    // S5: SCREEN_SAVER_OFF keeps the screen on (FLAG_KEEP_SCREEN_ON) and SCREEN_SAVER_ON lets it
    // sleep. The host calls back once the window's flag is set; setting it cannot fail, so the
    // error callback is never called.
    var callbacks = {};
    var nextCallback = 1;
    var appcommon = {
        AppCommonScreenSaverState: { SCREEN_SAVER_OFF: 0, SCREEN_SAVER_ON: 1 },
        setScreenSaver: function(state, ok) {
            var id = nextCallback++;
            callbacks[id] = ok;
            bridge.setKeepScreenOn(state === appcommon.AppCommonScreenSaverState.SCREEN_SAVER_OFF, id);
        }
    };

    function onCallback(msg) {
        var ok = callbacks[msg.id];
        delete callbacks[msg.id];
        if (ok) ok();
    }

    window.webapis = { avplay: avplay, appcommon: appcommon };

    // B2: audio focus, from the host's PlayerEngine.
    // - 'pause': another app took the audio. Sonance pauses as the Stop key does (Player.pause(),
    //   focus.js 10253), so the UI shows paused. A stream still preparing is held (D227).
    // - 'resume': a transient loss is over. Sonance plays again only if that pause paused it; any
    //   play since (the user's) clears that, as does a pause the user made first.
    // A duck is the host's alone (the volume), so the page is not told; other actions are ignored.
    var focusPaused = false;

    function onFocus(msg) {
        var player = window.Player;
        if (!player) return;
        var isPlaying = player.getState().isPlaying;
        if (msg.action === 'pause') {
            var loading = preparing !== null;
            if (loading) heldSession = session;
            focusPaused = isPlaying || loading;
            if (isPlaying) player.pause();
        } else if (msg.action === 'resume') {
            var resume = focusPaused && !isPlaying;
            focusPaused = false;
            if (resume) player.play();
        }
    }

    // B1: the host's notification shows the current track's title. The app's bundles load after
    // this file, so the shim subscribes once they have run.
    var lastTitle = '';
    document.addEventListener('DOMContentLoaded', function() {
        if (!window.Player || typeof window.Player.on !== 'function') return;
        window.Player.on('trackchange', function(track) {
            var title = track && track.title ? String(track.title) : '';
            if (title === lastTitle) return;
            lastTitle = title;
            bridge.nowPlaying(title);
        });
    });

    var handlers = { key: injectKey, player: onPlayer, callback: onCallback, focus: onFocus };

    window.SonanceShim = {
        receive: function(msg) {
            var handle = handlers[msg.type];
            if (handle) handle(msg);
        }
    };

    console.log('[Sonance] Android shim loaded');
})();
