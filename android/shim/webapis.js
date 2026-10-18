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
// - window.SonanceShim.receive(msg): the one entry point for native calls (keys, player events and
//   callbacks). Its presence is also the host's sign that the shim has loaded on the current page
//   (D220).
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

    // A call in the wrong state throws, as AVPlay's WebAPIException does, and reaches nothing.
    function allow(call, states) {
        if (states.indexOf(avState) > -1) return;
        var e = new Error(call + '() is not allowed in state ' + avState);
        e.name = 'InvalidStateError';
        throw e;
    }

    // A3: prepareAsync's error callback gets a WebAPIException, as on Tizen. Its name is the type
    // (NotSupportedError for media the engine cannot read, which player.js's _avplayCause turns
    // into the format toast) and its message the engine's AVPlay-style error.
    function webApiError(text) {
        var e = new Error(text);
        e.name = /NOT_SUPPORTED/.test(text) ? 'NotSupportedError'
            : (/CONNECTION/.test(text) ? 'NetworkError' : 'UnknownError');
        return e;
    }

    function fire(name, arg) {
        if (listener && typeof listener[name] === 'function') listener[name](arg);
    }

    function endSession() {
        session = 0;
        listener = null;
        duration = 0;
        preparing = null;
        seeks = {};
    }

    var avplay = {
        open: function(url) {
            allow('open', ['NONE']);
            session = bridge.playerOpen(String(url));
            avState = 'IDLE';
            failed = false;
        },
        // Audio only: nothing is drawn.
        setDisplayRect: noop,
        setListener: function(l) { listener = l; },
        prepareAsync: function(ok, err) {
            allow('prepareAsync', ['IDLE']);
            preparing = { ok: ok, err: err };
            bridge.playerPrepare(session);
        },
        play: function() {
            allow('play', ['READY', 'PLAYING', 'PAUSED']);
            if (avState === 'PLAYING') return;
            avState = 'PLAYING';
            bridge.playerPlay(session);
        },
        pause: function() {
            allow('pause', ['PLAYING', 'PAUSED']);
            if (avState === 'PAUSED') return;
            avState = 'PAUSED';
            bridge.playerPause(session);
        },
        // A1: the engine seeks to the closest frame. ok follows its completion, then the position.
        seekTo: function(ms, ok) {
            allow('seekTo', ['READY', 'PLAYING', 'PAUSED']);
            var id = nextSeek++;
            seeks[id] = ok;
            bridge.playerSeek(session, Math.round(ms), id);
        },
        stop: function() {
            allow('stop', ['IDLE', 'READY', 'PLAYING', 'PAUSED']);
            avState = 'IDLE';
            preparing = null;
            seeks = {};
            bridge.playerStop(session);
        },
        close: function() {
            if (avState === 'NONE') return;
            bridge.playerClose(session);
            avState = 'NONE';
            endSession();
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
            if (p.ok) p.ok();
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

    var handlers = { key: injectKey, player: onPlayer, callback: onCallback };

    window.SonanceShim = {
        receive: function(msg) {
            var handle = handlers[msg.type];
            if (handle) handle(msg);
        }
    };

    console.log('[Sonance] Android shim loaded');
})();
