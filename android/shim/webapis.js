// Sonance — Android TV shim (ticket-3.xx-androidtv S1).
//
// Served at $WEBAPIS/webapis/webapis.js, where Tizen serves its WebAPIs, so it runs before the
// app bundles (index.html). The shared-code rules apply: ES2017 in the var/function style, with no
// optional chaining, nullish coalescing or setInterval (Chromium 63).
//
// Inert unless the Android host's bridge (window.SonanceNative) is present, so it is safe to load
// anywhere else (S1). On the host it stands in for the Tizen APIs the app calls:
// - tizen.tvinputdevice.registerKey: a no-op, because the host translates keys natively (K1);
// - tizen.application.getCurrentApplication().exit(): the host's exit (S4);
// - tizen.tvaudiocontrol.setVolume: a no-op (Player.setVolume has no caller);
// - window.SonancePlatform: the names the platform seam shows (S3);
// - window.SonanceShim.receive(msg): the one entry point for native calls. Its presence is also the
//   host's sign that the shim has loaded on the current page (D220).
// window.webapis stays undefined until S3 adds webapis.avplay, so player.js takes its HTML5 path.
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

    var handlers = { key: injectKey };

    window.SonanceShim = {
        receive: function(msg) {
            var handle = handlers[msg.type];
            if (handle) handle(msg);
        }
    };

    console.log('[Sonance] Android shim loaded');
})();
