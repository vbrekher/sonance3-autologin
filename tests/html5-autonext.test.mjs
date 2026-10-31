// Regression tests for Samsung HTML5 playback across track boundaries.
// No Navidrome credentials, network connection or real media files needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../js/player.js', import.meta.url), 'utf8');

class FakeAudio {
    constructor() {
        this.src = '';
        this.currentTime = 0;
        this.duration = 180;
        this.volume = 0.7;
        this.listeners = Object.create(null);
        this.playCount = 0;
        this.loadCount = 0;
    }
    addEventListener(type, fn) {
        (this.listeners[type] || (this.listeners[type] = [])).push(fn);
    }
    removeEventListener(type, fn) {
        this.listeners[type] = (this.listeners[type] || []).filter((x) => x !== fn);
    }
    dispatch(type) {
        for (const fn of (this.listeners[type] || []).slice()) fn();
    }
    play() {
        this.playCount++;
        this.dispatch('play');
        return Promise.resolve();
    }
    pause() {
        this.dispatch('pause');
    }
    load() {
        this.loadCount++;
    }
    removeAttribute(name) {
        if (name === 'src') this.src = '';
    }
}

function setup({ samsung, repeat = 'none' }) {
    const primary = new FakeAudio();
    const preload = new FakeAudio();
    const local = { sonance_audio_backend: 'html5', sonance_repeat: repeat };
    const ctx = {
        window: samsung ? { webapis: { avplay: {} } } : {},
        document: { getElementById(id) {
            return id === 'sonance-audio' ? primary : id === 'sonance-audio-preload' ? preload : null;
        }},
        localStorage: {
            getItem(key) { return Object.prototype.hasOwnProperty.call(local, key) ? local[key] : null; },
            setItem(key, value) { local[key] = String(value); }
        },
        SonanceUtils: {
            log() {}, warn() {}, error() {},
            formatDuration(t) { return String(t); }
        },
        AuthManager: { getApi() { return {
            getStreamUrl(id) { return 'https://example.invalid/rest/stream.view?id=' + id; }
        }; }},
        setTimeout, clearTimeout, Date, Math, Promise, Map, console
    };
    vm.createContext(ctx);
    vm.runInContext(source, ctx, { filename: 'js/player.js' });
    ctx.Player.init();
    return { player: ctx.Player, primary, preload };
}
function tracks() {
    return [
        { id: 'one', title: 'First song', duration: 180, suffix: 'mp3' },
        { id: 'two', title: 'Second song', duration: 180, suffix: 'mp3' }
    ];
}

test('Samsung HTML5: second song auto-starts on the SAME audio element', () => {
    const { player, primary, preload } = setup({ samsung: true });
    player.playAlbum(tracks(), 0);
    assert.equal(primary.playCount, 1);
    assert.match(primary.src, /id=one/);

    // Exactly the part of upstream that previously allocated a second audio
    // element five seconds before the boundary.
    primary.currentTime = 179;
    primary.dispatch('timeupdate');
    assert.equal(preload.loadCount, 0, 'Samsung must not preload into a second audio element');

    primary.dispatch('ended');
    assert.equal(player.getState().currentTrack.id, 'two');
    assert.equal(player.getState().queueIndex, 1);
    assert.equal(primary.playCount, 2, 'play() must run on the already user-activated audio element');
    assert.match(primary.src, /id=two/);
    assert.equal(preload.playCount, 0, 'secondary audio element must never be started');
    assert.equal(player.getState().isPlaying, true);
});

test('Samsung HTML5: repeat-all wraps using the same element', () => {
    const { player, primary } = setup({ samsung: true, repeat: 'all' });
    player.playAlbum(tracks(), 0);
    primary.dispatch('ended');
    primary.dispatch('ended');
    assert.equal(player.getState().currentTrack.id, 'one');
    assert.equal(primary.playCount, 3);
});

test('Samsung HTML5: normal queue end does not restart playback', () => {
    const { player, primary } = setup({ samsung: true });
    player.playAlbum(tracks(), 0);
    primary.dispatch('ended');
    primary.dispatch('ended');
    assert.equal(primary.playCount, 2);
    assert.equal(player.getState().isPlaying, false);
});

test('regular desktop browser still has the original two-element preload', () => {
    const { player, primary, preload } = setup({ samsung: false });
    player.playAlbum(tracks(), 0);
    primary.currentTime = 179;
    primary.dispatch('timeupdate');
    assert.equal(preload.loadCount, 1);
    assert.match(preload.src, /id=two/);
});
