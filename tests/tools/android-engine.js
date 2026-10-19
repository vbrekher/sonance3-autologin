#!/usr/bin/env node
'use strict';

// Sonance — Android TV device checks for PlayerEngine on MediaExtractor, MediaCodec and AudioTrack
// (fix round 1, X1; prompt tickets/prompt-3.xx-androidtv-fix1.md, F2 T3, T4 and T6), on the debug
// build in the sonance-tv emulator. Each check drives webapis.avplay from the page, as a5 does,
// through android-playback.js's proxy, which serves the samples and shapes their answers (cut,
// stall, chunked).
//
// Usage (dev server on 8091; the debug APK installed; <dir> holds the samples):
//   NODE_PATH="$PWD/node_modules" node tests/tools/android-engine.js bad10|cut|ends|stall|skip200|cycles <dir>
//
//   bad10    10 missing tracks in a row: each fails within 3 s (D224), and the decode threads are back
//            to the baseline within 35 s of the last (a stuck setDataSource returns, then releases)
//   cut      a FLAC and an MP3 cut off partway: an error, never "completed" (D242)
//   ends     0.3 s and 6 s files complete once each, also when paused in their last 300 ms; a
//            transcode (no length, no ranges) reports duration 0, plays to its end and completes
//            once; Ogg Vorbis's duration (D226) and its end
//   stall    a 5 s stall partway through a stream gives exactly one bufferingstart and one
//            bufferingcomplete; then 20 normal tracks played to their end give none
//   skip200  200 tracks skipped after a moment each: at most 2 decode threads at any sample (ps -T),
//            at most 1 AudioFlinger track and 1 codec for the app at the end, and native heap growth
//            under 10 MB
//   cycles   50 random open/prepare/play/seek/pause/close cycles in about 30 s: no exception, and no
//            event from a closed session
//
// The samples (never committed) are those a5 uses, plus a 0.3 s WAV and an MP3 with no Xing/Info
// header, which with chunked=1 stands in for a live transcode (no length, no frame count):
//   ffmpeg -f lavfi -i "sine=frequency=330:sample_rate=44100:duration=0.3" -af volume=0.25 -ac 2 \
//     -c:a pcm_s16le short-03-44.wav
//   ffmpeg -f lavfi -i "sine=frequency=330:sample_rate=44100:duration=6" -af volume=0.25 -ac 2 \
//     -c:a libmp3lame -b:a 192k -write_xing 0 mp3-44-live.mp3
// and, for cut, 20 s of noise (large enough that the cut comes after the extractor has read what it
// needs to start: setDataSource reads well past a stream's first 176 KB before it returns):
//   ffmpeg -f lavfi -i "anoisesrc=d=20:c=pink:r=44100:a=0.1" -ac 2 -c:a flac -sample_fmt s16 noise-20s.flac
//   ffmpeg -f lavfi -i "anoisesrc=d=20:c=pink:r=44100:a=0.1" -ac 2 -c:a libmp3lame -b:a 192k noise-20s.mp3
// No live server is used.

var fs = require('fs');
var path = require('path');
var D = require('./android-devtools.js');
var P = require('./android-playback.js');

var SAMPLE = { wav: 'wav-16-44.wav', flac: 'flac-16-44.flac', flac96: 'flac-24-96.flac', mp3: 'mp3-44.mp3', aac: 'aac-44.m4a',
    vorbis: 'vorbis-44.ogg', short: 'short-03-44.wav', wav24: 'wav-24-44.wav', flac192: 'flac-24-192.flac', opus: 'opus-48.opus',
    live: 'mp3-44-live.mp3', noiseFlac: 'noise-20s.flac', noiseMp3: 'noise-20s.mp3' };

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }
function url(file, query) { return P.PROXY + '/codec/' + encodeURIComponent(file) + (query ? '?' + query : ''); }

// The engine's decode threads in the app's process (ps -T names them SonanceDecode-<session>).
function decodeThreads(app) {
    return D.adb(['shell', 'ps', '-T', '-p', app]).split('\n').filter(function(l) { return /SonanceDecode/.test(l); }).length;
}

// AudioFlinger's tracks (active or not) whose client is the app.
function flingerTracks(app) {
    return D.adb(['shell', 'dumpsys', 'media.audio_flinger']).split('\n').filter(function(l) {
        var t = /^\s*(?:\S\s+)?\d+\s+(?:yes|no)\s+(\d+)\s+\d+\s+\d+\s+\S\s+0x[0-9a-f]+\s+[0-9a-f]{8}\s/.exec(l);
        return t && t[1] === app;
    }).length;
}

// The codecs ResourceManagerService holds for the app.
function codecs(app) {
    var lines = D.adb(['shell', 'dumpsys', 'media.resource_manager']).split('\n');
    var mine = false;
    var names = [];
    for (var i = 0; i < lines.length; i++) {
        var pid = /^\s+Pid: (\d+)/.exec(lines[i]);
        if (pid) mine = pid[1] === app;
        else if (/^\s+(Process Pid override|Events logs)/.test(lines[i])) mine = false;
        else if (mine && /^\s+Name: /.test(lines[i])) names.push(lines[i].trim().slice(6));
    }
    return names;
}

// dumpsys meminfo's "Native Heap" row: PSS and the heap's allocated size, in KB.
function nativeHeap(app) {
    var row = D.adb(['shell', 'dumpsys', 'meminfo', app]).split('\n').filter(function(l) { return /^\s+Native Heap\s+\d/.test(l); })[0] || '';
    var n = row.trim().split(/\s+/).slice(2).map(Number);
    return { pss: n[0], alloc: n[6] };
}

// The app's own Logcat lines that report an exception or a generic engine error.
function trouble(app) {
    return D.adb(['logcat', '-d', '--pid=' + app]).split('\n').filter(function(l) {
        return /FATAL|AndroidRuntime|Exception|PLAYER_ERROR_GENEREIC/.test(l);
    });
}

// window.__play(u, o): plays u through webapis.avplay and resolves with its events once it ends
// (completed, or an error), after o.linger ms more (to see a second completion), or at o.timeout.
// o.pauseAt / o.pauseFor: a pause at the first tick at or past that position, then a play.
// o.closeAfter: close that long after play (a skip).
function install(page) {
    return page.evaluate(function() {
        window.__play = function(u, o) {
            o = o || {};
            return new Promise(function(resolve) {
                var av = webapis.avplay;
                var t0 = performance.now();
                var out = { events: [], ticks: 0, last: -1, duration: -1 };
                var finished = false;
                var paused = false;
                function ev(name, x) { out.events.push({ e: name, t: Math.round(performance.now() - t0), x: x }); }
                function done() {
                    if (finished) return;
                    finished = true;
                    clearTimeout(timer);
                    try { av.close(); } catch (e) { /* closed */ }
                    resolve(out);
                }
                var timer = setTimeout(function() { ev('timeout'); done(); }, o.timeout || 15000);
                if (av.getState() !== 'NONE') av.close();
                av.open(u);
                av.setListener({
                    oncurrentplaytime: function(ms) {
                        out.ticks++;
                        out.last = ms;
                        if (o.pauseAt !== undefined && !paused && ms >= o.pauseAt) {
                            paused = true;
                            ev('pause', ms);
                            av.pause();
                            setTimeout(function() { ev('play'); av.play(); }, o.pauseFor || 1000);
                        }
                    },
                    onbufferingstart: function() { ev('bufferingstart'); },
                    onbufferingcomplete: function() { ev('bufferingcomplete'); },
                    onerror: function(e) { ev('error', String(e)); done(); },
                    onstreamcompleted: function() {
                        ev('completed', out.last);
                        setTimeout(done, o.linger || 0);
                    }
                });
                av.prepareAsync(function() {
                    out.duration = av.getDuration();
                    ev('prepared', out.duration);
                    av.play();
                    if (o.closeAfter) setTimeout(done, o.closeAfter);
                }, function(e) { ev('error', e.name + ': ' + e.message); done(); });
            });
        };
    });
}

function count(r, name) { return r.events.filter(function(e) { return e.e === name; }).length; }
function first(r, name) { return r.events.filter(function(e) { return e.e === name; })[0]; }
function show(r) {
    return r.events.map(function(e) { return e.e + '@' + e.t + (e.x !== undefined ? '(' + e.x + ')' : ''); }).join(' ') + '; ' + r.ticks + ' ticks';
}

async function session(dir, fn) {
    P.useSamples(dir);
    var c = await P.bootApp();
    var C = P.Checks();
    try {
        await install(c.page);
        await fn(c.page, C);
    } finally {
        await P.close(c);
    }
    C.print();
    return C.ok;
}

async function bad10(dir) {
    return session(dir, async function(p, C) {
        var app = P.pid();
        var base = decodeThreads(app);
        var worst = 0;
        var slow = [];
        for (var i = 0; i < 10; i++) {
            var r = await p.evaluate(function(u) { return window.__play(u, { timeout: 8000 }); }, url('missing-' + i + '.flac'));
            var e = first(r, 'error');
            if (!e || e.t >= 3000) slow.push(i + ': ' + show(r));
            worst = Math.max(worst, e ? e.t : 99999);
        }
        var tLast = Date.now();
        var threads = decodeThreads(app);
        var peak = threads;
        while (threads > base && Date.now() - tLast < 40000) {
            await sleep(2000);
            threads = decodeThreads(app);
        }
        var back = (Date.now() - tLast) / 1000;
        C.check('10 missing tracks: each fails within 3 s (D224)', slow.length === 0, 'slowest ' + worst + ' ms' + (slow.length ? '; ' + slow.join(' | ') : ''));
        C.check('the decode threads are back to the baseline within 35 s of the last', threads <= base && back <= 35,
            'baseline ' + base + ', ' + peak + ' after the last, ' + threads + ' at ' + back.toFixed(1) + ' s');
    });
}

async function cut(dir) {
    return session(dir, async function(p, C) {
        // Halfway through each 20 s file, a second after that byte was sent; every later range
        // request for it is refused, so the engine's HTTP source gives up after its retries.
        var cases = [SAMPLE.noiseFlac, SAMPLE.noiseMp3];
        for (var i = 0; i < cases.length; i++) {
            var half = Math.floor(fs.statSync(path.join(dir, cases[i])).size / 2);
            var r = await p.evaluate(function(u) { return window.__play(u, { timeout: 90000, linger: 1500 }); },
                url(cases[i], 'cut=' + half + '&hold=1000'));
            var e = first(r, 'error');
            C.check(cases[i] + ' cut off halfway (byte ' + half + '), after it has played: a connection error, never "completed"',
                !!e && /CONNECTION/.test(e.x) && r.last > 3000 && count(r, 'completed') === 0, show(r) + '; last position ' + r.last);
        }
    });
}

async function ends(dir) {
    return session(dir, async function(p, C) {
        var play = function(u, o) { return p.evaluate(function(a) { return window.__play(a.u, a.o); }, { u: u, o: o }); };
        var r = await play(url(SAMPLE.short), { linger: 1500 });
        C.check('0.3 s: completes once', count(r, 'completed') === 1 && count(r, 'error') === 0, show(r));
        r = await play(url(SAMPLE.wav), { linger: 1500, timeout: 12000 });
        C.check('6 s: completes once', count(r, 'completed') === 1 && count(r, 'error') === 0 &&
            first(r, 'completed').t - first(r, 'prepared').t > 5900, show(r));
        // The 0.3 s file's first tick (at 0.2 s) is inside its last 300 ms.
        r = await play(url(SAMPLE.short), { linger: 1500, pauseAt: 0, pauseFor: 1000 });
        C.check('0.3 s, paused in its last 300 ms for 1 s: completes once, after the play', count(r, 'completed') === 1 &&
            count(r, 'error') === 0 && !!first(r, 'play') && first(r, 'completed').t > first(r, 'play').t, show(r));
        r = await play(url(SAMPLE.wav), { linger: 1500, pauseAt: 5750, pauseFor: 1000, timeout: 14000 });
        C.check('6 s, paused in its last 300 ms for 1 s: completes once, after the play', count(r, 'completed') === 1 &&
            count(r, 'error') === 0 && !!first(r, 'pause') && first(r, 'pause').x >= 5700 && first(r, 'completed').t > first(r, 'play').t,
            show(r));
        r = await play(url(SAMPLE.live, 'chunked=1'), { linger: 1500, timeout: 12000 });
        C.check('a transcode (no length, no ranges): duration 0, plays to its end, completes once', r.duration === 0 &&
            count(r, 'completed') === 1 && count(r, 'error') === 0 && r.last >= 5500, show(r) + '; last position ' + r.last);
        r = await play(url(SAMPLE.vorbis), { linger: 1500, timeout: 12000 });
        console.log('D226, Ogg Vorbis (6.0 s): duration ' + r.duration + ' ms, last position ' + r.last + ' ms; ' + show(r));
        C.check('Ogg Vorbis plays to its end and completes once (D226: its duration is an estimate)',
            count(r, 'completed') === 1 && count(r, 'error') === 0 && r.last >= 5500, 'duration ' + r.duration + ' ms');
    });
}

async function stall(dir) {
    return session(dir, async function(p, C) {
        // 3.4 s of the 44.1 kHz 16-bit stereo WAV, then 5 s of nothing: playback starves for about
        // 1.6 s (setDataSource reads well past the first 176 KB, so the stall comes later).
        var r = await p.evaluate(function(u) { return window.__play(u, { linger: 1000, timeout: 20000 }); },
            url(SAMPLE.wav, 'stall=5000&at=600044'));
        var starts = count(r, 'bufferingstart');
        var ends = count(r, 'bufferingcomplete');
        C.check('a 5 s stall: one bufferingstart, then one bufferingcomplete, then the end', starts === 1 && ends === 1 &&
            first(r, 'bufferingstart').t < first(r, 'bufferingcomplete').t && count(r, 'completed') === 1, show(r));
        var files = [SAMPLE.flac, SAMPLE.flac96, SAMPLE.flac192, SAMPLE.mp3, SAMPLE.aac, SAMPLE.wav, SAMPLE.wav24, SAMPLE.vorbis, SAMPLE.opus];
        var events = 0;
        var done = 0;
        var odd = [];
        for (var i = 0; i < 20; i++) {
            var n = await p.evaluate(function(u) { return window.__play(u, { timeout: 12000 }); }, url(files[i % files.length]));
            events += count(n, 'bufferingstart') + count(n, 'bufferingcomplete');
            if (count(n, 'completed') === 1) done++;
            else odd.push(files[i % files.length] + ': ' + show(n));
        }
        C.check('20 normal tracks, each to its end: no buffering event', events === 0 && done === 20,
            events + ' buffering events, ' + done + ' completed' + (odd.length ? '; ' + odd.join(' | ') : ''));
    });
}

async function skip200(dir) {
    return session(dir, async function(p, C) {
        var app = P.pid();
        var files = [SAMPLE.mp3, SAMPLE.flac96, SAMPLE.aac, SAMPLE.wav, SAMPLE.flac, SAMPLE.vorbis];
        var play = function(i) {
            return p.evaluate(function(u) { return window.__play(u, { closeAfter: 150, timeout: 5000 }); }, url(files[i % files.length]));
        };
        for (var w = 0; w < 12; w++) await play(w);
        await sleep(1000);
        var before = nativeHeap(app);
        var threadMax = 0;
        var failed = [];
        for (var i = 0; i < 200; i++) {
            var playing = play(i);
            // Every 10th track, the threads are counted while it plays, the last one's decoder perhaps
            // still ending.
            if (i % 10 === 9) {
                await sleep(100);
                threadMax = Math.max(threadMax, decodeThreads(app));
            }
            var r = await playing;
            if (count(r, 'error') || !count(r, 'prepared')) failed.push(i + ' ' + files[i % files.length] + ': ' + show(r));
        }
        // The last track plays on while the counts are read.
        await p.evaluate(function(u) {
            var av = webapis.avplay;
            av.open(u);
            av.setListener({});
            av.prepareAsync(function() { av.play(); });
        }, url(SAMPLE.mp3));
        await sleep(1500);
        var threads = decodeThreads(app);
        var tracks = flingerTracks(app);
        var held = codecs(app);
        var after = nativeHeap(app);
        await p.evaluate(function() { webapis.avplay.close(); });
        C.check('200 skipped tracks: each prepared, none failed', failed.length === 0, failed.slice(0, 3).join(' | '));
        C.check('at most 2 decode threads at any sample (ps -T)', threadMax <= 2 && threads <= 2,
            'max ' + threadMax + ' (every 10 tracks), ' + threads + ' at the end');
        C.check('at most 1 AudioFlinger track and 1 codec for the app', tracks <= 1 && held.length <= 1,
            tracks + ' track(s); codecs ' + JSON.stringify(held));
        C.check('native heap growth under 10 MB', after.pss - before.pss < 10240 && after.alloc - before.alloc < 10240,
            'PSS ' + before.pss + ' -> ' + after.pss + ' KB, allocated ' + before.alloc + ' -> ' + after.alloc + ' KB');
    });
}

async function cycles(dir) {
    return session(dir, async function(p, C) {
        var app = P.pid();
        D.adb(['logcat', '-c']);
        var r = await p.evaluate(function(urls) {
            // A seeded random sequence (xorshift32), so a failure can be replayed.
            var seed = 20261019;
            function rnd(n) {
                seed ^= seed << 13;
                seed ^= seed >>> 17;
                seed ^= seed << 5;
                return (seed >>> 0) % n;
            }
            function wait(ms) { return new Promise(function(res) { setTimeout(res, ms); }); }
            var av = webapis.avplay;
            var stats = { cycles: 0, ops: 0, pageErrors: 0, late: 0, inflight: 0, events: 0, thrown: [] };
            var newest = 0;
            var newestAt = 0;
            var receive = SonanceShim.receive;
            SonanceShim.receive = function(m) {
                if (m.type === 'player') {
                    var now = performance.now();
                    stats.events++;
                    if (m.session > newest) {
                        newest = m.session;
                        newestAt = now;
                    } else if (m.session < newest) {
                        // An event from an older session: in flight as it closed, or sent after.
                        if (now - newestAt > 100) stats.late++;
                        else stats.inflight++;
                    }
                }
                return receive.apply(this, arguments);
            };
            window.addEventListener('error', function() { stats.pageErrors++; });
            var t0 = performance.now();
            return (async function() {
                for (var i = 0; i < 50; i++) {
                    if (av.getState() !== 'NONE') av.close();
                    av.open(urls[rnd(urls.length)]);
                    av.setListener({});
                    await new Promise(function(res) {
                        var t = setTimeout(res, 1000);
                        av.prepareAsync(function() { clearTimeout(t); res(); }, function() { clearTimeout(t); res(); });
                    });
                    var n = 1 + rnd(4);
                    for (var k = 0; k < n; k++) {
                        var op = rnd(3);
                        try {
                            if (op === 0) av.play();
                            else if (op === 1) av.pause();
                            else av.seekTo(rnd(5000), function() {}, function() {});
                        } catch (e) {
                            // The shim's state machine refuses some (pause before play): AVPlay's own throws.
                            if (e.name !== 'InvalidStateError') stats.thrown.push(e.name + ': ' + e.message);
                        }
                        stats.ops++;
                        await wait(rnd(150));
                    }
                    av.close();
                    stats.cycles++;
                    await wait(rnd(100));
                }
                await wait(1000);
                SonanceShim.receive = receive;
                stats.seconds = Math.round((performance.now() - t0) / 100) / 10;
                return stats;
            })();
        }, [url(SAMPLE.wav), url(SAMPLE.mp3), url(SAMPLE.flac96), url(SAMPLE.aac), url(SAMPLE.vorbis)]);
        var after = P.pid();
        var bad = trouble(app);
        C.check('50 random cycles in about 30 s', r.cycles === 50 && r.seconds <= 35, r.cycles + ' cycles, ' + r.ops + ' operations, ' + r.seconds + ' s');
        C.check('no exception: the page threw nothing unexpected, the process lives, Logcat has no exception or generic error',
            r.pageErrors === 0 && r.thrown.length === 0 && app === after && bad.length === 0,
            'page errors ' + r.pageErrors + ', thrown ' + JSON.stringify(r.thrown) + ', pid ' + app + ' -> ' + after +
            (bad.length ? '; ' + bad.slice(0, 3).join(' | ') : ''));
        C.check('no event from a closed session (none more than 100 ms after a newer session spoke)', r.late === 0,
            r.events + ' events, ' + r.late + ' late, ' + r.inflight + ' in flight within 100 ms');
    });
}

if (require.main === module) {
    var checks = { bad10: bad10, cut: cut, ends: ends, stall: stall, skip200: skip200, cycles: cycles };
    var name = process.argv[2];
    var dir = process.argv[3];
    if (!checks[name] || !dir || !fs.existsSync(dir)) {
        console.error('usage: android-engine.js ' + Object.keys(checks).join('|') + ' <dir of samples>');
        process.exit(2);
    }
    P.startProxy().then(function(server) {
        return checks[name](path.resolve(dir)).then(function(ok) {
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
