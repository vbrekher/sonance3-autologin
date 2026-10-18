// Sonance — Android TV shim (ticket-3.xx-androidtv S1).
//
// Served at $WEBAPIS/webapis/webapis.js, where Tizen serves its WebAPIs, so it runs before the
// app bundles (index.html). The shared-code rules apply: ES2017 in the var/function style, with no
// optional chaining or nullish coalescing (Chromium 63).
//
// Inert unless the Android host's bridge (window.SonanceNative) is present, so it is safe to load
// anywhere else (S1). S1 sets a marker only: window.webapis stays undefined, so player.js takes its
// HTML5 path until S3 adds webapis.avplay.
(function() {
    'use strict';

    if (typeof window.SonanceNative === 'undefined') return;

    window.SonanceShimLoaded = true;
    console.log('[Sonance] Android shim loaded');
})();
