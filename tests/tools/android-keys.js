#!/usr/bin/env node
'use strict';

// Sonance — Android TV device checks for keys and lifecycle (ticket-3.xx-androidtv K1-K3, W4, W5;
// prompt S2 T5), on the debug build in the sonance-tv emulator.
//
// Each check boots the bundled app from the Mac's dev server (bootBundled: the mock session, through
// DevTools init scripts), sends keys the way a remote does (adb shell input keyevent), and reads
// what the page saw through a capture-phase recorder installed over DevTools.
//
// Usage (dev server on 8091; the debug APK installed):
//   NODE_PATH="$PWD/node_modules" node tests/tools/android-keys.js k1|k2|k3|w4|w5
//
//   k1  every key of K1's table: what the page receives (keydown/keyup, keyCode, key, trusted)
//   k2  Back at the root opens "Exit Sonance?", and Exit ends the activity and its task
//   k3  on a Songs row: adb's --longpress (reported), OK held 800 ms opens the options sheet, and a
//       short press plays the next row
//   w4  a debug-only chrome://crash load: the process survives and the app boots afresh
//   w5  Home, then back: hidden then visible, the queue saved on hide, the same page and process
//
// Screenshots go to screenshots/androidtv/s2-*.png.

var path = require('path');
var H = require('../../e2e/helpers/sonance.js');
var D = require('./android-devtools.js');

var BASE = D.DEV_SERVER;
var SHOTS = path.resolve(__dirname, '..', '..', 'screenshots', 'androidtv');

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
function key(name, extra) { D.adb(['shell', 'input', 'keyevent'].concat(extra || [], ['KEYCODE_' + name])); }
function pid() { try { return D.adb(['shell', 'pidof', D.PACKAGE]).trim(); } catch (e) { return ''; } }
function shot(name) { return D.screencap(path.join(SHOTS, 's2-' + name + '.png')); }

// Every keydown/keyup at the window in the capture phase (before the app's own listeners), and
// every visibilitychange, on the page's clock.
function installRecorder(page) {
    return page.evaluate(function() {
        window.__rec = [];
        function rec(e) {
            window.__rec.push({ type: e.type, keyCode: e.keyCode, key: e.key, repeat: e.repeat,
                trusted: e.isTrusted, t: Math.round(performance.now()) });
        }
        window.addEventListener('keydown', rec, true);
        window.addEventListener('keyup', rec, true);
        document.addEventListener('visibilitychange', function() {
            window.__rec.push({ type: 'visibilitychange', state: document.visibilityState, t: Math.round(performance.now()) });
        });
    });
}

function takeRecord(page) {
    return page.evaluate(function() { var r = window.__rec.slice(); window.__rec.length = 0; return r; });
}

// Brings the running app forward without restarting it (a plain am start reuses the singleTask
// activity). The emulator's launcher gate may push itself back in front once (D219).
async function bringToFront() {
    for (var i = 0; i < 5; i++) {
        D.adb(['shell', 'am', 'start', '-n', D.PACKAGE + '/.MainActivity']);
        await sleep(1500);
        if (D.topActivity().indexOf(D.PACKAGE + '/') === 0) return;
    }
    throw new Error('android-keys: the app did not come to the front (top: ' + D.topActivity() + ')');
}

async function bootApp(opts) {
    D.adb(['reverse', 'tcp:8091', 'tcp:8091']);
    D.launch(BASE + '/index.html');
    var c = await D.connect({ timeout: 20000 });
    await H.bootBundled(c.page, opts || {});
    return c;
}

async function close(c) {
    try { await c.close(); } catch (e) { /* the page or the app is gone */ }
}

// K1's table: [Android key, expected page events]. A translated key arrives as a synthetic
// (untrusted) keydown and keyup with the Tizen code and key; a pass-through key as WebView's own.
var K1 = [
    ['DPAD_UP', 'pass', 38], ['DPAD_DOWN', 'pass', 40], ['DPAD_LEFT', 'pass', 37], ['DPAD_RIGHT', 'pass', 39],
    ['DPAD_CENTER', 'pass', 13], ['ENTER', 'pass', 13],
    ['BACK', 'translate', 10009, 'XF86Back'],
    ['MEDIA_PLAY_PAUSE', 'translate', 10252, 'MediaPlayPause'],
    ['MEDIA_STOP', 'translate', 10253, 'MediaStop'],
    ['MEDIA_REWIND', 'translate', 10412, 'MediaRewind'],
    ['MEDIA_FAST_FORWARD', 'translate', 10417, 'MediaFastForward'],
    ['MEDIA_PLAY', 'translate', 415, 'MediaPlay'],
    ['MEDIA_PAUSE', 'translate', 19, 'MediaPause'],
    ['MEDIA_PREVIOUS', 'translate', 10232, 'MediaTrackPrevious'],
    ['MEDIA_NEXT', 'translate', 10233, 'MediaTrackNext'],
    ['PROG_RED', 'translate', 403, 'ColorF0Red'], ['PROG_GREEN', 'translate', 404, 'ColorF1Green'],
    ['PROG_YELLOW', 'translate', 405, 'ColorF2Yellow'], ['PROG_BLUE', 'translate', 406, 'ColorF3Blue'],
    ['CHANNEL_UP', 'swallow'], ['PAGE_DOWN', 'swallow'], ['INFO', 'swallow'], ['GUIDE', 'swallow'],
    ['MENU', 'swallow'], ['CAPTIONS', 'swallow'],
    ['VOLUME_UP', 'system']
];

function verdict(row, got) {
    var group = row[1];
    if (group === 'swallow' || group === 'system') return got.length === 0;
    if (got.length !== 2 || got[0].type !== 'keydown' || got[1].type !== 'keyup') return false;
    return got.every(function(e) {
        if (e.keyCode !== row[2]) return false;
        return group === 'pass' ? e.trusted : (!e.trusted && e.key === row[3]);
    });
}

async function k1() {
    var c = await bootApp();
    var rows = [];
    var ok = true;
    try {
        await installRecorder(c.page);
        for (var i = 0; i < K1.length; i++) {
            var row = K1[i];
            await takeRecord(c.page);
            key(row[0]);
            await sleep(500);
            var got = (await takeRecord(c.page)).filter(function(e) { return e.type !== 'visibilitychange'; });
            if (row[0] === 'VOLUME_UP') {
                shot('k1-volume-up');
                key('VOLUME_DOWN');
            }
            var pass = verdict(row, got);
            ok = ok && pass;
            rows.push((pass ? 'ok   ' : 'FAIL ') + row[0].padEnd(20) + row[1].padEnd(11) +
                (got.length ? got.map(function(e) {
                    return e.type + ' ' + e.keyCode + ' "' + e.key + '"' + (e.trusted ? '' : ' (synthetic)');
                }).join(', ') : '(nothing)'));
        }
    } finally {
        await close(c);
    }
    console.log(rows.join('\n'));
    return ok;
}

async function k2() {
    var c = await bootApp();
    var p = c.page;
    try {
        await p.evaluate(function() { FocusManager.setActiveZone('topnav', 0, true); });
        await H.settle(p, 200);
        key('BACK');
        var title = await p.waitForFunction(function() {
            var t = document.querySelector('.exit-card-title');
            return t && t.textContent;
        }, null, { timeout: 5000 });
        shot('k2-exit-dialog');
        console.log('Back at the root: "' + title + '", focus ' + await p.evaluate(function() {
            return FocusManager.getActiveZone() + ' ' + document.activeElement.id;
        }));
        key('DPAD_RIGHT');
        await sleep(300);
        console.log('focused: ' + await p.evaluate(function() { return document.querySelector('.exit-btn.focused').id; }));
    } finally {
        // Exit kills the page: no DevTools after it.
        key('DPAD_CENTER');
        await close(c);
    }
    await sleep(2500);
    // Task and activity records only: WindowManager keeps naming the last window in fields such as
    // mLastWakeLockObscuringWindow after the activity has gone.
    var acts = D.adb(['shell', 'dumpsys', 'activity', 'activities']).split('\n').filter(function(l) {
        return /(ActivityRecord|Task)\{/.test(l) && l.indexOf(D.PACKAGE) > -1;
    });
    var recents = D.adb(['shell', 'dumpsys', 'activity', 'recents']).split('\n').filter(function(l) {
        return l.indexOf(D.PACKAGE) > -1;
    });
    console.log('after Exit: activity records ' + acts.length + ', recent tasks ' + recents.length +
        ', top ' + D.topActivity() + ', process ' + (pid() || 'gone'));
    acts.concat(recents).forEach(function(l) { console.log('  ' + l.trim()); });
    return acts.length === 0 && recents.length === 0;
}

async function k3() {
    var c = await bootApp({ songs: 400, albums: 60 });
    var p = c.page;
    var ok = false;
    try {
        await H.navTo(p, 'library');
        await H.press(p, 'ArrowDown');
        await H.settle(p, 300);
        await H.press(p, 'ArrowLeft');
        await H.press(p, 'ArrowDown', 2, 90);
        await sleep(450);
        await H.press(p, 'ArrowRight');
        await p.waitForFunction(function() { return !!document.querySelector('#library-grid .song-row.focused'); },
            null, { timeout: 10000 });
        await H.settle(p, 300);
        await installRecorder(p);
        var sheetState = function() {
            return p.evaluate(function() {
                var t = document.querySelector('#options-sheet .options-sheet-title');
                var s = Player.getState();
                return { open: OptionsSheet.isOpen(), title: t && t.textContent,
                    playing: s.currentTrack && s.isPlaying ? s.currentTrack.title : null };
            });
        };
        var trace = function(rec) {
            var t0 = rec.length ? rec[0].t : 0;
            return rec.map(function(e) {
                return e.type + (e.repeat ? '(repeat)' : '') + ' ' + e.keyCode + ' @' + (e.t - t0) + 'ms';
            }).join(', ');
        };

        // (1) adb's --longpress, reported: it holds for the system long-press timeout (400 ms on
        // Android 12+), and focus.js's hold threshold is 500 ms (D207, a fixed point), so this is a
        // short press: the row plays (D222).
        key('DPAD_CENTER', ['--longpress']);
        await sleep(1500);
        var s1 = await sheetState();
        console.log('(1) --longpress DPAD_CENTER: ' + trace(await takeRecord(p)));
        console.log('    sheet open: ' + s1.open + ', playing: ' + s1.playing);
        await p.evaluate(function() { Player.pause(); });
        await H.settle(p, 300);

        // (2) OK held for 800 ms (D222): DPAD_CENTER down with a swallowed key (CAPTIONS, which
        // never reaches the page), then both up. adb cannot hold a single key longer than (1).
        D.adb(['shell', 'input', 'keycombination', '-t', '800', 'KEYCODE_DPAD_CENTER', 'KEYCODE_CAPTIONS']);
        var opened = await p.waitForFunction(function() { return OptionsSheet.isOpen(); }, null, { timeout: 3000 })
            .then(function() { return true; }, function() { return false; });
        await sleep(300);
        var s2 = await sheetState();
        console.log('(2) DPAD_CENTER held 800 ms: ' + trace(await takeRecord(p)));
        console.log('    sheet open: ' + s2.open + ' (' + s2.title + '), playing: ' + s2.playing);
        if (opened) shot('k3-sheet');

        // (3) Back closes the sheet; a short OK on the next row plays it.
        key('BACK');
        await p.waitForFunction(function() { return !OptionsSheet.isOpen(); }, null, { timeout: 3000 });
        key('DPAD_DOWN');
        await H.settle(p, 300);
        await takeRecord(p);
        key('DPAD_CENTER');
        var played = await p.waitForFunction(function() {
            var s = Player.getState();
            return s.currentTrack && s.isPlaying ? s.currentTrack.title : false;
        }, null, { timeout: 5000 }).catch(function() { return null; });
        console.log('(3) short DPAD_CENTER on the next row: ' + trace(await takeRecord(p)));
        console.log('    playing: ' + played + ', sheet open: ' + await p.evaluate(function() { return OptionsSheet.isOpen(); }));
        shot('k3-short-press');
        ok = opened && s2.title === 'Track 001' && s2.playing === null && played === 'Track 002';
        await p.evaluate(function() { Player.pause(); });
    } finally {
        await close(c);
    }
    return ok;
}

async function w4() {
    var c = await bootApp();
    var before = { pid: pid(), origin: await c.page.evaluate(function() { return performance.timeOrigin; }) };
    await close(c);
    D.adb(['logcat', '-c']);
    D.adb(['shell', 'am', 'start', '-n', D.PACKAGE + '/.MainActivity', '--es', 'sonance_url', 'chrome://crash']);
    await sleep(6000);
    var after = pid();
    var log = D.adb(['logcat', '-d', '-s', 'Sonance']).split('\n').filter(function(l) {
        return /renderer gone|Android shim loaded|WebView /.test(l);
    });
    log.forEach(function(l) { console.log('  ' + l.trim()); });
    var c2 = await D.connect({ timeout: 20000 });
    var now;
    try {
        // A fresh launch from the APK's assets: Login (no session in that origin), or a screen.
        await c2.page.waitForFunction(function() {
            return !document.getElementById('splash') && typeof App !== 'undefined' &&
                (!!App.getCurrentScreen() || !!document.querySelector('.login-screen'));
        }, null, { timeout: 15000 });
        now = await c2.page.evaluate(function() {
            return { url: location.href, screen: App.getCurrentScreen() || 'login', origin: performance.timeOrigin,
                shim: !!window.SonanceShim };
        });
    } finally {
        await close(c2);
    }
    shot('w4-recovered');
    console.log('process before ' + before.pid + ', after ' + after + '; page now ' + JSON.stringify(now) +
        ', timeOrigin before ' + before.origin);
    return !!before.pid && before.pid === after && now.origin !== before.origin &&
        log.some(function(l) { return /renderer gone/.test(l); });
}

async function w5() {
    var c = await bootApp();
    var p = c.page;
    var ok = false;
    try {
        await p.evaluate(function() { Player.setQueue(window.__MOCK__.songs.slice(0, 3), 0); });
        await p.waitForFunction(function() { return Player.getState().isPlaying; }, null, { timeout: 5000 });
        // The trackchange save (1 s debounce), then a position past it, so hiding has something new.
        await sleep(3500);
        await installRecorder(p);
        var before = await p.evaluate(function() {
            return { origin: performance.timeOrigin, saves: window.__MOCK__.queueSaves.length };
        });
        var pid1 = pid();
        key('HOME');
        await sleep(2500);
        var topHidden = D.topActivity();
        var hidden = await p.evaluate(function() {
            return { state: document.visibilityState, saves: window.__MOCK__.queueSaves.length };
        });
        shot('w5-home');
        await bringToFront();
        await sleep(1000);
        var after = await p.evaluate(function() {
            return { origin: performance.timeOrigin, state: document.visibilityState,
                saves: window.__MOCK__.queueSaves.length, last: window.__MOCK__.queueSaves.slice(-1)[0] || null };
        });
        var rec = (await takeRecord(p)).filter(function(e) { return e.type === 'visibilitychange'; });
        var pid2 = pid();
        shot('w5-back');
        console.log('Home: top ' + topHidden + ', page ' + hidden.state + ', queue saves ' + before.saves + ' -> ' + hidden.saves);
        console.log('visibilitychange: ' + rec.map(function(e) { return e.state + ' @' + e.t + 'ms'; }).join(', '));
        console.log('return: page ' + after.state + ', pid ' + pid1 + ' -> ' + pid2 + ', timeOrigin ' +
            before.origin + ' -> ' + after.origin + ', last save ' + JSON.stringify(after.last));
        ok = rec.length === 2 && rec[0].state === 'hidden' && rec[1].state === 'visible' &&
            hidden.saves > before.saves && pid1 === pid2 && before.origin === after.origin;
        await p.evaluate(function() { Player.pause(); });
    } finally {
        await close(c);
    }
    return ok;
}

if (require.main === module) {
    var checks = { k1: k1, k2: k2, k3: k3, w4: w4, w5: w5 };
    var name = process.argv[2];
    if (!checks[name]) {
        console.error('usage: android-keys.js ' + Object.keys(checks).join('|'));
        process.exit(2);
    }
    checks[name]().then(function(ok) {
        console.log(name + ': ' + (ok ? 'PASS' : 'FAIL'));
        process.exitCode = ok ? 0 : 1;
    }, function(e) {
        console.error(e && e.stack || e);
        process.exit(1);
    });
}
