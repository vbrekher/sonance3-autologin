#!/usr/bin/env node
// Local-only personal WGT build. No credentials are sent to a service.
import { createInterface } from 'node:readline/promises';
import { execFileSync } from 'node:child_process';
import { cpSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = join(ROOT, 'dist');

export function normalizeServerUrl(value) {
    const input = String(value || '').trim();
    let address;
    try { address = new URL(input); } catch (_) {
        throw new Error('Enter a full server URL: https://music.example.com or http://192.168.1.20:4533');
    }
    if (!['http:', 'https:'].includes(address.protocol)) throw new Error('Only http and https URLs are supported.');
    if (!address.hostname || address.username || address.password || address.search || address.hash) {
        throw new Error('The URL cannot contain embedded credentials, query parameters or a fragment.');
    }
    return address.href.replace(/\/+$/, '');
}

export function personalSettingsScript({ serverUrl, username, password, engine }) {
    if (!username || !password) throw new Error('Navidrome username and password are required.');
    if (engine !== 'html5' && engine !== 'avplay') throw new Error('Choose html5 or avplay.');
    const settings = {
        sonance_server_url: normalizeServerUrl(serverUrl),
        sonance_username: username,
        sonance_password: password,
        sonance_logged_in: 'true',
        sonance_audio_backend: engine
    };
    const json = JSON.stringify(settings).replace(/</g, '\\u003c').replace(/>/g, '\\u003e')
        .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    return [
        '/* Private personal build. Do not share this file or the resulting WGT. */',
        '(function () {',
        '    "use strict";',
        '    var data = ' + json + ';',
        '    for (var key in data) {',
        '        if (Object.prototype.hasOwnProperty.call(data, key)) {',
        '            localStorage.setItem(key, data[key]);',
        '        }',
        '    }',
        '})();',
        ''
    ].join('\n');
}

export function injectPersonalScript(html) {
    const marker = '<script src="js/sonance-core.min.js';
    if (!html.includes(marker)) throw new Error('Could not find Sonance core bundle in index.html.');
    return html.replace(marker, '<script src="js/sonance-personal-config.js"></script>\n    ' + marker);
}

export function personalWidgetConfig(xml) {
    const original = 'id="S0nance003.Sonance" package="S0nance003"';
    if (!xml.includes(original) || !xml.includes('<name>Sonance</name>')) {
        throw new Error('Unexpected upstream app ID; inspect config.xml before continuing.');
    }
    return xml.replace(original, 'id="S0Aut0Lg01.SonanceAuto" package="S0Aut0Lg01"')
        .replace('<name>Sonance</name>', '<name>Sonance AutoLogin</name>');
}

// Read from the controlling terminal with echo disabled by Bash's built-in
// read -s. Do NOT use readline._writeToOutput here: readline can still echo
// pasted text and the original prompt could disappear on macOS terminals.
// The password is never supplied in argv, a command line, or a GitHub action.
export function readHiddenPassword() {
    try {
        return execFileSync('bash', ['-c', [
            'set -e',
            'IFS= read -r -s -p "Password (hidden; paste is fine): " sonance_password < /dev/tty',
            'printf "\\n" > /dev/tty',
            'printf "%s" "$sonance_password"'
        ].join('\n')], {
            encoding: 'utf8',
            stdio: ['inherit', 'pipe', 'inherit']
        });
    } catch (e) {
        throw new Error('Hidden password input failed. Run this script in a local interactive Terminal.');
    }
}

function run(executable, args, cwd) {
    execFileSync(executable, args, { cwd, stdio: 'inherit' });
}

function createPersonalWgt(source, destination, configScript, tempDir) {
    const work = join(tempDir, 'package');
    mkdirSync(work, { recursive: true });
    run('unzip', ['-q', source, '-d', work], tempDir);
    const indexFile = join(work, 'index.html');
    const configFile = join(work, 'config.xml');
    writeFileSync(indexFile, injectPersonalScript(readFileSync(indexFile, 'utf8')));
    writeFileSync(configFile, personalWidgetConfig(readFileSync(configFile, 'utf8')));
    writeFileSync(join(work, 'js', 'sonance-personal-config.js'), configScript, { mode: 0o600 });
    run('zip', ['-q', '-r', destination, '.'], work);
    run('unzip', ['-tq', destination], tempDir);
    rmSync(work, { recursive: true, force: true });
}

export async function main() {
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
        throw new Error('Run in a terminal. Do not pass credentials through command-line arguments.');
    }
    if (!existsSync(join(ROOT, 'build.sh'))) throw new Error('Run from a complete Sonance checkout.');
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let serverUrl, username, password, engine;
    try {
        console.log('\nSonance AutoLogin — personal TV build\n');
        serverUrl = normalizeServerUrl(await rl.question('Navidrome URL (include http:// or https://): '));
        username = (await rl.question('Username: ')).trim();
        const selection = (await rl.question('Playback [H]TML5 / [A]VPlay (default H): ')).trim().toLowerCase();
        engine = selection === 'a' || selection === 'avplay' ? 'avplay' : 'html5';
    } finally { rl.close(); }
    // Close readline BEFORE asking for the secret. Otherwise its terminal
    // handlers can leak pasted password characters into visible scrollback.
    password = readHiddenPassword();
    if (!username || !password) throw new Error('Username and password cannot be empty.');

    if (serverUrl.startsWith('http://')) {
        console.warn('Warning: HTTP is not encrypted. Use HTTPS for internet-facing servers.');
    }
    const privateScript = personalSettingsScript({ serverUrl, username, password, engine });
    const tempDir = mkdtempSync(join(tmpdir(), 'sonance-personal-'));
    try {
        const stage = join(tempDir, 'source');
        mkdirSync(stage);
        ['build.sh', 'index.html', 'config.xml', 'icon.png', 'icon-oblong-1920.png'].forEach((name) => {
            copyFileSync(join(ROOT, name), join(stage, name));
        });
        cpSync(join(ROOT, 'js'), join(stage, 'js'), { recursive: true });
        cpSync(join(ROOT, 'css'), join(stage, 'css'), { recursive: true });
        console.log('\nBuilding Sonance assets in a temporary directory...');
        run('bash', ['build.sh'], stage);
        mkdirSync(OUTPUT, { recursive: true });
        for (const [source, dest] of [
            ['Sonance3.wgt', 'Sonance-AutoLogin-Square.wgt'],
            ['Sonance3-Oblong.wgt', 'Sonance-AutoLogin-Oblong.wgt']
        ]) {
            const outputPath = join(OUTPUT, dest);
            rmSync(outputPath, { force: true });
            createPersonalWgt(join(stage, source), outputPath, privateScript, tempDir);
        }
        console.log('\nBuilt: dist/Sonance-AutoLogin-Oblong.wgt and dist/Sonance-AutoLogin-Square.wgt');
        console.log('Install ONE with Apps2Samsung. Both WGTs contain your password: keep them private.');
    } finally {
        rmSync(tempDir, { recursive: true, force: true });
        password = '';
    }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    main().catch((err) => { console.error('\nBuild failed: ' + err.message); process.exitCode = 1; });
}
