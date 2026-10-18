#!/usr/bin/env node
'use strict';

// Sonance — Android TV layout parity (ticket-3.xx-androidtv W2, §7.2; prompt S1 T5).
//
// Puts the bundled app into the same states in desktop Chromium (1920x1080, DPR 1, the e2e
// suite's browser) and in the app's WebView on the emulator, seeded the same way (bootBundled: the
// mock session from tests/mock-boot.js, through init scripts), then measures the nav bar, cards,
// the NP bar and the NP controls in both and compares them at +-2 CSS px. Device screenshots are
// the physical screen (adb screencap) into screenshots/androidtv/.
//
// Usage (dev server on 8091; a debug build installed; adb reverse is set up here):
//   NODE_PATH="$PWD/node_modules" node tests/tools/android-parity.js <outDir> --scale 1 [--only a,b]
//
// Boxes whose size or place follows text metrics differ by design: SamsungOne exists on neither
// side, so desktop Chromium on macOS draws the fallback in Helvetica and Android in Roboto (G1).
// Every box is reported with a `text` flag (it holds text), so those are listed, not hidden.

var fs = require('fs');
var path = require('path');
var { chromium } = require('playwright');
var H = require('../../e2e/helpers/sonance.js');
var G = require('../../e2e/helpers/geometry.js');
var D = require('./android-devtools.js');

var BASE = D.DEV_SERVER;
var FIXTURES = { albums: 120, artists: 80, songs: 400 };
var TOLERANCE = 2;

function arg(name, dflt) {
    var i = process.argv.indexOf(name);
    return i > -1 ? process.argv[i + 1] : dflt;
}

var outDir = process.argv[2];
if (!outDir || outDir.indexOf('--') === 0) {
    console.error('usage: android-parity.js <outDir> --scale N [--only a,b]');
    process.exit(2);
}
var scale = parseFloat(arg('--scale', '1.5'));
var only = arg('--only', null);
var shotDir = path.resolve(__dirname, '..', '..', 'screenshots', 'androidtv');

// The geometry under test (ticket §7.2 W2): nav bar, cards, NP bar, NP controls; plus the album's
// rows and buttons on the album state.
var SELECTORS = [
    '#top-nav', '#top-nav-bar', '#top-nav-pill', '.top-nav-item',
    '.album-card', '.album-card-art', '.album-grid-card', '.playlist-card',
    '#now-playing-bar', '.now-playing-bar-art', '.np-bar-open', '.np-bar-btn',
    '.np-ctrl-play', '.np-ctrl-btn', '#np-progress-bar', '.np-left',
    '.track-row', '.album-play-btn'
];

async function bootWithTrack(page, extra) {
    await H.bootBundled(page, Object.assign({}, FIXTURES, { scale: scale, extra: extra }));
    await page.evaluate(function() {
        Player.setQueue(window.__MOCK__.songs.slice(0, 20), 0);
    });
    await page.waitForFunction(function() { return !!Player.getState().currentTrack; });
    await page.evaluate(function() { Player.pause(); Player.seekTo(0); });
    await H.settle(page, 250);
}

async function enterLibraryTab(page) {
    await H.navTo(page, 'library');
    await H.press(page, 'ArrowDown');
    await H.settle(page, 250);
}

// The prompt's T5 set: Home, Albums, an album, Now Playing with lyrics open, Settings
// (the visual baseline's sequences, on the bundled build).
var STATES = [
    ['home', async function(p) {
        await bootWithTrack(p);
        await H.press(p, 'ArrowDown');
    }],
    ['library-albums', async function(p) {
        await bootWithTrack(p);
        await enterLibraryTab(p);
    }],
    ['album-detail', async function(p) {
        await bootWithTrack(p);
        await enterLibraryTab(p);
        await H.press(p, 'Enter');
        await H.waitForScreen(p, 'album');
    }],
    ['nowplaying-lyrics', async function(p) {
        await bootWithTrack(p, 'mockLyrics=1');
        await H.navTo(p, 'nowplaying');
        await H.press(p, 'ArrowDown');       // np-controls, Play
        await H.settle(p, 150);
        await H.press(p, 'ArrowRight', 4, 120); // the lyrics button
        await H.press(p, 'Enter');
        await p.waitForTimeout(900);         // lyrics slide
    }],
    ['settings-top', async function(p) {
        await bootWithTrack(p);
        await H.navTo(p, 'settings');
        await H.press(p, 'ArrowDown');
    }]
];

function measure(page) {
    return page.evaluate(function(sels) {
        var boxes = [];
        sels.forEach(function(sel) {
            var els = document.querySelectorAll(sel);
            var n = 0;
            for (var i = 0; i < els.length && n < 12; i++) {
                var r = els[i].getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                boxes.push({
                    sel: sel, i: n++,
                    x: Math.round(r.left * 100) / 100, y: Math.round(r.top * 100) / 100,
                    w: Math.round(r.width * 100) / 100, h: Math.round(r.height * 100) / 100,
                    text: (els[i].textContent || '').trim().length > 0
                });
            }
        });
        var snap = FocusManager.snapshot();
        return {
            screen: App.getCurrentScreen(),
            focus: snap ? snap.zone + '[' + snap.index + ']' : null,
            rootFontSize: getComputedStyle(document.documentElement).fontSize,
            innerWidth: innerWidth, innerHeight: innerHeight,
            clientWidth: document.documentElement.clientWidth,
            fonts: getComputedStyle(document.body).fontFamily,
            boxes: boxes
        };
    }, SELECTORS);
}

async function atRest(page) {
    await H.settle(page, 1000);
    await page.waitForFunction(function() {
        return Array.prototype.every.call(document.images, function(i) { return i.complete; });
    }, null, { timeout: 10000 });
    await G.settled(page, 5000);
    await H.settle(page, 200);
}

function compare(name, b, d) {
    var lines = [];
    var byKey = {};
    d.boxes.forEach(function(x) { byKey[x.sel + '#' + x.i] = x; });
    var within = 0, textOff = [], layoutOff = [], missing = [];
    b.boxes.forEach(function(x) {
        var y = byKey[x.sel + '#' + x.i];
        if (!y) { missing.push(x.sel + '#' + x.i + ' (browser only)'); return; }
        delete byKey[x.sel + '#' + x.i];
        var dx = y.x - x.x, dy = y.y - x.y, dw = y.w - x.w, dh = y.h - x.h;
        var worst = Math.max(Math.abs(dx), Math.abs(dy), Math.abs(dw), Math.abs(dh));
        if (worst <= TOLERANCE) { within++; return; }
        var desc = x.sel + '#' + x.i + ' d(x,y,w,h)=(' + [dx, dy, dw, dh].map(function(v) { return v.toFixed(1); }).join(', ') + ')';
        (x.text ? textOff : layoutOff).push(desc);
    });
    Object.keys(byKey).forEach(function(k) { missing.push(k + ' (device only)'); });
    lines.push(name + ': screen ' + b.screen + '/' + d.screen + ', focus ' + b.focus + '/' + d.focus +
        ', root ' + b.rootFontSize + '/' + d.rootFontSize + ', viewport ' + d.innerWidth + 'x' + d.innerHeight +
        ' (clientWidth ' + d.clientWidth + '); ' + within + '/' + b.boxes.length + ' boxes within +-' + TOLERANCE + ' px');
    if (layoutOff.length) lines.push('  OFF (no text):  ' + layoutOff.join('\n                   '));
    if (textOff.length) lines.push('  off (has text):  ' + textOff.join('\n                   '));
    if (missing.length) lines.push('  unmatched:       ' + missing.join(', '));
    return { lines: lines, layoutOff: layoutOff.length, textOff: textOff.length, missing: missing.length };
}

(async function() {
    fs.mkdirSync(outDir, { recursive: true });
    fs.mkdirSync(shotDir, { recursive: true });
    var wanted = only ? only.split(',') : null;
    var tag = 's1-t5-' + Math.round(scale * 100);

    // Browser side.
    var browser = await chromium.launch();
    var results = {};
    for (var n = 0; n < STATES.length; n++) {
        var name = STATES[n][0];
        if (wanted && wanted.indexOf(name) < 0) continue;
        var ctx = await browser.newContext({ baseURL: BASE, viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
        var page = await ctx.newPage();
        await STATES[n][1](page);
        await atRest(page);
        await page.screenshot({ path: path.join(outDir, tag + '-browser-' + name + '.png'), animations: 'disabled', caret: 'hide' });
        results[name] = { browser: await measure(page) };
        await ctx.close();
    }
    await browser.close();

    // Device side: the debug build at the dev server's bundled index.html, one page reused, with
    // its storage and init scripts cleared before each state (a fresh context, as above).
    D.adb(['reverse', 'tcp:8091', 'tcp:8091']);
    D.launch(BASE + '/index.html');
    var c = await D.connect({ timeout: 20000 });
    try {
        for (n = 0; n < STATES.length; n++) {
            name = STATES[n][0];
            if (wanted && wanted.indexOf(name) < 0) continue;
            await c.page.clearInitScripts();
            await c.page.evaluate(function() { localStorage.clear(); sessionStorage.clear(); });
            await STATES[n][1](c.page);
            await atRest(c.page);
            D.screencap(path.join(shotDir, tag + '-' + name + '.png'));
            results[name].device = await measure(c.page);
        }
    } finally {
        await c.close();
    }

    fs.writeFileSync(path.join(outDir, tag + '-geometry.json'), JSON.stringify(results, null, 1));
    var report = ['Scale ' + scale + ' (tolerance +-' + TOLERANCE + ' CSS px); fonts: browser "' +
        (results[Object.keys(results)[0]].browser.fonts) + '"'];
    var totals = { layoutOff: 0, textOff: 0, missing: 0 };
    Object.keys(results).forEach(function(k) {
        var r = compare(k, results[k].browser, results[k].device);
        report = report.concat(r.lines);
        totals.layoutOff += r.layoutOff; totals.textOff += r.textOff; totals.missing += r.missing;
    });
    report.push('TOTAL: ' + totals.layoutOff + ' no-text boxes off, ' + totals.textOff + ' text boxes off, ' + totals.missing + ' unmatched');
    console.log(report.join('\n'));
})().catch(function(e) { console.error(e && e.stack || e); process.exit(1); });
