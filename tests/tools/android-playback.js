#!/usr/bin/env node
'use strict';

// Sonance — Android TV device checks for playback (ticket-3.xx-androidtv A1-A6, S5, W4; prompt S3
// T4, T5), on the debug build in the sonance-tv emulator: webapis.avplay through the shim, on
// PlayerEngine (MediaExtractor, MediaCodec and AudioTrack since fix round 1, X1).
//
// The page is served through a small proxy on the Mac (port 8092, reversed to the emulator) in
// front of the dev server (8091). The engine fetches media itself, outside the WebView, so the
// proxy is where the harness sees and shapes it:
// - it logs every media request (song id, format, timeOffset, Range, status) for the verdicts;
// - stream.view for an id listed as missing answers 404 (a3);
// - /codec/<file> serves a file from the samples directory given to a5 or level, with byte
//   ranges. Its query shapes the answer (fix round 1, for tests/tools/android-engine.js): cut=N
//   closes the connection after byte N (with hold=MS, MS ms after that byte; and at once for a
//   range from N on); stall=MS&at=N holds the body for MS ms at byte N; chunked=1 sends no length
//   and no ranges, as a live transcode.
// Everything else passes through to the dev server. The page's origin is the proxy, so the mock's
// session (server URL = location.origin) sends its media there.
//
// Usage (dev server on 8091; the debug APK installed):
//   NODE_PATH="$PWD/node_modules" node tests/tools/android-playback.js a1|a3|a4|a6|s5|w4
//   NODE_PATH="$PWD/node_modules" node tests/tools/android-playback.js a5|level <dir of samples>
//
//   a1  play, pause (the remote's play/pause key), a seek while paused, resume, and the next track
//       at the end of one; the engine's tick rate (A2)
//   a3  a track whose stream answers 404 shows its toast and is skipped
//   a4  an Opus track streams as the server's MP3 transcode (no length, no ranges); a seek reloads
//       it with timeOffset and never calls avplay.seekTo
//   a6  a resumed queue starts at its saved position; Right and Left on the Now Playing progress
//       bar seek a direct stream by 10 s
//   s5  dumpsys window: KEEP_SCREEN_ON on Sonance's window while playing, and not while paused
//   w4  chrome://crash while a track plays: the process lives, and the player is released
//   a5  each file in <dir> through webapis.avplay: prepared or its error, the duration, whether
//       the position advances, and (X1) the engine's "pcm" line against AudioFlinger's track for
//       the app: the same encoding and rate (the samples are generated outside the repository,
//       never committed)
//   level  the sine probe (fix round 1, T5): sine-24-96.flac and sine-16-44.flac in <dir>, each a
//       -6 dBFS 1 kHz sine, play to their end, and the debug engine's level of what its AudioTrack
//       was given reads peak 0.50 +- 0.02 and RMS 0.354 +- 0.01. Made with
//         ffmpeg -f lavfi -i "aevalsrc=0.5*sin(2*PI*1000*t)|0.5*sin(2*PI*1000*t):s=96000:d=6" \
//           -c:a flac -sample_fmt s32 -bits_per_raw_sample 24 sine-24-96.flac
//       and the same at s=44100 with -c:a flac -sample_fmt s16 for sine-16-44.flac
//
// Screenshots go to screenshots/androidtv/s3-*.png. No live server is used.

var fs = require('fs');
var http = require('http');
var path = require('path');
var H = require('../../e2e/helpers/sonance.js');
var D = require('./android-devtools.js');

var PROXY_PORT = 8092;
var PROXY = 'http://localhost:' + PROXY_PORT;
var UPSTREAM_PORT = 8091;
var SHOTS = path.resolve(__dirname, '..', '..', 'screenshots', 'androidtv');
var TYPES = {
    '.flac': 'audio/flac', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg',
    '.opus': 'audio/ogg', '.wav': 'audio/wav'
};

var media = [];          // every media request the proxy saw
var missing = {};        // song ids whose stream answers 404 (a3)
var unreadable = {};     // song ids whose stream answers 200 with a body no demuxer reads (a3)
var sampleDir = null;    // a5's samples

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
function key(name) { D.adb(['shell', 'input', 'keyevent', 'KEYCODE_' + name]); }
function pid() { try { return D.adb(['shell', 'pidof', D.PACKAGE]).trim(); } catch (e) { return ''; } }
function shot(name) { return D.screencap(path.join(SHOTS, 's3-' + name + '.png')); }

// ---------------------------------------------------------------------------------------------
// The proxy
// ---------------------------------------------------------------------------------------------

function serveSample(req, res, entry, file, q) {
    fs.stat(file, function(err, st) {
        if (err || !st.isFile()) {
            entry.status = 404;
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('no sample');
            return;
        }
        var headers = { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
        if (q.get('chunked')) {
            // A live transcode: no length, no ranges.
            entry.status = 200;
            res.writeHead(200, { 'Content-Type': headers['Content-Type'] });
            fs.createReadStream(file).pipe(res);
            return;
        }
        var m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
        var start = 0, end = st.size - 1;
        if (m && (m[1] || m[2])) {
            if (m[1]) {
                start = parseInt(m[1], 10);
                if (m[2]) end = Math.min(end, parseInt(m[2], 10));
            } else {
                start = Math.max(0, st.size - parseInt(m[2], 10));
            }
            if (start > end) {
                entry.status = 416;
                res.writeHead(416, { 'Content-Range': 'bytes */' + st.size });
                res.end();
                return;
            }
            headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + st.size;
            entry.status = 206;
        } else {
            entry.status = 200;
        }
        var cut = q.get('cut') !== null ? Number(q.get('cut')) : -1;
        if (cut >= 0 && start >= cut) {
            entry.status = -1;
            req.socket.destroy();
            return;
        }
        headers['Content-Length'] = end - start + 1;
        res.writeHead(entry.status, headers);
        if (req.method === 'HEAD') { res.end(); return; }
        if (cut >= 0) {
            // The body stops at byte `cut`, short of its length, and the connection closes.
            var hold = Number(q.get('hold')) || 0;
            fs.createReadStream(file, { start: start, end: Math.min(end, cut - 1) })
                .on('end', function() { setTimeout(function() { res.destroy(); }, hold); }).pipe(res, { end: false });
            return;
        }
        var stall = Number(q.get('stall')) || 0;
        var at = Number(q.get('at')) || 0;
        if (stall && at > start && at <= end) {
            fs.createReadStream(file, { start: start, end: at - 1 }).on('end', function() {
                setTimeout(function() {
                    if (!res.destroyed) fs.createReadStream(file, { start: at, end: end }).pipe(res);
                }, stall);
            }).pipe(res, { end: false });
            return;
        }
        fs.createReadStream(file, { start: start, end: end }).pipe(res);
    });
}

function startProxy() {
    var server = http.createServer(function(req, res) {
        var u = new URL(req.url, PROXY);
        var entry = null;
        if (/\/stream/.test(u.pathname) || u.pathname.indexOf('/codec/') === 0) {
            entry = {
                t: Date.now(), path: u.pathname, id: u.searchParams.get('id'), format: u.searchParams.get('format'),
                timeOffset: u.searchParams.get('timeOffset'), range: req.headers.range || null, status: 0
            };
            media.push(entry);
        }
        if (entry && u.pathname === '/rest/stream.view' && missing[entry.id]) {
            entry.status = 404;
            res.writeHead(404, { 'Content-Type': 'text/plain', 'Cache-Control': 'no-store' });
            res.end('Not found');
            return;
        }
        if (entry && u.pathname === '/rest/stream.view' && unreadable[entry.id]) {
            // As e2e/track-error-toast.spec.ts's 'format' body.
            var body = Buffer.from('not audio at all '.repeat(200));
            entry.status = 200;
            res.writeHead(200, { 'Content-Type': 'audio/ogg', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
            res.end(body);
            return;
        }
        if (entry && u.pathname.indexOf('/codec/') === 0) {
            serveSample(req, res, entry, path.join(sampleDir || '/nonexistent', path.basename(decodeURIComponent(u.pathname))),
                u.searchParams);
            return;
        }
        var up = http.request({ host: '127.0.0.1', port: UPSTREAM_PORT, method: req.method, path: req.url, headers: req.headers },
            function(r) {
                if (entry) entry.status = r.statusCode;
                res.writeHead(r.statusCode, r.headers);
                r.pipe(res);
            });
        up.on('error', function(e) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end('proxy: ' + e.message);
        });
        req.pipe(up);
    });
    return new Promise(function(resolve) { server.listen(PROXY_PORT, '127.0.0.1', function() { resolve(server); }); });
}

// ---------------------------------------------------------------------------------------------
// The app
// ---------------------------------------------------------------------------------------------

// Boots the bundled app from the proxy on the mock session. `init` runs before the page's scripts
// (a seeded saved queue, for a6).
async function bootApp(init) {
    D.adb(['reverse', 'tcp:' + PROXY_PORT, 'tcp:' + PROXY_PORT]);
    D.adb(['logcat', '-c']);
    D.launch(PROXY + '/index.html');
    var c = await D.connect({ timeout: 20000 });
    var goto = c.page.goto.bind(c.page);
    c.page.goto = function(url) { return goto(new URL(url, PROXY).href); };
    if (init) await c.page.addInitScript(init.fn, init.arg);
    await H.bootBundled(c.page, {});
    return c;
}

async function close(c) {
    try { await c.close(); } catch (e) { /* the page or the app is gone */ }
}

// The engine's events as they reach the shim (each player message, on the page's clock), every
// avplay.seekTo the app makes, and every toast.
function instrument(page) {
    return page.evaluate(function() {
        window.__native = [];
        window.__seeks = [];
        window.__toasts = [];
        var receive = SonanceShim.receive;
        SonanceShim.receive = function(m) {
            if (m.type === 'player') {
                window.__native.push({ t: Math.round(performance.now()), session: m.session, event: m.event,
                    position: m.position, duration: m.duration, error: m.error });
            }
            return receive.apply(this, arguments);
        };
        var seekTo = webapis.avplay.seekTo;
        webapis.avplay.seekTo = function(ms) {
            window.__seeks.push(ms);
            return seekTo.apply(this, arguments);
        };
        var toast = App.showToast;
        App.showToast = function(msg) {
            window.__toasts.push(msg);
            return toast.apply(this, arguments);
        };
    });
}

function state(page) {
    return page.evaluate(function() {
        var s = Player.getState();
        return { id: s.currentTrack ? s.currentTrack.id : null, playing: s.isPlaying,
            at: Math.round(s.currentTime * 1000) / 1000, duration: s.duration, av: webapis.avplay.getState() };
    });
}

function fmt(s) { return s.id + ' ' + s.av + ' ' + s.at.toFixed(2) + ' s / ' + s.duration + ' s'; }

function natives(page) { return page.evaluate(function() { return window.__native.slice(); }); }

// The engine's events, without ticks, plus the tick count and interval.
function describeNatives(list) {
    var out = [];
    var ticks = [];
    list.forEach(function(e) {
        if (e.event === 'tick') { ticks.push(e); return; }
        out.push('  ' + e.t + ' ms  session ' + e.session + ' ' + e.event +
            (e.duration !== undefined ? ' duration ' + e.duration : '') +
            (e.position !== undefined ? ' position ' + e.position : '') + (e.error ? ' ' + e.error : ''));
    });
    out.push('  ticks: ' + ticks.length + tickRate(ticks));
    return out.join('\n');
}

function tickRate(ticks) {
    var gaps = [];
    for (var i = 1; i < ticks.length; i++) {
        if (ticks[i].session === ticks[i - 1].session) gaps.push(ticks[i].t - ticks[i - 1].t);
    }
    if (!gaps.length) return '';
    gaps.sort(function(a, b) { return a - b; });
    return ', interval median ' + gaps[Math.floor(gaps.length / 2)] + ' ms (min ' + gaps[0] + ', max ' + gaps[gaps.length - 1] + ')';
}

function medianGap(ticks) {
    var gaps = [];
    for (var i = 1; i < ticks.length; i++) {
        if (ticks[i].session === ticks[i - 1].session) gaps.push(ticks[i].t - ticks[i - 1].t);
    }
    gaps.sort(function(a, b) { return a - b; });
    return gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
}

function playerLog() {
    return D.adb(['logcat', '-d', '-s', 'Sonance']).split('\n').filter(function(l) {
        return /\] player \d+|renderer gone|exit/.test(l);
    }).map(function(l) { return '  ' + l.trim(); }).join('\n');
}

// Sonance's window flags, from dumpsys window. A force-stopped process's window may linger, EXITING,
// for a while after the next launch, so only a live window counts.
function windowFlags() {
    var out = D.adb(['shell', 'dumpsys', 'window', 'windows']);
    var blocks = out.split(/\n\s*Window #\d+ /).filter(function(b) {
        var head = b.split('\n')[0];
        return head.indexOf(D.PACKAGE + '/' + D.PACKAGE + '.MainActivity') > -1 && head.indexOf('EXITING') < 0;
    });
    var m = /\sfl=([^\n]*)/.exec(blocks[0] || '');
    return (m ? m[1].trim() : '(no window)') + (blocks.length > 1 ? ' (' + blocks.length + ' windows)' : '');
}

function Checks() {
    var lines = [];
    var ok = true;
    return {
        check: function(label, pass, detail) {
            ok = ok && !!pass;
            lines.push((pass ? 'ok   ' : 'FAIL ') + label + (detail ? '  [' + detail + ']' : ''));
        },
        print: function() { console.log(lines.join('\n')); },
        get ok() { return ok; }
    };
}

function waitFor(page, fn, arg, timeout) {
    return page.waitForFunction(fn, arg, { timeout: timeout || 10000 });
}

// ---------------------------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------------------------

async function a1() {
    var c = await bootApp();
    var p = c.page;
    var C = Checks();
    try {
        await instrument(p);
        await p.evaluate(function() { Player.setQueue(window.__MOCK__.songs.slice(0, 3), 0); });
        await waitFor(p, function() { return Player.getState().isPlaying && Player.getState().currentTime > 0.5; });
        var s1 = await state(p);
        await sleep(1000);
        var s2 = await state(p);
        C.check('play: song-0 plays on AVPlay, and its position advances with the clock',
            s1.av === 'PLAYING' && s2.at - s1.at > 0.7 && s2.at - s1.at < 1.4, fmt(s1) + ' -> ' + fmt(s2));

        key('MEDIA_PLAY_PAUSE');
        await waitFor(p, function() { return !Player.getState().isPlaying; }, null, 5000);
        await sleep(300);
        var p1 = await state(p);
        await sleep(1000);
        var p2 = await state(p);
        C.check('pause (the remote\'s play/pause): PAUSED, and the position holds', p1.av === 'PAUSED' && p1.at === p2.at,
            fmt(p1) + ' -> ' + fmt(p2));

        await p.evaluate(function() { Player.seekTo(10); });
        await sleep(600);
        var k = await state(p);
        var seeked = (await natives(p)).filter(function(e) { return e.event === 'seeked'; });
        C.check('seek while paused: the engine reports 10 s', k.av === 'PAUSED' && seeked.length === 1 &&
            Math.abs(seeked[0].position - 10000) < 50 && Math.abs(k.at - 10) < 0.06,
            fmt(k) + '; seeked ' + JSON.stringify(seeked.map(function(e) { return e.position; })));

        key('MEDIA_PLAY_PAUSE');
        await waitFor(p, function() { return Player.getState().isPlaying; }, null, 5000);
        await sleep(1000);
        var r = await state(p);
        C.check('resume: playing on from 10 s', r.av === 'PLAYING' && r.at > 10.5 && r.at < 11.8, fmt(r));
        shot('a1-playing');

        // Three seconds from the end, the next track starts by itself (onstreamcompleted).
        await p.evaluate(function() { Player.seekTo(17); });
        await waitFor(p, function() {
            var s = Player.getState();
            return s.currentTrack.id === 'song-1' && webapis.avplay.getState() === 'PLAYING' && s.currentTime > 0.3;
        });
        var n = await state(p);
        var list = await natives(p);
        var completed = list.filter(function(e) { return e.event === 'completed'; });
        C.check('the end of song-0 starts song-1', n.id === 'song-1' && n.playing && completed.length === 1, fmt(n));
        var ticks = list.filter(function(e) { return e.event === 'tick'; });
        var gap = medianGap(ticks);
        C.check('A2: ticks every 200 ms while playing', gap >= 180 && gap <= 240, ticks.length + ' ticks' + tickRate(ticks));
        await p.evaluate(function() { Player.pause(); });
        console.log('engine events:\n' + describeNatives(list));
    } finally {
        await close(c);
    }
    console.log('logcat:\n' + playerLog());
    C.print();
    return C.ok;
}

async function a3() {
    missing = { 'song-1': true };
    unreadable = { 'song-2': true };
    var c = await bootApp();
    var p = c.page;
    var C = Checks();
    try {
        await instrument(p);
        var t0 = await p.evaluate(function() {
            Player.setQueue(window.__MOCK__.songs.slice(0, 4), 1);
            return performance.now();
        });
        // The two toasts come about 20 ms apart, so only the second can be captured.
        await waitFor(p, function() {
            var s = Player.getState();
            return s.currentTrack.id === 'song-3' && webapis.avplay.getState() === 'PLAYING';
        });
        shot('a3-toast-format');
        var s = await state(p);
        var r = await p.evaluate(function() { return window.__toasts.slice(); });
        var list = await natives(p);
        var errors = list.filter(function(e) { return e.event === 'error'; });
        var hit = media.filter(function(m) { return m.id === 'song-1'; });
        C.check('the stream of song-1 answered 404', hit.length > 0 && hit.every(function(m) { return m.status === 404; }),
            hit.map(function(m) { return m.status + (m.range ? ' (' + m.range + ')' : ''); }).join(', '));
        C.check('the engine reports a connection error for the 404 within 3 s (D224), and a format error for the unreadable body',
            errors.length === 2 && errors[0].error === 'PLAYER_ERROR_CONNECTION_FAILED' && errors[0].t - t0 < 3000 &&
            errors[1].error === 'PLAYER_ERROR_NOT_SUPPORTED_FILE',
            errors.map(function(e) { return e.error + ' @' + Math.round(e.t - t0) + ' ms'; }).join(', '));
        C.check('their toasts: "Track 02 — couldn\'t be loaded", then "Track 03 — format not supported"',
            r.length === 2 && r[0] === 'Track 02 — couldn\'t be loaded' && r[1] === 'Track 03 — format not supported',
            JSON.stringify(r));
        C.check('both are skipped: song-3 plays', s.id === 'song-3' && s.playing, fmt(s));
        await p.evaluate(function() { Player.pause(); });
        console.log('engine events:\n' + describeNatives(list));
    } finally {
        await close(c);
    }
    console.log('logcat:\n' + playerLog());
    C.print();
    return C.ok;
}

async function a4() {
    var c = await bootApp();
    var p = c.page;
    var C = Checks();
    try {
        await instrument(p);
        media.length = 0;
        await p.evaluate(function() { Player.setQueue([window.__MOCK__.songs[4], window.__MOCK__.songs[5]], 0); });
        await waitFor(p, function() { return Player.getState().isPlaying && Player.getState().currentTime > 0.5; });
        var s1 = await state(p);
        await sleep(1000);
        var s2 = await state(p);
        var first = media.filter(function(m) { return m.id === 'song-4'; });
        C.check('song-4 (Opus) streams as the MP3 transcode', first.length > 0 && first.every(function(m) {
            return m.format === 'mp3' && !Number(m.timeOffset);
        }), JSON.stringify(first.map(function(m) { return { format: m.format, timeOffset: m.timeOffset, range: m.range, status: m.status }; })));
        C.check('the progressive MP3 plays: the position advances; the duration is the track\'s', s1.av === 'PLAYING' &&
            s2.at - s1.at > 0.7 && s2.at - s1.at < 1.4 && s2.duration === 184, fmt(s1) + ' -> ' + fmt(s2));

        var before = media.length;
        await p.evaluate(function() { Player.seekTo(60); });
        await waitFor(p, function() {
            return webapis.avplay.getState() === 'PLAYING' && Player.getState().currentTime > 60.5;
        });
        await sleep(1000);
        var s3 = await state(p);
        var reload = media.slice(before).filter(function(m) { return m.id === 'song-4'; });
        var seeks = await p.evaluate(function() { return window.__seeks.slice(); });
        C.check('a seek reloads the transcode with timeOffset=60', reload.length > 0 && reload.every(function(m) {
            return m.format === 'mp3' && m.timeOffset === '60';
        }), JSON.stringify(reload.map(function(m) { return { timeOffset: m.timeOffset, status: m.status }; })));
        C.check('it plays on from 60 s', s3.av === 'PLAYING' && s3.at > 61 && s3.at < 62.6, fmt(s3));
        C.check('avplay.seekTo is never called on a transcode', seeks.length === 0, JSON.stringify(seeks));
        await p.evaluate(function() { Player.pause(); });
        console.log('engine events:\n' + describeNatives(await natives(p)));
    } finally {
        await close(c);
    }
    console.log('logcat:\n' + playerLog());
    C.print();
    return C.ok;
}

async function a6() {
    // A8's saved queue for this boot: song-1 of three, at 4 s. Seeded once per launch.
    var c = await bootApp({
        fn: function(q) {
            if (!sessionStorage.getItem('__seeded__')) {
                localStorage.setItem('__mock_playqueue__', JSON.stringify(q));
                sessionStorage.setItem('__seeded__', '1');
            }
        },
        arg: { ids: ['song-0', 'song-1', 'song-2'], index: 1, position: 4000, byIndex: true }
    });
    var p = c.page;
    var C = Checks();
    try {
        await waitFor(p, function() { return !!Player.getState().currentTrack; });
        await H.settle(p, 300);
        await instrument(p);
        var cued = await state(p);
        C.check('the saved queue is restored, paused, with nothing opened', cued.id === 'song-1' && !cued.playing &&
            cued.av === 'NONE', fmt(cued));

        key('MEDIA_PLAY_PAUSE');
        await waitFor(p, function() { return Player.getState().isPlaying && webapis.avplay.getState() === 'PLAYING'; });
        await sleep(800);
        var r = await state(p);
        var list = await natives(p);
        var seeks = await p.evaluate(function() { return window.__seeks.slice(); });
        var ev = list.filter(function(e) { return e.event !== 'tick'; }).map(function(e) {
            return e.event + (e.position !== undefined ? ' ' + e.position : '');
        });
        var firstTick = list.filter(function(e) { return e.event === 'tick'; })[0];
        // Fix round 1, T4: "seeked" is the target +- 1 ms, and the first tick lands from the target
        // to the target + 400 ms.
        C.check('Play resumes it at 4 s: a seek in READY, then play', seeks.length === 1 && seeks[0] === 4000 &&
            ev[0] === 'prepared' && /^seeked \d+$/.test(ev[1]) && Math.abs(Number(ev[1].split(' ')[1]) - 4000) <= 1 &&
            r.at > 4.4 && r.at < 5.6 && firstTick.position >= 4000 && firstTick.position <= 4400,
            fmt(r) + '; seekTo ' + JSON.stringify(seeks) + '; events ' + ev.join(', ') + '; first tick ' + firstTick.position);

        // The Now Playing progress bar, by the remote's keys.
        await H.navTo(p, 'nowplaying');
        await H.press(p, 'ArrowDown');
        await H.settle(p, 200);
        await H.press(p, 'ArrowUp');
        await H.settle(p, 200);
        var f = await H.focus(p);
        C.check('focus is on the progress bar', f.zone === 'np-progress', f.zone);
        shot('a6-np-progress');
        var steps = [['DPAD_LEFT', -10], ['DPAD_RIGHT', 10], ['DPAD_LEFT', -10]];
        for (var i = 0; i < steps.length; i++) {
            var b = await state(p);
            var n = (await p.evaluate(function() { return window.__seeks.length; }));
            var k0 = (await natives(p)).length;
            key(steps[i][0]);
            await waitFor(p, function(count) { return window.__seeks.length > count; }, n, 5000);
            await sleep(700);
            var a = await state(p);
            var asked = (await p.evaluate(function() { return window.__seeks.slice(); })).slice(n);
            var want = Math.max(0, Math.min(b.duration, b.at + steps[i][1]));
            var later = (await natives(p)).slice(k0);
            var sk = later.filter(function(e) { return e.event === 'seeked'; });
            var tk = sk.length ? later.filter(function(e) { return e.event === 'tick' && e.t >= sk[0].t; })[0] : null;
            var target = Math.round(asked[0]);
            // The app's target is its position at the key press, a moment after `b`. T4: the seek
            // lands on its target, and the first tick after it within 400 ms of it.
            C.check(steps[i][0] + ': a direct stream seeks ' + (steps[i][1] > 0 ? '+' : '') + steps[i][1] + ' s',
                asked.length === 1 && Math.abs(asked[0] / 1000 - want) < 0.8 && a.av === 'PLAYING' &&
                a.at >= asked[0] / 1000 && a.at < asked[0] / 1000 + 1.2 && sk.length === 1 &&
                Math.abs(sk[0].position - target) <= 1 && !!tk && tk.position >= target && tk.position <= target + 400,
                'before ' + b.at.toFixed(2) + ' s, seekTo ' + asked.join(',') + ' ms, seeked ' +
                (sk.length ? sk.map(function(e) { return e.position; }).join(',') : 'none') + ', first tick ' +
                (tk ? tk.position : 'none') + ', after ' + a.at.toFixed(2) + ' s');
        }
        await p.evaluate(function() { Player.pause(); });
        console.log('engine events:\n' + describeNatives(await natives(p)));
    } finally {
        await close(c);
    }
    console.log('logcat:\n' + playerLog());
    C.print();
    return C.ok;
}

// WHY detached: while a DevTools session is attached, Chromium itself keeps the screen on (the
// WebView's keepScreenOn), so the window shows KEEP_SCREEN_ON whatever the app does. The track is
// set up through DevTools, paused, and the session closed; from then on only the remote's
// play/pause key drives it, and dumpsys audio (the AudioTrack's state) tells playing from paused.
async function s5() {
    var c = await bootApp();
    try {
        await c.page.evaluate(function() { Player.setQueue(window.__MOCK__.songs.slice(0, 2), 0); });
        await waitFor(c.page, function() { return Player.getState().isPlaying && webapis.avplay.getState() === 'PLAYING'; });
        await c.page.evaluate(function() { Player.pause(); });
    } finally {
        await close(c);
    }
    var C = Checks();
    var app = pid();
    var keep = function(f) { return /KEEP_SCREEN_ON/.test(f); };
    var steps = [['paused, DevTools detached', null, false], ['play/pause: playing', 'started', true],
        ['play/pause: paused', 'paused', false], ['play/pause: playing again', 'started', true],
        ['play/pause: paused again', 'paused', false]];
    for (var i = 0; i < steps.length; i++) {
        if (i > 0) key('MEDIA_PLAY_PAUSE');
        await sleep(1500);
        var f = windowFlags();
        var players = audioPlayers(app);
        var stateOk = steps[i][1] === null || players.some(function(l) { return l.indexOf('state:' + steps[i][1]) > -1; });
        C.check(steps[i][0] + (steps[i][2] ? ': KEEP_SCREEN_ON' : ': no KEEP_SCREEN_ON'), stateOk && keep(f) === steps[i][2],
            'fl=' + f + '; ' + (players.join('; ') || 'no player'));
    }
    console.log('logcat:\n' + D.adb(['logcat', '-d', '-s', 'Sonance']).split('\n').filter(function(l) {
        return /keep screen on/.test(l);
    }).map(function(l) { return '  ' + l.trim(); }).join('\n'));
    C.print();
    return C.ok;
}

// The engine's player in dumpsys audio (AudioPlaybackConfiguration) for this process, if any: its
// AudioTrack since X1 (the engine creates no other player type).
function audioPlayers(processId) {
    return D.adb(['shell', 'dumpsys', 'audio']).split('\n').filter(function(l) {
        return /AudioPlaybackConfiguration/.test(l) && / type:android\.media\.AudioTrack /.test(l) &&
            l.indexOf('/' + processId + ' ') > -1;
    }).map(function(l) { return l.trim().replace(/\s+attr:.*$/, ''); });
}

// X1: AudioFlinger's format codes (audio_format_t) by the names the engine's "pcm" line uses.
var AF_FORMATS = { '00000001': '16-bit', '00000002': '8-bit', '00000003': '32-bit', '00000005': 'float', '00000006': '24-bit' };

// The engine's last "pcm" line (the AudioTrack it opened), and AudioFlinger's active tracks whose
// client is this app.
function trackFormat() {
    var app = pid();
    var line = D.adb(['logcat', '-d', '-s', 'Sonance']).split('\n').filter(function(l) { return /\] player \d+: pcm /.test(l); }).pop();
    var m = line && /player (\d+): pcm (\S+) -> (\S+), (\d+) Hz, (\d+) ch/.exec(line);
    var tracks = [];
    D.adb(['shell', 'dumpsys', 'media.audio_flinger']).split('\n').forEach(function(l) {
        var t = /^\s*(?:\S\s+)?\d+\s+yes\s+(\d+)\s+\d+\s+\d+\s+\S\s+0x[0-9a-f]+\s+([0-9a-f]{8})\s+[0-9a-f]{8}\s+(\d+)\s/.exec(l);
        if (t && t[1] === app) tracks.push({ format: AF_FORMATS[t[2]] || t[2], rate: Number(t[3]) });
    });
    return { pcm: m ? { session: Number(m[1]), from: m[2], to: m[3], rate: Number(m[4]), ch: Number(m[5]) } : null, tracks: tracks };
}

async function w4() {
    var c = await bootApp();
    var p = c.page;
    var C = Checks();
    var before = pid();
    try {
        await p.evaluate(function() { Player.setQueue(window.__MOCK__.songs.slice(0, 3), 0); });
        await waitFor(p, function() { return Player.getState().isPlaying && Player.getState().currentTime > 1; });
    } finally {
        await close(c);
    }
    var playersBefore = audioPlayers(before);
    var flagsBefore = windowFlags();
    D.adb(['logcat', '-c']);
    D.adb(['shell', 'am', 'start', '-n', D.PACKAGE + '/.MainActivity', '--es', 'sonance_url', 'chrome://crash']);
    await sleep(6000);
    var after = pid();
    var log = playerLog();
    var playersAfter = audioPlayers(after);
    var flagsAfter = windowFlags();
    var c2 = await D.connect({ timeout: 20000 });
    var now;
    try {
        await c2.page.waitForFunction(function() {
            return !document.getElementById('splash') && typeof App !== 'undefined' &&
                (!!App.getCurrentScreen() || !!document.querySelector('.login-screen'));
        }, null, { timeout: 15000 });
        now = await c2.page.evaluate(function() {
            return { url: location.href, screen: App.getCurrentScreen() || 'login', av: webapis.avplay.getState() };
        });
    } finally {
        await close(c2);
    }
    shot('w4-recovered-after-playback');
    console.log('logcat:\n' + log);
    console.log('dumpsys audio, before: ' + JSON.stringify(playersBefore) + '\ndumpsys audio, after:  ' + JSON.stringify(playersAfter));
    console.log('fl= before: ' + flagsBefore + '\nfl= after:  ' + flagsAfter);
    C.check('the process lives', !!before && before === after, before + ' -> ' + after);
    C.check('the renderer was replaced, and the player released', /renderer gone/.test(log) &&
        /player \d+: released/.test(log.split('renderer gone')[1] || ''));
    C.check('nothing plays: no started player for the process', playersBefore.some(function(l) { return /state:started/.test(l); }) &&
        !playersAfter.some(function(l) { return /state:started/.test(l); }));
    C.check('the screen may sleep again', /KEEP_SCREEN_ON/.test(flagsBefore) && !/KEEP_SCREEN_ON/.test(flagsAfter));
    C.check('a fresh app, nothing opened', now && now.av === 'NONE', JSON.stringify(now));
    C.print();
    return C.ok;
}

async function a5(dir) {
    if (!dir || !fs.existsSync(dir)) throw new Error('a5: give the directory of samples');
    sampleDir = path.resolve(dir);
    var files = fs.readdirSync(sampleDir).filter(function(f) { return TYPES[path.extname(f)]; }).sort();
    var c = await bootApp();
    var p = c.page;
    var rows = [];
    var errors = [];
    var ok = true;
    try {
        for (var i = 0; i < files.length; i++) {
            var url = PROXY + '/codec/' + encodeURIComponent(files[i]);
            D.adb(['logcat', '-c']);
            var r = await p.evaluate(function(u) {
                return new Promise(function(resolve) {
                    var av = webapis.avplay;
                    var out = { prepared: false, error: null, duration: 0 };
                    window.__a5 = { ticks: [], error: null };
                    if (av.getState() !== 'NONE') av.close();
                    av.open(u);
                    av.setListener({
                        oncurrentplaytime: function(ms) { window.__a5.ticks.push(ms); },
                        onerror: function(e) { window.__a5.error = String(e); },
                        onstreamcompleted: function() { window.__a5.completed = true; }
                    });
                    var timer = setTimeout(function() { out.error = 'no answer in 8 s'; resolve(out); }, 8000);
                    av.prepareAsync(function() {
                        clearTimeout(timer);
                        out.prepared = true;
                        out.duration = av.getDuration();
                        av.play();
                        resolve(out);
                    }, function(e) {
                        clearTimeout(timer);
                        out.error = e.name + ': ' + e.message;
                        resolve(out);
                    });
                });
            }, url);
            // X1: the AudioTrack the engine opened against the track AudioFlinger mixes, a second in.
            var tf = null;
            if (r.prepared) {
                await sleep(1000);
                tf = trackFormat();
                await sleep(1000);
            }
            var t = await p.evaluate(function() {
                try { webapis.avplay.close(); } catch (e) { /* closed */ }
                return window.__a5;
            });
            errors = errors.concat(D.adb(['logcat', '-d', '-s', 'Sonance']).split('\n').filter(function(l) { return /PLAYER_ERROR/.test(l); }));
            var ticks = t.ticks;
            var error = r.error || t.error;
            var advanced = ticks.length >= 5 && ticks[ticks.length - 1] - ticks[0] > 1000;
            var plays = r.prepared && !error && advanced;
            var match = !!tf && !!tf.pcm && tf.tracks.length === 1 && tf.tracks[0].format === tf.pcm.to && tf.tracks[0].rate === tf.pcm.rate;
            if (plays && !match) ok = false;
            rows.push((plays ? 'plays  ' : 'FAILS  ') + files[i].padEnd(20) + (r.prepared ? 'duration ' + r.duration + ' ms, ' : '') +
                (ticks.length ? 'position ' + ticks[0] + ' -> ' + ticks[ticks.length - 1] + ' ms (' + ticks.length + ' ticks)' : 'no ticks') +
                (error ? ', ' + error : '') +
                (tf ? '\n       pcm ' + (tf.pcm ? tf.pcm.from + ' -> ' + tf.pcm.to + ', ' + tf.pcm.rate + ' Hz, ' + tf.pcm.ch + ' ch' : 'none') +
                    '; AudioFlinger ' + (tf.tracks.map(function(x) { return x.format + ' ' + x.rate + ' Hz'; }).join(', ') || 'no track') +
                    (plays ? (match ? ': match' : ': MISMATCH') : '') : ''));
        }
    } finally {
        await close(c);
    }
    console.log(rows.join('\n'));
    console.log('logcat (errors):\n' + errors.map(function(l) { return '  ' + l.trim(); }).join('\n'));
    return ok;
}

// Fix round 1, T5: the sine probe.
var LEVEL_FILES = ['sine-24-96.flac', 'sine-16-44.flac'];

async function level(dir) {
    if (!dir || !fs.existsSync(dir)) throw new Error('level: give the directory of samples');
    sampleDir = path.resolve(dir);
    var c = await bootApp();
    var p = c.page;
    var C = Checks();
    try {
        for (var i = 0; i < LEVEL_FILES.length; i++) {
            D.adb(['logcat', '-c']);
            var r = await p.evaluate(function(u) {
                return new Promise(function(resolve) {
                    var av = webapis.avplay;
                    var out = { completed: false, error: null };
                    if (av.getState() !== 'NONE') av.close();
                    av.open(u);
                    var timer = setTimeout(function() { out.error = out.error || 'not completed in 12 s'; done(); }, 12000);
                    function done() {
                        clearTimeout(timer);
                        try { av.close(); } catch (e) { /* closed */ }
                        resolve(out);
                    }
                    av.setListener({
                        onerror: function(e) { out.error = String(e); done(); },
                        onstreamcompleted: function() { out.completed = true; done(); }
                    });
                    av.prepareAsync(function() { av.play(); }, function(e) { out.error = e.name + ': ' + e.message; done(); });
                });
            }, PROXY + '/codec/' + LEVEL_FILES[i]);
            var log = D.adb(['logcat', '-d', '-s', 'Sonance']).split('\n');
            var lv = log.filter(function(l) { return /\] player \d+: level /.test(l); }).pop() || '';
            var pcm = (log.filter(function(l) { return /\] player \d+: pcm /.test(l); }).pop() || '').replace(/^.*\] player \d+: /, '');
            var m = /level peak ([\d.]+), rms ([\d.]+) \((\d+) samples\)/.exec(lv);
            var peak = m ? Number(m[1]) : NaN;
            var rms = m ? Number(m[2]) : NaN;
            C.check(LEVEL_FILES[i] + ': at the AudioTrack\'s input, peak 0.50 +- 0.02 and RMS 0.354 +- 0.01',
                r.completed && !r.error && Math.abs(peak - 0.5) <= 0.02 && Math.abs(rms - 0.354) <= 0.01,
                (m ? 'peak ' + m[1] + ', rms ' + m[2] + ' (' + m[3] + ' samples)' : 'no level line') + '; ' + (pcm || 'no pcm line') +
                (r.error ? '; ' + r.error : '; completed'));
        }
    } finally {
        await close(c);
    }
    C.print();
    return C.ok;
}

// For tests/tools/android-background.js (S4) and android-engine.js (fix round 1).
module.exports = {
    PROXY: PROXY, media: media, startProxy: startProxy, bootApp: bootApp, close: close, instrument: instrument,
    state: state, fmt: fmt, playerLog: playerLog, windowFlags: windowFlags, audioPlayers: audioPlayers,
    Checks: Checks, waitFor: waitFor, pid: pid, trackFormat: trackFormat,
    useSamples: function(dir) { sampleDir = path.resolve(dir); }
};

if (require.main === module) {
    var checks = { a1: a1, a3: a3, a4: a4, a5: a5, a6: a6, s5: s5, w4: w4, level: level };
    var name = process.argv[2];
    if (!checks[name]) {
        console.error('usage: android-playback.js ' + Object.keys(checks).join('|') + ' (a5 and level <dir>)');
        process.exit(2);
    }
    startProxy().then(function(server) {
        return checks[name](process.argv[3]).then(function(ok) {
            // The engine's HTTP source may hold a keep-alive connection open.
            server.closeAllConnections();
            server.close();
            console.log(name + ': ' + (ok ? 'PASS' : 'FAIL'));
            process.exitCode = ok ? 0 : 1;
        });
    }).catch(function(e) {
        console.error(e && e.stack || e);
        process.exit(1);
    });
}
