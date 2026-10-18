#!/usr/bin/env node
'use strict';

// Sonance — Android TV device harness: seed the live Navidrome session (ticket-3.xx-androidtv §5.4).
//
// Reads the test account from TEST-ACCOUNT.local.md (rows "Server", "Username", "Password") inside
// Node and writes it into the app's localStorage through DevTools, as a signed-in session, so the
// next launch boots straight to Home against the live server. Reads only: the app is not driven
// here, and nothing is played. The values are never printed, logged or put on a command line.
//
// The app must be running from its own assets (file:///android_asset/), not at a sonance_url:
// that origin's storage is the one the installed app uses. Afterwards clear it with
//   adb -s emulator-5554 shell pm clear dev.simmo.sonance
//
// Usage: node tests/tools/android-seed-live.js

var fs = require('fs');
var path = require('path');
var D = require('./android-devtools.js');

var ACCOUNT = path.resolve(__dirname, '..', '..', 'TEST-ACCOUNT.local.md');

function account() {
    var rows = {};
    fs.readFileSync(ACCOUNT, 'utf8').split('\n').forEach(function(line) {
        var m = /^\|\s*([^|]+?)\s*\|\s*([^|]*?)\s*\|/.exec(line);
        if (m) rows[m[1]] = m[2].replace(/`/g, '');
    });
    if (!rows.Server || !rows.Username || !rows.Password) throw new Error('TEST-ACCOUNT.local.md lacks a Server, Username or Password row');
    return { server: rows.Server.replace(/\/+$/, ''), username: rows.Username, password: rows.Password };
}

(async function() {
    var a = account();
    var c = await D.connect({ timeout: 20000 });
    try {
        var where = await c.page.evaluate(function() { return location.href; });
        if (where.indexOf('file:///android_asset/') !== 0) throw new Error('the app is not running from its assets');
        await c.page.evaluate(function(s) {
            localStorage.setItem('sonance_server_url', s.server);
            localStorage.setItem('sonance_username', s.username);
            localStorage.setItem('sonance_password', s.password);
            localStorage.setItem('sonance_logged_in', 'true');
        }, a);
        var ok = await c.page.evaluate(function() {
            return localStorage.getItem('sonance_logged_in') === 'true' && !!localStorage.getItem('sonance_password');
        });
        console.log(ok ? 'seeded: a live Navidrome session (values not shown)' : 'seed FAILED');
        if (!ok) process.exitCode = 1;
    } finally {
        await c.close();
    }
})().catch(function(e) { console.error(e && e.message || e); process.exit(1); });
