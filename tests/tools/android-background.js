#!/usr/bin/env node
'use strict';

// Sonance — Android TV device checks for background playback (ticket-3.xx-androidtv B1-B5, W4;
// prompt S4 T5), on the debug build in the sonance-tv emulator.
//
// WHY detached: while a DevTools session is attached, Chromium keeps the WebView's screen on, and it
// may change how a hidden page's timers are throttled. So DevTools sets a check up and is closed;
// from then on the check is driven by adb keys and read from dumpsys and the engine's Logcat lines.
// A child `adb logcat` writes those lines to a file as they come: the ring buffer would not hold
// an hour of them.
//
// Usage (dev server on 8091; the debug APK installed):
//   NODE_PATH="$PWD/node_modules" node tests/tools/android-background.js b1|b2
//   NODE_PATH="$PWD/node_modules" node tests/tools/android-background.js soak [fgMin bgMin]
//   NODE_PATH="$PWD/node_modules" node tests/tools/android-background.js b4 [maxWaitMin]
//
//   b1    the service: none before a play; in the foreground (mediaPlayback) after the first play
//         while visible, with its notification; kept between tracks; a first play while hidden does
//         not start it, and the return does; stopped by Exit, by chrome://crash (W4), and when the
//         task is removed (the activity's end)
//   b2    the focus drill: a loss pauses and stays paused; a transient loss pauses and the regain
//         resumes; a user's own pause is not undone; a duck lowers the volume (new streams too) and
//         the regain restores it
//   soak  B3 and B5: a synthetic queue plays fgMin minutes in front while the UI is browsed by
//         keys, then bgMin minutes with the launcher in front; the gaps between tracks in each
//         phase, and dumpsys meminfo after each phase (defaults 30 and 30)
//   b4    a 15-minute sleep timer, set on Now Playing, expiring while Sonance is hidden: how late
//         playback stops (waits up to maxWaitMin, default 18)
//
// No live server is used. Logs and screenshots go to screenshots/androidtv/s4-* (local, ignored).

var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');
var H = require('../../e2e/helpers/sonance.js');
var D = require('./android-devtools.js');
var P = require('./android-playback.js');

var ADB = path.join(process.env.ANDROID_HOME || path.join(os.homedir(), 'Library', 'Android', 'sdk'), 'platform-tools', 'adb');
var SHOTS = path.resolve(__dirname, '..', '..', 'screenshots', 'androidtv');

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
function key(name) { D.adb(['shell', 'input', 'keyevent', 'KEYCODE_' + name]); }
function shot(name) { return D.screencap(path.join(SHOTS, 's4-' + name + '.png')); }
function say(msg) { console.log(new Date().toISOString().slice(11, 19) + '  ' + msg); }
function drill(kind) {
    D.adb(['shell', 'am', 'start', '-n', D.PACKAGE + '/.MainActivity', '--es', 'sonance_focus_drill', kind]);
}
// A marker in Logcat, on the emulator's clock, for the phases of a run.
function mark(text) { D.adb(['shell', 'log', '-t', 'Sonance', '-p', 'i', '"[Sonance] harness: ' + text + '"']); }

// ---------------------------------------------------------------------------------------------
// Logcat, streamed to a file
// ---------------------------------------------------------------------------------------------

function startLogcat(name) {
    var file = path.join(SHOTS, 's4-' + name + '.log');
    D.adb(['logcat', '-c']);
    var fd = fs.openSync(file, 'w');
    var child = childProcess.spawn(ADB, ['-s', D.SERIAL, 'logcat', '-v', 'epoch', '-s', 'Sonance:*'],
        { stdio: ['ignore', fd, 'ignore'] });
    return {
        file: file,
        stop: function() { child.kill(); fs.closeSync(fd); }
    };
}

// Each line as { t: ms since the epoch (the emulator's clock), msg }.
function entries(L) {
    return fs.readFileSync(L.file, 'utf8').split('\n').map(function(l) {
        var m = /^\s*(\d+)\.(\d+)\s+\d+\s+\d+\s+\w\s+Sonance\s*:\s*(.*)$/.exec(l);
        return m ? { t: Number(m[1]) * 1000 + Number(m[2].slice(0, 3)), msg: m[3].trim() } : null;
    }).filter(Boolean);
}

function lines(L, re) {
    return entries(L).filter(function(e) { return re.test(e.msg); }).map(function(e) { return e.msg; });
}

function clock(t) { return new Date(t).toISOString().slice(11, 23); }

// ---------------------------------------------------------------------------------------------
// The app and the system
// ---------------------------------------------------------------------------------------------

async function bootApp(opts) {
    D.adb(['reverse', 'tcp:8091', 'tcp:8091']);
    D.launch(D.DEV_SERVER + '/index.html');
    var c = await connect();
    await H.bootBundled(c.page, opts || {});
    return c;
}

// Right after a relaunch the DevTools socket can exist before it answers (fetch failed).
async function connect() {
    for (var i = 0; ; i++) {
        try {
            return await D.connect({ timeout: 20000 });
        } catch (e) {
            if (i >= 4) throw e;
            await sleep(1000);
        }
    }
}

// The mock's direct streams: every fifth song is Opus, a transcode that is longer than the others.
function playQueue(page, count) {
    return page.evaluate(function(n) {
        var q = window.__MOCK__.songs.filter(function(s) { return s.suffix !== 'opus'; });
        if (n) q = q.slice(0, n);
        Player.setQueue(q, 0);
        return q.length;
    }, count || 0);
}

function untilPlaying(page, want) {
    return P.waitFor(page, function(w) {
        return Player.getState().isPlaying === w && webapis.avplay.getState() === (w ? 'PLAYING' : 'PAUSED');
    }, want, 8000);
}

// Brings the running app forward without restarting it (a plain am start reuses the singleTask
// activity). The emulator's launcher gate may push itself back in front once (D219).
async function bringToFront() {
    for (var i = 0; i < 5; i++) {
        D.adb(['shell', 'am', 'start', '-n', D.PACKAGE + '/.MainActivity']);
        await sleep(1500);
        if (D.topActivity().indexOf(D.PACKAGE + '/') === 0) return;
    }
    throw new Error('android-background: the app did not come to the front (top: ' + D.topActivity() + ')');
}

// Records visibilitychange, read back after a detached phase.
function recordVisibility(page) {
    return page.evaluate(function() {
        window.__vis = [];
        document.addEventListener('visibilitychange', function() {
            window.__vis.push(document.visibilityState + ' @' + new Date().toISOString().slice(11, 23));
        });
    });
}

/** The PlaybackService record in dumpsys activity services, or null. */
function service() {
    var out = D.adb(['shell', 'dumpsys', 'activity', 'services', D.PACKAGE]);
    var block = out.split(/\n\s*\* ServiceRecord\{/).filter(function(b) { return b.indexOf('/.PlaybackService}') > -1; })[0];
    if (!block) return null;
    var fg = /isForeground=(\w+) foregroundId=(\d+) types=(\w+)/.exec(block);
    var noti = /foregroundNoti=(Notification\([^\n]*\))/.exec(block);
    return {
        record: block.split(' ')[0],
        foreground: !!fg && fg[1] === 'true',
        types: fg ? fg[3] : '',
        notification: noti ? noti[1] : ''
    };
}

function describeService(s) {
    return s ? 'ServiceRecord ' + s.record + ', isForeground=' + s.foreground + ', types=' + s.types : 'no PlaybackService';
}

/**
 * D230: what dumpsys notification holds for the package. On Android 13+ without
 * POST_NOTIFICATIONS the service's notification is enqueued and blocked, so there is no record.
 */
function notificationState() {
    var out = D.adb(['shell', 'dumpsys', 'notification', '--noredact']);
    var records = out.split('\n').filter(function(l) {
        return /NotificationRecord\(/.test(l) && l.indexOf('pkg=' + D.PACKAGE + ' ') > -1;
    }).length;
    var stats = out.split('AggregatedStats{').filter(function(b) {
        return b.indexOf("key='" + D.PACKAGE + "'") > -1;
    }).map(function(b) {
        var g = function(n) { var m = new RegExp(n + '=(\\d+)').exec(b); return m ? m[1] : '?'; };
        return 'enqueued ' + g('numEnqueuedByApp') + ', posted ' + g('numPostedByApp') + ', blocked ' + g('numBlocked');
    });
    return 'records ' + records + '; ' + stats.join(' | ');
}

/** The audio focus stack, bottom to top: who holds each entry, its gain and its loss. */
function focusStack() {
    var out = D.adb(['shell', 'dumpsys', 'audio']);
    var at = out.indexOf('Audio Focus stack entries');
    if (at < 0) return [];
    var rows = [];
    var rest = out.slice(at).split('\n').slice(1);
    for (var i = 0; i < rest.length && /^\s+source:/.test(rest[i]); i++) {
        var l = rest[i];
        var who = /PlayerEngine/.test(l) ? 'player' : /MainActivity/.test(l) ? 'drill' : (/pack: (\S+)/.exec(l) || [])[1];
        rows.push(who + ' ' + ((/gain: (\S+)/.exec(l) || [])[1]) + ' loss ' + ((/loss: (\S+)/.exec(l) || [])[1]));
    }
    return rows;
}

// MediaPlayer's state for the process, from dumpsys audio (started / paused / ...).
function players(app) {
    return P.audioPlayers(app).map(function(l) { return (/state:(\S+)/.exec(l) || [])[1]; });
}

function processIds() {
    var host = P.pid();
    var m = /app=ProcessRecord\{\S+ (\d+):com\.google\.android\.webview:sandboxed_process/.exec(
        D.adb(['shell', 'dumpsys', 'activity', 'services', D.PACKAGE]));
    return { host: host, renderer: m ? m[1] : '' };
}

/** B5: dumpsys meminfo for the host and the renderer, and the emulator's RAM. */
function meminfo(label) {
    var ids = processIds();
    var all = D.adb(['shell', 'dumpsys', 'meminfo']);
    var ram = ['Total RAM', 'Free RAM', 'Used RAM', 'Lost RAM'].map(function(k) {
        var m = new RegExp(k + ':\\s*([\\d,]+K)').exec(all);
        return k + ' ' + (m ? m[1] : '?');
    }).join(', ');
    function summary(pidOrName) {
        var out = D.adb(['shell', 'dumpsys', 'meminfo', pidOrName]);
        var at = out.indexOf('App Summary');
        var block = at < 0 ? [] : out.slice(at).split('\n').slice(0, 14).filter(function(l) {
            return /:\s/.test(l) && !/^\s*Pss\(KB\)/.test(l);
        });
        return block.map(function(l) { return '      ' + l.trim(); }).join('\n');
    }
    console.log('meminfo (' + label + '): ' + ram + '\n  host ' + ids.host + ' (dev.simmo.sonance):\n' + summary(ids.host) +
        '\n  renderer ' + ids.renderer + ' (WebView sandboxed_process):\n' + (ids.renderer ? summary(ids.renderer) : '      (not found)'));
    return ids;
}

function stats(list) {
    if (!list.length) return { n: 0, median: 0, mean: 0, max: 0, min: 0 };
    var s = list.slice().sort(function(a, b) { return a - b; });
    var sum = s.reduce(function(a, b) { return a + b; }, 0);
    return { n: s.length, median: s[Math.floor(s.length / 2)], mean: Math.round(sum / s.length), min: s[0], max: s[s.length - 1] };
}

// B3: from each stream's "completed" to the next stream's "started", by the engine's Logcat lines.
function gaps(list) {
    var out = [];
    var pending = null;
    list.forEach(function(e) {
        var m = /\] player (\d+): (completed|started)$/.exec(e.msg);
        if (!m) return;
        var id = Number(m[1]);
        if (m[2] === 'completed') pending = { id: id, t: e.t };
        else if (pending && id > pending.id) {
            out.push({ at: pending.t, ms: e.t - pending.t });
            pending = null;
        }
    });
    return out;
}

// ---------------------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------------------

// Back from the root of the app until "Exit Sonance?", then Exit (as k2 in android-keys.js).
async function exitByKeys(page) {
    await page.evaluate(function() { FocusManager.setActiveZone('topnav', 0, true); });
    for (var i = 0; i < 4; i++) {
        key('BACK');
        await sleep(800);
        if (await page.evaluate(function() { return !!document.querySelector('.exit-card-title'); })) break;
    }
    key('DPAD_RIGHT');
    await sleep(400);
    var focused = await page.evaluate(function() {
        var b = document.querySelector('.exit-btn.focused');
        return b ? b.id : null;
    });
    return focused;
}

async function b1() {
    var L = startLogcat('b1');
    var C = P.Checks();
    D.adb(['shell', 'pm', 'clear', D.PACKAGE]);
    try {
        // 1. The first play, in front.
        var c = await bootApp();
        var p = c.page;
        var before;
        try {
            before = service();
            await playQueue(p, 6);
            await untilPlaying(p, true);
        } finally {
            await P.close(c);
        }
        C.check('before any play: no service', before === null, describeService(before));
        await sleep(1500);
        var s1 = service();
        C.check('the first play, in front: the service runs in the foreground with type mediaPlayback (0x2)',
            s1 && s1.foreground && s1.types === '00000002', describeService(s1));
        C.check('its notification is "Sonance", "Track 01", on the service record (D230: not posted without POST_NOTIFICATIONS)',
            s1 && /channel=playback/.test(s1.notification) && lines(L, /notification "Sonance", "Track 01"$/).length > 0,
            (s1 ? s1.notification : '') + '; dumpsys notification: ' + notificationState());
        shot('b1-playing');

        // 2. Between tracks.
        key('MEDIA_FAST_FORWARD');
        await sleep(2500);
        var s2 = service();
        C.check('kept between tracks: the same record, and the title follows the track',
            s1 && s2 && s2.record === s1.record && s2.foreground && lines(L, /notification "Sonance", "Track 02"$/).length > 0 &&
            lines(L, /service: stop/).length === 0, describeService(s2));

        // 3. Exit.
        c = await connect();
        var focused;
        try {
            focused = await exitByKeys(c.page);
        } finally {
            key('DPAD_CENTER');
            await P.close(c);
        }
        await sleep(2500);
        var s3 = service();
        C.check('Exit stops it', focused !== null && s3 === null && lines(L, /service: stopping \(exit\)/).length === 1 &&
            lines(L, /service: stopped$/).length === 1, 'Exit focused as #' + focused + '; ' + describeService(s3));

        // 4. A first play while hidden: not started; started on the return.
        c = await bootApp();
        p = c.page;
        try {
            key('HOME');
            await sleep(2500);
            await playQueue(p, 6);
            await untilPlaying(p, true);
        } finally {
            await P.close(c);
        }
        await sleep(1500);
        var s4 = service();
        var app = P.pid();
        C.check('a first play while Sonance is hidden does not start it (and nothing is refused)',
            s4 === null && lines(L, /not started while hidden/).length >= 1 && lines(L, /start refused/).length === 0 &&
            players(app).indexOf('started') > -1, describeService(s4) + '; top ' + D.topActivity() + '; MediaPlayer ' + players(app).join(','));
        await bringToFront();
        await sleep(2000);
        var s5 = service();
        C.check('back in front, it starts', s5 && s5.foreground && s5.types === '00000002', describeService(s5));

        // 5. W4: the renderer is lost while playing.
        D.adb(['shell', 'am', 'start', '-n', D.PACKAGE + '/.MainActivity', '--es', 'sonance_url', 'chrome://crash']);
        await sleep(6000);
        var s6 = service();
        var app2 = P.pid();
        C.check('chrome://crash (W4): the service stops, the player is released, the process lives',
            s6 === null && lines(L, /service: stopping \(renderer gone\)/).length === 1 && app2 === app &&
            players(app2).indexOf('started') < 0, describeService(s6) + '; pid ' + app + ' -> ' + app2 + '; MediaPlayer ' + players(app2).join(','));
        shot('b1-after-crash');

        // 6. The activity's end: Sonance's task removed while playing (as from the recents list).
        c = await bootApp();
        try {
            await playQueue(c.page, 6);
            await untilPlaying(c.page, true);
        } finally {
            await P.close(c);
        }
        await sleep(1500);
        var s7 = service();
        var task = /Task\{\S+ #(\d+) [^\n]*A=\d+:dev\.simmo\.sonance/.exec(D.adb(['shell', 'dumpsys', 'activity', 'activities']));
        D.adb(['shell', 'am', 'stack', 'remove', task ? task[1] : '0']);
        await sleep(2500);
        var s8 = service();
        var app3 = P.pid();
        C.check('the task removed: onDestroy stops the service and the player',
            s7 && s7.foreground && s8 === null && lines(L, /service: stopping \(the activity ends\)/).length === 1 &&
            players(app3).indexOf('started') < 0,
            'task #' + (task ? task[1] : '?') + '; before: ' + describeService(s7) + '; after: ' + describeService(s8) +
            '; MediaPlayer ' + (players(app3).join(',') || 'none'));
    } finally {
        await sleep(500);
        L.stop();
    }
    console.log('logcat (service, exit, renderer):\n' + entries(L).filter(function(e) {
        return /service|exit|renderer gone/.test(e.msg);
    }).map(function(e) { return '  ' + clock(e.t) + '  ' + e.msg; }).join('\n'));
    C.print();
    return C.ok;
}

async function b2() {
    var L = startLogcat('b2');
    var C = P.Checks();
    var c = await bootApp();
    var p = c.page;
    var st = function() {
        return p.evaluate(function() {
            var s = Player.getState();
            var d = document.querySelector('#now-playing-bar .play-btn-main svg path').getAttribute('d');
            return { playing: s.isPlaying, av: webapis.avplay.getState(), id: s.currentTrack && s.currentTrack.id,
                at: Math.round(s.currentTime * 100) / 100, icon: d === SonanceUtils.SVG_PATHS.play ? 'play' : 'pause' };
        });
    };
    var fmt = function(s) { return s.id + ' ' + s.av + ' ' + s.at + ' s, isPlaying ' + s.playing + ', bar icon ' + s.icon; };
    try {
        await playQueue(p, 12);
        await untilPlaying(p, true);
        await sleep(1000);
        var app = P.pid();
        C.check('playing: the player holds the focus', focusStack().slice(-1)[0] === 'player GAIN loss none', focusStack().join(' / '));

        // A. Another app takes the focus for good.
        drill('gain');
        await untilPlaying(p, false);
        await sleep(800);
        var a = await st();
        C.check('a permanent loss: Sonance pauses through the app (the bar shows paused), and MediaPlayer is paused',
            !a.playing && a.av === 'PAUSED' && a.icon === 'play' && players(app).indexOf('paused') > -1 &&
            lines(L, /focus: lost: pausing/).length === 1,
            fmt(a) + '; MediaPlayer ' + players(app).join(',') + '; focus ' + focusStack().join(' / '));
        shot('b2-paused-by-focus');
        drill('release');
        await sleep(2000);
        var a2 = await st();
        C.check('the other app lets go: no resume after a permanent loss', !a2.playing && lines(L, /focus: regained/).length === 0,
            fmt(a2) + '; focus ' + focusStack().join(' / '));
        key('MEDIA_PLAY_PAUSE');
        await untilPlaying(p, true);
        C.check('the user plays again: Sonance takes the focus back', focusStack().slice(-1)[0] === 'player GAIN loss none',
            focusStack().join(' / '));

        // B. A transient loss.
        drill('transient');
        await untilPlaying(p, false);
        var b = await st();
        C.check('a transient loss pauses', !b.playing && b.icon === 'play' && lines(L, /focus: lost for now: pausing/).length === 1,
            fmt(b) + '; focus ' + focusStack().join(' / '));
        drill('release');
        await untilPlaying(p, true);
        await sleep(1000);
        var b2s = await st();
        C.check('the regain resumes it', b2s.playing && b2s.icon === 'pause' && players(app).indexOf('started') > -1 &&
            lines(L, /focus: regained: resuming/).length === 1, fmt(b2s) + '; MediaPlayer ' + players(app).join(','));

        // C. The user paused first.
        key('MEDIA_PLAY_PAUSE');
        await untilPlaying(p, false);
        drill('transient');
        await sleep(1000);
        drill('release');
        await sleep(2500);
        var c3 = await st();
        C.check('after the user\'s own pause, a transient loss and its regain leave it paused', !c3.playing &&
            lines(L, /focus: regained: resuming/).length === 2, fmt(c3));

        // D. A duck.
        key('MEDIA_PLAY_PAUSE');
        await untilPlaying(p, true);
        drill('duck');
        await sleep(1000);
        var d1 = await st();
        await sleep(1000);
        var d2 = await st();
        C.check('a duck: the page is not told (still playing), and the engine plays at volume 0.2',
            d1.playing && d2.playing && d2.at > d1.at && lines(L, /focus: duck, volume 0\.2/).length === 1,
            fmt(d1) + ' -> ' + fmt(d2) + '; focus ' + focusStack().join(' / '));
        // The track id changes as the app starts loading, so wait for the engine to start the next
        // stream before the regain.
        var opened = lines(L, / player \d+: started$/).length;
        key('MEDIA_FAST_FORWARD');
        for (var w = 0; w < 25 && lines(L, / player \d+: started$/).length === opened; w++) await sleep(200);
        C.check('a stream opened while ducked starts ducked', lines(L, /: open .*\(ducked, volume 0\.2\)$/).length === 1 &&
            lines(L, /focus: unduck/).length === 0, lines(L, /: open /).slice(-1)[0]);
        drill('release');
        await sleep(1500);
        var d3 = await st();
        C.check('the regain restores the volume; still playing', d3.playing && lines(L, /focus: unduck, volume 1\.0/).length === 1,
            fmt(d3));
        await p.evaluate(function() { Player.pause(); });
    } finally {
        await P.close(c);
        await sleep(500);
        L.stop();
    }
    console.log('logcat (focus):\n' + entries(L).filter(function(e) {
        return /focus|: open |: paused|: started/.test(e.msg);
    }).map(function(e) { return '  ' + clock(e.t) + '  ' + e.msg; }).join('\n'));
    C.print();
    return C.ok;
}

// The browse cycle for the soak's front phase: along the top nav and into each screen's content,
// with the D-pad only (no OK, so the queue is never changed; no Back, so the exit dialog never
// opens).
var BROWSE = [
    ['DPAD_UP', 'DPAD_UP', 'DPAD_UP', 'DPAD_RIGHT', 'DPAD_DOWN', 'DPAD_DOWN', 'DPAD_RIGHT', 'DPAD_DOWN'],
    ['DPAD_UP', 'DPAD_UP', 'DPAD_UP', 'DPAD_LEFT', 'DPAD_DOWN', 'DPAD_DOWN', 'DPAD_DOWN', 'DPAD_UP']
];

async function soak(fgMin, bgMin) {
    fgMin = Number(fgMin) || 30;
    bgMin = Number(bgMin) || 30;
    var L = startLogcat('soak');
    var C = P.Checks();
    var c = await bootApp({ songs: 300 });
    var count;
    try {
        count = await playQueue(c.page);
        await untilPlaying(c.page, true);
        await recordVisibility(c.page);
    } finally {
        await P.close(c);
    }
    var ids0 = processIds();
    mark('front');
    say('soak: ' + count + ' tracks of 20 s queued; ' + fgMin + ' min in front, browsing by keys (pid ' + ids0.host + ')');
    var t0 = Date.now();
    var step = 0;
    while (Date.now() - t0 < fgMin * 60000) {
        var seq = BROWSE[Math.floor(step / 6) % 2];
        for (var i = 0; i < seq.length; i++) {
            key(seq[i]);
            await sleep(400);
        }
        step++;
        if (step % 20 === 0) say('front: ' + Math.round((Date.now() - t0) / 60000) + ' min, top ' + D.topActivity());
        await sleep(12000);
    }
    shot('soak-front');
    meminfo('after ' + fgMin + ' min in front, browsing and playing');

    key('HOME');
    mark('home');
    say('soak: Home; ' + bgMin + ' min with the launcher in front');
    var t1 = Date.now();
    while (Date.now() - t1 < bgMin * 60000) {
        await sleep(60000);
        var power = (/mWakefulness=(\w+)/.exec(D.adb(['shell', 'dumpsys', 'power'])) || [])[1];
        say('background: ' + Math.round((Date.now() - t1) / 60000) + ' min, top ' + D.topActivity() + ', wakefulness ' + power +
            ', service ' + (service() ? 'running' : 'none') + ', MediaPlayer ' + players(ids0.host).join(','));
    }
    var idsEnd = meminfo('after the ' + (fgMin + bgMin) + '-minute soak (' + bgMin + ' min in the background)');
    mark('back');
    await bringToFront();
    c = await connect();
    var end;
    try {
        end = await c.page.evaluate(function() {
            var s = Player.getState();
            return { playing: s.isPlaying, index: s.queueIndex, id: s.currentTrack && s.currentTrack.id, vis: window.__vis.slice(),
                state: document.visibilityState };
        });
        await c.page.evaluate(function() { Player.pause(); });
    } finally {
        await P.close(c);
    }
    await sleep(1000);
    L.stop();

    var all = entries(L);
    var at = function(text) { var e = all.filter(function(x) { return x.msg.indexOf('harness: ' + text) > -1; })[0]; return e ? e.t : 0; };
    var tFront = at('front'), tHome = at('home'), tBack = at('back');
    var g = gaps(all);
    var fg = g.filter(function(x) { return x.at > tFront && x.at < tHome; }).map(function(x) { return x.ms; });
    var bg = g.filter(function(x) { return x.at > tHome && x.at < tBack; }).map(function(x) { return x.ms; });
    var sf = stats(fg), sb = stats(bg);
    var startedBg = all.filter(function(e) { return / player \d+: started$/.test(e.msg) && e.t > tHome && e.t < tBack; });
    var lastBg = startedBg.length ? startedBg[startedBg.length - 1].t : 0;
    var problems = all.filter(function(e) { return /PLAYER_ERROR|renderer gone|service: stop|focus: (lost|refused)/.test(e.msg); });
    console.log('gaps, completed -> next started (ms): front ' + JSON.stringify(sf) + '\n                                       background ' + JSON.stringify(sb));
    console.log('background: Home at ' + clock(tHome) + ', ' + startedBg.length + ' tracks started, the last ' +
        ((lastBg - tHome) / 60000).toFixed(1) + ' min after Home; back at ' + clock(tBack));
    console.log('page: ' + JSON.stringify(end));
    console.log('problems in logcat: ' + (problems.map(function(e) { return clock(e.t) + ' ' + e.msg; }).join('; ') || 'none'));
    C.check('B3: tracks played on in the background for at least 10 min, more than 5 of them after the page was hidden',
        tHome && (tBack - tHome) >= Math.min(10, bgMin) * 60000 && (lastBg - tHome) > Math.min(5, bgMin / 2) * 60000 &&
        end.vis.length >= 1 && /^hidden/.test(end.vis[0]),
        startedBg.length + ' tracks; last start ' + ((lastBg - tHome) / 60000).toFixed(1) + ' min after Home; visibility ' + end.vis.join(', '));
    C.check('B3: the background gap is at most 1.5 s longer than the foreground gap (worst background vs the front median)',
        sf.n > 3 && sb.n > 3 && sb.max <= sf.median + 1500,
        'front median ' + sf.median + ' ms (max ' + sf.max + '), background median ' + sb.median + ' ms (max ' + sb.max + ')');
    C.check('the soak: one process throughout, no error, no renderer loss, the service never stopped, still playing at the end',
        idsEnd.host === ids0.host && problems.length === 0 && end.playing, 'pid ' + ids0.host + ' -> ' + idsEnd.host);
    C.print();
    return C.ok;
}

async function b4(maxWaitMin) {
    var wait = (Number(maxWaitMin) || 18) * 60000;
    var L = startLogcat('b4');
    var C = P.Checks();
    var c = await bootApp({ songs: 300 });
    var set;
    try {
        await playQueue(c.page);
        await untilPlaying(c.page, true);
        await H.navTo(c.page, 'nowplaying');
        await H.settle(c.page, 300);
        // The chip's own handler (OK on it calls the same SleepTimer.cycle()): Off -> 15 min.
        set = await c.page.evaluate(function() {
            var chip = document.getElementById('np-sleep-chip');
            chip.click();
            var t = Date.now();
            console.log('[Sonance] harness: sleep timer set at ' + t);
            return { t: t, label: chip.textContent };
        });
        await recordVisibility(c.page);
    } finally {
        await P.close(c);
    }
    shot('b4-timer-set');
    var deadline = set.t + 15 * 60000;
    var app = P.pid();
    key('HOME');
    mark('home');
    say('b4: "' + set.label + '", deadline ' + clock(deadline) + '; Sonance hidden');
    var t0 = Date.now();
    var paused = null;
    while (!paused && Date.now() - t0 < wait) {
        await sleep(10000);
        paused = entries(L).filter(function(e) { return / player \d+: paused$/.test(e.msg); })[0] || null;
    }
    var mp = players(app);
    var tHome = (entries(L).filter(function(e) { return /harness: home/.test(e.msg); })[0] || {}).t || 0;
    await bringToFront();
    c = await connect();
    var end;
    try {
        end = await c.page.evaluate(function() {
            var chip = document.getElementById('np-sleep-chip');
            return { playing: Player.getState().isPlaying, vis: window.__vis.slice(), chip: chip ? chip.textContent : null };
        });
    } finally {
        await P.close(c);
    }
    await sleep(500);
    L.stop();
    var late = paused ? paused.t - deadline : null;
    console.log('set ' + clock(set.t) + ', Home ' + clock(tHome) + ', deadline ' + clock(deadline) + ', playback paused ' +
        (paused ? clock(paused.t) + ' (' + (late / 1000).toFixed(1) + ' s after the deadline, ' + ((paused.t - tHome) / 60000).toFixed(1) + ' min after Home)' : 'never'));
    console.log('page: ' + JSON.stringify(end) + '; MediaPlayer ' + mp.join(','));
    C.check('the timer was set on Now Playing: "Sleep in 15 min"', /Sleep in 15 min/.test(set.label), set.label);
    C.check('B4: playback stops within 65 s of the deadline while Sonance is hidden', late !== null && late >= 0 && late <= 65000 &&
        end.vis.length >= 1 && /^hidden/.test(end.vis[0]) && !end.playing && mp.indexOf('started') < 0,
        late === null ? 'not stopped' : (late / 1000).toFixed(1) + ' s late');
    C.print();
    return C.ok;
}

if (require.main === module) {
    var checks = { b1: b1, b2: b2, soak: soak, b4: b4 };
    var name = process.argv[2];
    if (!checks[name]) {
        console.error('usage: android-background.js ' + Object.keys(checks).join('|') + ' (soak [fgMin bgMin], b4 [maxWaitMin])');
        process.exit(2);
    }
    checks[name](process.argv[3], process.argv[4]).then(function(ok) {
        console.log(name + ': ' + (ok ? 'PASS' : 'FAIL'));
        process.exitCode = ok ? 0 : 1;
    }, function(e) {
        console.error(e && e.stack || e);
        process.exit(1);
    });
}
