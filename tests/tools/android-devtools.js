#!/usr/bin/env node
'use strict';

// Sonance — Android TV device harness: the app's WebView from Node (ticket-3.xx-androidtv §A3).
//
// Debug builds of the APK turn WebView DevTools on (W7). This finds the app's DevTools socket on
// the emulator (/proc/net/unix, by the app's pid), forwards it to 127.0.0.1:<port>, and talks raw
// CDP over Node 24's global WebSocket. Playwright's connectOverCDP cannot be used: WebView 113
// answers its Browser.setDownloadBehavior with "Browser context management is not supported".
//
// connect() returns a page object shaped like the subset of Playwright's Page that
// e2e/helpers/sonance.js and e2e/helpers/geometry.js use (evaluate, waitForFunction,
// waitForTimeout, addInitScript, goto, keyboard.press), so bootBundled, navTo, waitForScreen and
// settled run unchanged against the device. Keys go through adb (`input keyevent`), the path a
// remote's keys take, not CDP. evaluate runs with userGesture, as Playwright's does in practice
// (its Chromium allows autoplay; the WebView requires a gesture for HTML5 audio).
//
// Module:
//   var D = require('./android-devtools.js');
//   var c = await D.connect();      // { page, close() }
//
// CLI:
//   node tests/tools/android-devtools.js viewport
//   node tests/tools/android-devtools.js eval '<expression>'
//
// adb is $ANDROID_HOME/platform-tools/adb (else ~/Library/Android/sdk), on emulator-5554 unless
// ANDROID_SERIAL names another emulator. Never a physical device (§A2): any other serial is refused.

var childProcess = require('child_process');
var fs = require('fs');
var os = require('os');
var path = require('path');

var SDK = process.env.ANDROID_HOME || path.join(os.homedir(), 'Library', 'Android', 'sdk');
var ADB = path.join(SDK, 'platform-tools', 'adb');
var SERIAL = process.env.ANDROID_SERIAL || 'emulator-5554';
var PACKAGE = 'dev.simmo.sonance';
var DEV_SERVER = 'http://localhost:8091';

if (!/^emulator-\d+$/.test(SERIAL)) {
    throw new Error('android-devtools: ' + SERIAL + ' is not an emulator; the sessions never drive a physical device.');
}

// Playwright key names → Android key codes (the remote's keys; DPAD_CENTER is OK).
var KEYS = {
    ArrowUp: 'KEYCODE_DPAD_UP',
    ArrowDown: 'KEYCODE_DPAD_DOWN',
    ArrowLeft: 'KEYCODE_DPAD_LEFT',
    ArrowRight: 'KEYCODE_DPAD_RIGHT',
    Enter: 'KEYCODE_DPAD_CENTER',
    Escape: 'KEYCODE_BACK'
};

function adb(args) {
    return childProcess.execFileSync(ADB, ['-s', SERIAL].concat(args), { encoding: 'utf8' });
}

function sleep(ms) { return new Promise(function(r) { setTimeout(r, ms); }); }

/** The app's DevTools socket name (webview_devtools_remote_<pid>), or null if it is not running. */
function socketName() {
    var pid = adb(['shell', 'pidof', PACKAGE]).trim();
    if (!pid) return null;
    var name = 'webview_devtools_remote_' + pid.split(/\s+/)[0];
    return adb(['shell', 'cat', '/proc/net/unix']).indexOf('@' + name) > -1 ? name : null;
}

/** A source string from Playwright-style (fn, arg). */
function source(fn, arg) {
    if (typeof fn !== 'function') return String(fn);
    return '(' + fn.toString() + ')(' + (arg === undefined ? '' : JSON.stringify(arg)) + ')';
}

function CdpPage(ws) {
    var self = this;
    this._ws = ws;
    this._id = 0;
    this._pending = {};
    this._listeners = [];
    this._initScripts = [];
    ws.addEventListener('message', function(ev) {
        var msg = JSON.parse(ev.data);
        if (msg.id && self._pending[msg.id]) {
            var p = self._pending[msg.id];
            delete self._pending[msg.id];
            if (msg.error) p.reject(new Error(p.method + ': ' + msg.error.message));
            else p.resolve(msg.result);
        } else if (msg.method) {
            self._listeners.slice().forEach(function(l) { if (l.method === msg.method) l.fn(msg.params); });
        }
    });
    this.keyboard = {
        press: function(key) {
            var code = KEYS[key];
            if (!code) throw new Error('android-devtools: no Android key for ' + key);
            adb(['shell', 'input', 'keyevent', code]);
            return Promise.resolve();
        }
    };
}

CdpPage.prototype.send = function(method, params) {
    var self = this;
    var id = ++this._id;
    return new Promise(function(resolve, reject) {
        self._pending[id] = { resolve: resolve, reject: reject, method: method };
        self._ws.send(JSON.stringify({ id: id, method: method, params: params || {} }));
    });
};

CdpPage.prototype.once = function(method, timeout) {
    var self = this;
    return new Promise(function(resolve, reject) {
        var l = { method: method, fn: function(p) { done(); resolve(p); } };
        var t = setTimeout(function() { done(); reject(new Error('timeout waiting for ' + method)); }, timeout || 30000);
        function done() { clearTimeout(t); self._listeners.splice(self._listeners.indexOf(l), 1); }
        self._listeners.push(l);
    });
};

CdpPage.prototype.evaluate = async function(fn, arg) {
    var r = await this.send('Runtime.evaluate', {
        expression: source(fn, arg), returnByValue: true, awaitPromise: true, userGesture: true
    });
    if (r.exceptionDetails) {
        var d = r.exceptionDetails;
        throw new Error('evaluate: ' + (d.exception && d.exception.description || d.text));
    }
    return r.result.value;
};

CdpPage.prototype.waitForFunction = async function(fn, arg, opts) {
    opts = opts || {};
    var deadline = Date.now() + (opts.timeout || 30000);
    var polling = typeof opts.polling === 'number' ? opts.polling : 100;
    for (;;) {
        var v = await this.evaluate(fn, arg);
        if (v) return v;
        if (Date.now() > deadline) throw new Error('waitForFunction: timeout after ' + (opts.timeout || 30000) + ' ms');
        await sleep(polling);
    }
};

CdpPage.prototype.waitForTimeout = function(ms) { return sleep(ms); };

/** addInitScript(fn, arg) or addInitScript({ path }), as Playwright's. */
CdpPage.prototype.addInitScript = async function(fn, arg) {
    var src = fn && typeof fn === 'object' && fn.path ? fs.readFileSync(fn.path, 'utf8') : source(fn, arg);
    var r = await this.send('Page.addScriptToEvaluateOnNewDocument', { source: src });
    this._initScripts.push(r.identifier);
};

/** Forget every init script added so far (a fresh context, as far as scripts go). */
CdpPage.prototype.clearInitScripts = async function() {
    while (this._initScripts.length) {
        await this.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: this._initScripts.pop() });
    }
};

/** goto(url): relative URLs resolve against the dev server, as Playwright's baseURL. */
CdpPage.prototype.goto = async function(url) {
    var loaded = this.once('Page.loadEventFired', 30000);
    await this.send('Page.navigate', { url: new URL(url, DEV_SERVER).href });
    await loaded;
};

CdpPage.prototype.reload = async function() {
    var loaded = this.once('Page.loadEventFired', 30000);
    await this.send('Page.reload', {});
    await loaded;
};

/**
 * Connect to the running app's page. Waits up to `timeout` ms for the socket and the page (the app
 * may have just been launched). Resolves { page, close }.
 */
async function connect(opts) {
    opts = opts || {};
    var port = opts.port || 9222;
    var deadline = Date.now() + (opts.timeout || 15000);
    var name = null;
    while (!(name = socketName())) {
        if (Date.now() > deadline) throw new Error('android-devtools: no DevTools socket for ' + PACKAGE + ' (is a debug build running?)');
        await sleep(250);
    }
    adb(['forward', 'tcp:' + port, 'localabstract:' + name]);
    var target = null;
    while (!target) {
        var list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
        target = list.filter(function(t) { return t.type === 'page' && t.webSocketDebuggerUrl; })[0] || null;
        if (target) break;
        if (Date.now() > deadline) throw new Error('android-devtools: connected, but the WebView has no page');
        await sleep(250);
    }
    var ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise(function(resolve, reject) {
        ws.addEventListener('open', resolve, { once: true });
        ws.addEventListener('error', reject, { once: true });
    });
    var page = new CdpPage(ws);
    await page.send('Page.enable');
    await page.send('Runtime.enable');
    return {
        page: page,
        close: async function() {
            await page.clearInitScripts();
            ws.close();
            try { adb(['forward', '--remove', 'tcp:' + port]); } catch (e) { /* already gone */ }
        }
    };
}

/** W2's values, plus what explains them. */
function readViewport(page) {
    return page.evaluate(function() {
        var de = document.documentElement;
        var vv = window.visualViewport;
        return {
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            clientWidth: de.clientWidth,
            clientHeight: de.clientHeight,
            scrollWidth: de.scrollWidth,
            scrollHeight: de.scrollHeight,
            devicePixelRatio: window.devicePixelRatio,
            visualViewportScale: vv ? vv.scale : null,
            visualViewportWidth: vv ? vv.width : null,
            rootFontSize: getComputedStyle(de).fontSize,
            userAgent: navigator.userAgent,
            page: location.protocol + '//' + location.host + location.pathname
        };
    });
}

/** The physical screen, as the user sees it (adb screencap), written to `file`. */
function screencap(file) {
    var png = childProcess.execFileSync(ADB, ['-s', SERIAL, 'exec-out', 'screencap', '-p'], { maxBuffer: 64 * 1024 * 1024 });
    fs.writeFileSync(file, png);
    return file;
}

/** The component of the top resumed activity, e.g. 'dev.simmo.sonance/.MainActivity'. */
function topActivity() {
    var m = /topResumedActivity=ActivityRecord\{\S+ u\d+ (\S+)/.exec(adb(['shell', 'dumpsys', 'activity', 'activities']));
    return m ? m[1] : '';
}

/**
 * Launch the app (force-stopping it first), optionally at a debug-build `sonance_url`, and make
 * sure it is the activity in front.
 *
 * WHY the check: the emulator's Google TV launcher sits at its account-setup gate (no Google
 * account), and when an app is started while it is in front it starts its own HomeActivity again
 * about 160 ms later (BootModeAppToForeground in Logcat), so the app lands behind it and is frozen.
 * An emulator artefact. A plain `am start` (no extra, so no reload) brings the task back.
 */
function launch(url) {
    adb(['shell', 'am', 'force-stop', PACKAGE]);
    var args = ['shell', 'am', 'start', '-W', '-n', PACKAGE + '/.MainActivity'];
    if (url) args.push('--es', 'sonance_url', url);
    var out = adb(args);
    for (var i = 0; i < 5; i++) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
        if (topActivity().indexOf(PACKAGE + '/') === 0) return out;
        adb(['shell', 'am', 'start', '-n', PACKAGE + '/.MainActivity']);
    }
    throw new Error('android-devtools: ' + PACKAGE + ' did not stay in front (top: ' + topActivity() + ')');
}

module.exports = {
    adb: adb, connect: connect, readViewport: readViewport, screencap: screencap, launch: launch, topActivity: topActivity,
    SERIAL: SERIAL, PACKAGE: PACKAGE, DEV_SERVER: DEV_SERVER
};

if (require.main === module) {
    (async function() {
        var cmd = process.argv[2];
        var c = await connect();
        try {
            if (cmd === 'viewport') {
                console.log(JSON.stringify(await readViewport(c.page), null, 1));
            } else if (cmd === 'eval') {
                var out = await c.page.evaluate(process.argv[3]);
                console.log(typeof out === 'string' ? out : JSON.stringify(out, null, 1));
            } else {
                console.error('usage: android-devtools.js viewport | eval <expression>');
                process.exitCode = 2;
            }
        } finally {
            await c.close();
        }
    })().catch(function(e) { console.error(e && e.stack || e); process.exit(1); });
}
