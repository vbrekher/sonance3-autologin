import { test, expect, Page } from '@playwright/test';
import * as path from 'path';
import * as H from './helpers/sonance';

// Android TV port (ticket-3.xx-androidtv §7.1), on the bundled build.
// - Part 1 (S2): the shim's tizen.* parts, the platform seam (S3), key injection (K1) and the bridge
//   calls (S4).
// - Part 2 (S3): webapis.avplay over the bridge (A1-A4) and webapis.appcommon (S5).
// - Part 3 (S4): audio focus from the host (B2) and the notification's title (B1).
// - Part 4 (fix round 1, F1): the shim's side of the system keyboard (X4, X2): inputmode="none"
//   while Sonance has not opened it, the host's open and reset, and the editing report.
//
// The Android host serves android/shim/webapis.js where Tizen serves webapis.js; here it is routed
// to that path (the dev server 404s it). A fake window.SonanceNative, injected before any page
// script, stands in for the host's bridge: it answers androidVersion() with "11", stands in for
// PlayerEngine, and records every call. Without the fake the shim must do nothing (S1), so the
// browser and Tizen readings stay as they are today.

const SHIM = path.resolve(__dirname, '..', 'android', 'shim', 'webapis.js');

async function routeShim(page: Page) {
  const hits = { n: 0 };
  await page.route(/\/(\$|%24)WEBAPIS\/webapis\/webapis\.js$/, (route) => {
    hits.n++;
    return route.fulfill({ path: SHIM, contentType: 'application/javascript' });
  });
  return hits;
}

// The host's bridge as the shim sees it: @JavascriptInterface methods on window.SonanceNative.
// Part 2 adds PlayerEngine's methods and the screen saver; every call is recorded in __bridgeCalls.
// Native events reach the page through SonanceShim.receive, as the host's evaluateJavascript sends
// them. With `auto` (the default), the fake engine (window.__engine) answers as MediaPlayer does:
// a prepare with "prepared" (20 s), a playing session with a tick every 200 ms, a seek with
// "seeked", the screen saver with its callback. A stream whose song id is a key of __engine.fail
// fails its prepare with that error instead. Without `auto`, the test sends every native event.
async function fakeBridge(page: Page, opts: { auto?: boolean } = {}) {
  await page.addInitScript((auto: boolean) => {
    const w = window as any;
    const calls: any[] = [];
    w.__bridgeCalls = calls;
    const engine = w.__engine = { auto, last: 0, duration: 20000, fail: {} as Record<string, string>, sessions: {} as any };
    const receive = (msg: any) => w.SonanceShim.receive(msg);
    const later = (msg: any) => setTimeout(() => receive(msg), 10);
    const halt = (id: number) => {
      const s = engine.sessions[id];
      if (s && s.timer) { clearTimeout(s.timer); s.timer = null; }
    };
    const tick = (id: number) => {
      const s = engine.sessions[id];
      s.timer = setTimeout(() => {
        s.position += 200;
        receive({ type: 'player', session: id, event: 'tick', position: s.position });
        tick(id);
      }, 200);
    };
    w.SonanceNative = {
      androidVersion() { calls.push(['androidVersion']); return '11'; },
      exit() { calls.push(['exit']); },
      playerOpen(url: string) {
        calls.push(['playerOpen', url]);
        const id = ++engine.last;
        engine.sessions[id] = { url, position: 0, timer: null };
        return id;
      },
      playerPrepare(id: number) {
        calls.push(['playerPrepare', id]);
        if (!engine.auto) return;
        const songId = new URL(engine.sessions[id].url, location.href).searchParams.get('id') || '';
        if (engine.fail[songId]) later({ type: 'player', session: id, event: 'error', error: engine.fail[songId] });
        else later({ type: 'player', session: id, event: 'prepared', duration: engine.duration });
      },
      playerPlay(id: number) {
        calls.push(['playerPlay', id]);
        halt(id);
        if (engine.auto) tick(id);
      },
      playerPause(id: number) { calls.push(['playerPause', id]); halt(id); },
      playerSeek(id: number, ms: number, seek: number) {
        calls.push(['playerSeek', id, ms, seek]);
        engine.sessions[id].position = ms;
        if (engine.auto) later({ type: 'player', session: id, event: 'seeked', seek, position: ms });
      },
      playerStop(id: number) { calls.push(['playerStop', id]); halt(id); },
      playerClose(id: number) { calls.push(['playerClose', id]); halt(id); },
      setKeepScreenOn(keep: boolean, callback: number) {
        calls.push(['setKeepScreenOn', keep, callback]);
        if (engine.auto) later({ type: 'callback', id: callback });
      },
      nowPlaying(title: string) { calls.push(['nowPlaying', title]); },
      imeEditing(editing: boolean) { calls.push(['imeEditing', editing]); },
      imeReady() { calls.push(['imeReady']); }
    };
  }, opts.auto !== false);
}

async function boot(page: Page, opts: { bridge: boolean; jellyfin?: boolean; auto?: boolean }) {
  const hits = await routeShim(page);
  if (opts.bridge) await fakeBridge(page, { auto: opts.auto });
  if (opts.jellyfin) await H.bootJellyfin(page, { bundled: true });
  else await H.bootBundled(page);
  expect(hits.n).toBe(1);
}

// What native code sends for one Android key event: a keydown on DOWN (and on each repeat), a keyup
// on UP, through the shim's one entry point.
function inject(page: Page, events: Array<[string, number, string, boolean?]>) {
  return page.evaluate((evs) => {
    evs.forEach((e) => (window as any).SonanceShim.receive({
      type: 'key', action: e[0], keyCode: e[1], key: e[2], repeat: !!e[3]
    }));
  }, events);
}

const press = (page: Page, keyCode: number, key: string) =>
  inject(page, [['down', keyCode, key], ['up', keyCode, key]]);

// Every keydown/keyup the page sees, at the window in the capture phase (before anything else).
async function recordKeys(page: Page) {
  await page.evaluate(() => {
    const log: any[] = [];
    (window as any).__keys = log;
    const rec = (ev: KeyboardEvent) => log.push({
      type: ev.type, keyCode: ev.keyCode, which: ev.which, key: ev.key, repeat: ev.repeat,
      bubbles: ev.bubbles, cancelable: ev.cancelable,
      onActive: ev.target === (document.activeElement || document.body)
    });
    window.addEventListener('keydown', rec, true);
    window.addEventListener('keyup', rec, true);
  });
}

const playing = (page: Page, want: boolean) =>
  page.waitForFunction((w) => (window as any).Player.getState().isPlaying === w, want, { timeout: 5000 });

async function platformRow(page: Page) {
  await H.navTo(page, 'settings');
  return page.evaluate(() => Array.prototype.map.call(document.querySelectorAll('.settings-about-row'),
    (n: Element) => n.textContent).filter((t: string) => t.indexOf('Platform: ') === 0));
}

const jellyfinAuths = (page: Page) => page.evaluate(() => (window as any).__MOCK__.calls
  .filter((c: any) => c.backend === 'jellyfin' && c.auth).map((c: any) => c.auth));

test.describe('S3 platform labels', () => {
  test('with the bridge, Settings reads "Platform: Android TV 11"', async ({ page }) => {
    await boot(page, { bridge: true });
    expect(await platformRow(page)).toEqual(['Platform: Android TV 11']);
  });

  test('without the bridge, Settings reads "Platform: Browser", as today', async ({ page }) => {
    await boot(page, { bridge: false });
    expect(await platformRow(page)).toEqual(['Platform: Browser']);
  });

  test('with the bridge, Jellyfin requests carry Device="Android TV"', async ({ page }) => {
    await boot(page, { bridge: true, jellyfin: true });
    const auths = await jellyfinAuths(page);
    expect(auths.length).toBeGreaterThan(0);
    auths.forEach((a: string) => expect(a).toContain('Device="Android%20TV"'));
  });

  test('without the bridge, Jellyfin requests carry Device="Browser", as today', async ({ page }) => {
    await boot(page, { bridge: false, jellyfin: true });
    const auths = await jellyfinAuths(page);
    expect(auths.length).toBeGreaterThan(0);
    auths.forEach((a: string) => expect(a).toContain('Device="Browser"'));
  });
});

test.describe('K1 injected keys', () => {
  test('10009 "XF86Back" reaches focus.js as Back: at the root it opens "Exit Sonance?"', async ({ page }) => {
    await boot(page, { bridge: true });
    await recordKeys(page);
    expect(await page.evaluate(() => (window as any).FocusManager.getActiveZone())).toBe('topnav');
    await press(page, 10009, 'XF86Back');
    await expect(page.locator('.exit-card-title')).toHaveText('Exit Sonance?');
    const keys = await page.evaluate(() => (window as any).__keys);
    expect(keys).toEqual([
      { type: 'keydown', keyCode: 10009, which: 10009, key: 'XF86Back', repeat: false, bubbles: true, cancelable: true, onActive: true },
      { type: 'keyup', keyCode: 10009, which: 10009, key: 'XF86Back', repeat: false, bubbles: true, cancelable: true, onActive: true }
    ]);
    // A second Back dismisses the dialog (goBack step 1), as on Tizen.
    await press(page, 10009, 'XF86Back');
    await expect(page.locator('.exit-overlay')).toHaveCount(0);
  });

  test('10252 "MediaPlayPause" toggles play, 10253 "MediaStop" pauses', async ({ page }) => {
    await boot(page, { bridge: true });
    await H.startTrack(page, 1);
    await playing(page, true);
    await press(page, 10252, 'MediaPlayPause');
    await playing(page, false);
    await press(page, 10252, 'MediaPlayPause');
    await playing(page, true);
    await press(page, 10253, 'MediaStop');
    await playing(page, false);
    await press(page, 10253, 'MediaStop');
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as any).Player.getState().isPlaying)).toBe(false);
  });

  test('10417 "MediaFastForward" is next and 10412 "MediaRewind" is previous', async ({ page }) => {
    await boot(page, { bridge: true });
    await H.startTrack(page, 3);
    const index = () => page.evaluate(() => (window as any).Player.getState().queueIndex);
    await press(page, 10417, 'MediaFastForward');
    await expect.poll(index).toBe(1);
    await press(page, 10412, 'MediaRewind');
    await expect.poll(index).toBe(0);
  });

  test('403-406 reach the active zone\'s colour handler as red, green, yellow, blue', async ({ page }) => {
    await boot(page, { bridge: true });
    await page.evaluate(() => {
      const w = window as any;
      w.__colours = [];
      w.FocusManager.registerZone('android-colour-test', {
        selector: '.top-nav-item', columns: 7, neighbors: {},
        onActivate() {}, onColourButton(colour: string) { w.__colours.push(colour); }
      });
      w.FocusManager.setActiveZone('android-colour-test', 0, true);
    });
    await press(page, 403, 'ColorF0Red');
    await press(page, 404, 'ColorF1Green');
    await press(page, 405, 'ColorF2Yellow');
    await press(page, 406, 'ColorF3Blue');
    expect(await page.evaluate(() => (window as any).__colours)).toEqual(['red', 'green', 'yellow', 'blue']);
  });

  test('injected keys arrive in order, repeats as further keydowns; 415, 19, 10232, 10233 change nothing', async ({ page }) => {
    await boot(page, { bridge: true });
    await H.startTrack(page, 3);
    await playing(page, true);
    await recordKeys(page);
    const before = await page.evaluate(() => {
      const s = (window as any).Player.getState();
      return { index: s.queueIndex, playing: s.isPlaying, zone: (window as any).FocusManager.getActiveZone() };
    });
    await inject(page, [
      ['down', 415, 'MediaPlay'], ['up', 415, 'MediaPlay'],
      ['down', 19, 'MediaPause'], ['down', 19, 'MediaPause', true], ['up', 19, 'MediaPause'],
      ['down', 10232, 'MediaTrackPrevious'], ['up', 10232, 'MediaTrackPrevious'],
      ['down', 10233, 'MediaTrackNext'], ['up', 10233, 'MediaTrackNext']
    ]);
    await page.waitForTimeout(300);
    const keys = await page.evaluate(() => (window as any).__keys.map((k: any) =>
      k.type + ' ' + k.keyCode + ' ' + k.key + (k.repeat ? ' repeat' : '')));
    expect(keys).toEqual([
      'keydown 415 MediaPlay', 'keyup 415 MediaPlay',
      'keydown 19 MediaPause', 'keydown 19 MediaPause repeat', 'keyup 19 MediaPause',
      'keydown 10232 MediaTrackPrevious', 'keyup 10232 MediaTrackPrevious',
      'keydown 10233 MediaTrackNext', 'keyup 10233 MediaTrackNext'
    ]);
    const after = await page.evaluate(() => {
      const s = (window as any).Player.getState();
      return { index: s.queueIndex, playing: s.isPlaying, zone: (window as any).FocusManager.getActiveZone() };
    });
    expect(after).toEqual(before);
  });
});

test.describe('S4 bridge calls', () => {
  test('Exit in "Exit Sonance?" calls the bridge\'s exit()', async ({ page }) => {
    await boot(page, { bridge: true });
    await press(page, 10009, 'XF86Back');
    await expect(page.locator('.exit-card-title')).toHaveText('Exit Sonance?');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => (window as any).__bridgeCalls
      .filter((c: any) => c[0] === 'exit').length)).toBe(1);
  });

  test('tizen.tvinputdevice.registerKey and tizen.tvaudiocontrol.setVolume are no-ops that do not throw', async ({ page }) => {
    const warnings: string[] = [];
    page.on('console', (m) => { if (m.type() === 'warning' || m.type() === 'error') warnings.push(m.text()); });
    const errors = H.watchErrors(page);
    await boot(page, { bridge: true });
    const r = await page.evaluate(() => {
      const w = window as any;
      const n = w.__bridgeCalls.length;
      w.tizen.tvinputdevice.registerKey('MediaPlayPause');
      w.tizen.tvaudiocontrol.setVolume(50);
      return { calls: w.__bridgeCalls.slice(n) };
    });
    expect(r.calls).toEqual([]);
    // App registered its keys at boot (app.js registerTizenKeys) without a warning.
    expect(warnings.filter((t) => t.indexOf('Failed to register key') > -1)).toEqual([]);
    expect(errors.pageErrors).toEqual([]);
  });
});

test.describe('S1 no bridge, no shim', () => {
  test('without SonanceNative the shim defines nothing', async ({ page }) => {
    await boot(page, { bridge: false });
    const defined = await page.evaluate(() => {
      const w = window as any;
      return ['tizen', 'webapis', 'SonancePlatform', 'SonanceShim', 'SonanceShimLoaded']
        .filter((k) => typeof w[k] !== 'undefined');
    });
    expect(defined).toEqual([]);
    expect(await page.evaluate(() => (window as any).Player.IS_TIZEN)).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// Part 2 (S3): webapis.avplay over the bridge (A1-A4) and webapis.appcommon (S5). The contract is
// what js/player.js uses, as tests/avplay-stub.js models it; MediaPlayer is behind the fake engine.
// ---------------------------------------------------------------------------------------------

// The bridge calls the player and the screen saver made since call `from`, compactly: a stream by
// its song id (and a transcode by its format and offset), a seek by its session and ms.
const playerCalls = (page: Page, from: number) => page.evaluate((n) => (window as any).__bridgeCalls.slice(n)
  .filter((c: any[]) => c[0] !== 'androidVersion' && c[0] !== 'exit' && c[0] !== 'nowPlaying')
  .map((c: any[]) => {
    if (c[0] === 'playerOpen') {
      const q = new URL(c[1], location.href).searchParams;
      return 'open ' + q.get('id') + (q.get('format') ? ' ' + q.get('format') : '') +
        (Number(q.get('timeOffset')) ? ' @' + q.get('timeOffset') : '');
    }
    if (c[0] === 'playerSeek') return 'seek ' + c[1] + ' ' + c[2];
    if (c[0] === 'setKeepScreenOn') return 'keepScreenOn ' + c[1];
    return c[0].replace(/^player/, '').toLowerCase() + ' ' + c[1];
  }), from);

const bridgeCount = (page: Page): Promise<number> => page.evaluate(() => (window as any).__bridgeCalls.length);

// Native events, as the host sends them (evaluateJavascript, then SonanceShim.receive).
const native = (page: Page, msgs: any[]) =>
  page.evaluate((m) => m.forEach((x: any) => (window as any).SonanceShim.receive(x)), msgs);

async function recordToasts(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    w.__toasts = [];
    const orig = w.App.showToast;
    w.App.showToast = function(msg: string) { w.__toasts.push(msg); return orig.apply(this, arguments as any); };
  });
}

test.describe('A1 AVPlay on the bridge', () => {
  test('with the bridge, Player.IS_TIZEN is true: webapis.avplay and appcommon exist before the bundles', async ({ page }) => {
    await boot(page, { bridge: true });
    expect(await page.evaluate(() => {
      const w = window as any;
      return { tizen: w.Player.IS_TIZEN, avplay: typeof w.webapis.avplay, appcommon: typeof w.webapis.appcommon };
    })).toEqual({ tizen: true, avplay: 'object', appcommon: 'object' });
    // Without the bridge: 'S1 no bridge, no shim' (IS_TIZEN false, no webapis).
  });

  test('the state machine: open, prepare, play, pause, stop and close, answered synchronously', async ({ page }) => {
    await boot(page, { bridge: true, auto: false });
    const n = await bridgeCount(page);
    const r = await page.evaluate(() => {
      const w = window as any, av = w.webapis.avplay, out: string[] = [];
      const st = (label: string) => out.push(label + ' ' + av.getState() + ' ' + av.getDuration());
      st('start');
      av.open('http://localhost/rest/stream.view?id=song-0'); st('open');
      av.setDisplayRect(0, 0, 1, 1); st('setDisplayRect');
      av.setListener({});
      av.prepareAsync(() => st('ok'), () => st('err'));
      st('prepareAsync');
      w.SonanceShim.receive({ type: 'player', session: w.__engine.last, event: 'prepared', duration: 214000 });
      av.seekTo(5000); st('seekTo');
      av.play(); st('play');
      av.pause(); st('pause');
      av.play(); st('play');
      av.stop(); st('stop');
      av.close(); st('close');
      return out;
    });
    expect(r).toEqual([
      'start NONE 0', 'open IDLE 0', 'setDisplayRect IDLE 0', 'prepareAsync IDLE 0', 'ok READY 214000',
      'seekTo READY 214000', 'play PLAYING 214000', 'pause PAUSED 214000', 'play PLAYING 214000',
      'stop IDLE 214000', 'close NONE 0'
    ]);
    // setDisplayRect and setListener stay in the page; every other call reaches the engine.
    expect(await playerCalls(page, n)).toEqual([
      'open song-0', 'prepare 1', 'seek 1 5000', 'play 1', 'pause 1', 'play 1', 'stop 1', 'close 1'
    ]);
  });

  // D225: the states each call is allowed in are Samsung's AVPlay reference's. A call in the wrong
  // state throws InvalidStateError and reaches nothing; prepareAsync and seekTo never throw, and
  // report it to their error callback instead.
  test('a call in the wrong state throws InvalidStateError, as AVPlay does, or reports it to its error callback', async ({ page }) => {
    await boot(page, { bridge: true, auto: false });
    const n = await bridgeCount(page);
    const r = await page.evaluate(() => new Promise((resolve) => {
      const w = window as any, av = w.webapis.avplay, out: string[] = [];
      const tryIt = (label: string, f: () => void) => {
        try { f(); out.push(label + ' ok ' + av.getState()); } catch (e) { out.push(label + ' ' + (e as any).name + ' ' + av.getState()); }
      };
      const ok = (label: string) => () => out.push(label + ': ok');
      const err = (label: string) => (e: any) => out.push(label + ': ' + e.name);
      const noop = () => {};
      ['play', 'pause', 'stop'].forEach((m) => tryIt(m, () => av[m]()));
      tryIt('setDisplayRect', () => av.setDisplayRect(0, 0, 1, 1));
      tryIt('prepareAsync', () => av.prepareAsync(ok('prepareAsync in NONE'), err('prepareAsync in NONE')));
      tryIt('seekTo', () => av.seekTo(1000, ok('seekTo in NONE'), err('seekTo in NONE')));
      av.open('http://localhost/rest/stream.view?id=song-0');
      ['play', 'pause'].forEach((m) => tryIt(m, () => av[m]()));
      av.prepareAsync(noop, noop);
      w.SonanceShim.receive({ type: 'player', session: w.__engine.last, event: 'prepared', duration: 20000 });
      tryIt('pause', () => av.pause());
      tryIt('open', () => av.open('http://localhost/rest/stream.view?id=song-1'));
      tryIt('prepareAsync', () => av.prepareAsync(ok('prepareAsync in READY'), err('prepareAsync in READY')));
      setTimeout(() => resolve(out), 50);
    }));
    expect(r).toEqual([
      'play InvalidStateError NONE', 'pause InvalidStateError NONE', 'stop ok NONE',
      'setDisplayRect InvalidStateError NONE', 'prepareAsync ok NONE', 'seekTo ok NONE',
      'play InvalidStateError IDLE', 'pause InvalidStateError IDLE',
      'pause InvalidStateError READY', 'open InvalidStateError READY', 'prepareAsync ok READY',
      'prepareAsync in NONE: InvalidStateError', 'seekTo in NONE: InvalidStateError', 'prepareAsync in READY: ok'
    ]);
    expect(await playerCalls(page, n)).toEqual(['open song-0', 'prepare 1']);
  });

  test('open in IDLE replaces the opened stream; a seekTo in IDLE takes effect once it is prepared (D225)', async ({ page }) => {
    await boot(page, { bridge: true, auto: false });
    const n = await bridgeCount(page);
    const r = await page.evaluate(() => {
      const w = window as any, av = w.webapis.avplay, out: string[] = [];
      av.open('http://localhost/rest/stream.view?id=song-0');
      av.open('http://localhost/rest/stream.view?id=song-1');
      av.setListener({ oncurrentplaytime: (ms: number) => out.push('tick ' + ms) });
      av.seekTo(3000, () => out.push('seek ok'), () => out.push('seek err'));
      av.prepareAsync(() => out.push('prepared ' + av.getState()), () => out.push('prepare err'));
      const id = w.__engine.last;
      w.SonanceShim.receive({ type: 'player', session: id, event: 'prepared', duration: 20000 });
      const seek = w.__bridgeCalls.filter((c: any[]) => c[0] === 'playerSeek').pop();
      w.SonanceShim.receive({ type: 'player', session: id, event: 'seeked', seek: seek[3], position: 3000 });
      return out;
    });
    expect(r).toEqual(['prepared READY', 'seek ok', 'tick 3000']);
    expect(await playerCalls(page, n)).toEqual(['open song-0', 'close 1', 'open song-1', 'prepare 2', 'seek 2 3000']);
  });

  test('the session guard: an event from an earlier session is dropped', async ({ page }) => {
    await boot(page, { bridge: true, auto: false });
    const r = await page.evaluate(() => {
      const w = window as any, av = w.webapis.avplay, out: string[] = [];
      const send = (session: number, event: string, extra?: any) =>
        w.SonanceShim.receive(Object.assign({ type: 'player', session, event }, extra));
      av.open('http://localhost/rest/stream.view?id=song-0');
      const first = w.__engine.last;
      av.close();
      av.open('http://localhost/rest/stream.view?id=song-1');
      const second = w.__engine.last;
      av.setListener({
        oncurrentplaytime: (ms: number) => out.push('tick ' + ms),
        onstreamcompleted: () => out.push('completed'),
        onbufferingstart: () => out.push('bufferingstart'),
        onerror: (e: any) => out.push('onerror ' + e)
      });
      av.prepareAsync(() => out.push('ok'), () => out.push('err'));
      send(first, 'prepared', { duration: 1000 });
      send(first, 'error', { error: 'PLAYER_ERROR_CONNECTION_FAILED' });
      out.push(av.getState());
      send(second, 'prepared', { duration: 2000 });
      av.play();
      send(first, 'tick', { position: 600 });
      send(first, 'bufferingstart');
      send(first, 'completed');
      send(second, 'tick', { position: 200 });
      return { out, first, second };
    });
    expect(r.second).toBeGreaterThan(r.first);
    expect(r.out).toEqual(['IDLE', 'ok', 'tick 200']);
  });
});

test.describe('A2 events', () => {
  test('oncurrentplaytime fires on each native tick (every 200 ms while playing), and once after each seek', async ({ page }) => {
    await boot(page, { bridge: true });
    await page.evaluate(() => {
      const w = window as any, av = w.webapis.avplay;
      w.__ticks = [];
      av.open('http://localhost/rest/stream.view?id=song-0');
      av.setListener({ oncurrentplaytime: (ms: number) => w.__ticks.push(ms) });
      av.prepareAsync(() => av.play(), () => {});
    });
    await page.waitForTimeout(1100);
    const ticks: number[] = await page.evaluate(() => {
      (window as any).webapis.avplay.pause();
      return (window as any).__ticks.slice();
    });
    expect(ticks.length).toBeGreaterThanOrEqual(4);
    expect(ticks).toEqual(ticks.map((_, i) => 200 * (i + 1)));
    // A seek calls ok when the native seek completes, then reports the position. The engine is
    // given whole ms.
    const n = await bridgeCount(page);
    const seek = await page.evaluate(() => new Promise((resolve) => {
      const w = window as any, out: string[] = [];
      w.__ticks.length = 0;
      w.webapis.avplay.seekTo(7500.6, () => out.push('ok after ' + w.__ticks.length + ' ticks'), () => out.push('err'));
      setTimeout(() => resolve({ out, ticks: w.__ticks.slice() }), 300);
    }));
    expect(seek).toEqual({ out: ['ok after 0 ticks'], ticks: [7501] });
    expect(await playerCalls(page, n)).toEqual(['seek 1 7501']);
  });

  test('buffering start and end and the end of the stream reach the listener', async ({ page }) => {
    await boot(page, { bridge: true, auto: false });
    const r = await page.evaluate(() => {
      const w = window as any, av = w.webapis.avplay, out: string[] = [];
      av.open('http://localhost/rest/stream.view?id=song-0');
      av.setListener({
        onbufferingstart: () => out.push('bufferingstart'),
        onbufferingcomplete: () => out.push('bufferingcomplete'),
        onstreamcompleted: () => out.push('completed'),
        onevent: (t: string) => out.push('event ' + t)
      });
      av.prepareAsync(() => av.play(), () => out.push('err'));
      const id = w.__engine.last;
      ['bufferingstart', 'bufferingcomplete'].forEach((e) => w.SonanceShim.receive({ type: 'player', session: id, event: e }));
      w.SonanceShim.receive({ type: 'player', session: id, event: 'prepared', duration: 20000 });
      ['bufferingstart', 'bufferingcomplete', 'completed'].forEach((e) => w.SonanceShim.receive({ type: 'player', session: id, event: e }));
      return out;
    });
    expect(r).toEqual(['bufferingstart', 'bufferingcomplete', 'bufferingstart', 'bufferingcomplete', 'completed']);
  });
});

test.describe('A3 errors', () => {
  test('a failed prepare calls its error callback (NotSupported for unsupported media); a later error calls onerror, and nothing follows', async ({ page }) => {
    await boot(page, { bridge: true, auto: false });
    const r = await page.evaluate(() => {
      const w = window as any, av = w.webapis.avplay, out: string[] = [];
      const listener = {
        onerror: (e: any) => out.push('onerror ' + e),
        onstreamcompleted: () => out.push('completed'),
        oncurrentplaytime: (ms: number) => out.push('tick ' + ms)
      };
      // player.js _avplayCause: what the app makes of the error.
      const cause = (err: any) => /NOT_SUPPORTED|NotSupported/.test((err && typeof err === 'object')
        ? String(err.name || err.message || '') : String(err)) ? 'format' : 'load';
      const failedLoad = (error: string) => {
        if (av.getState() !== 'NONE') av.close();
        av.open('http://localhost/rest/stream.view?id=song-0');
        av.setListener(listener);
        av.prepareAsync(() => out.push('ok'), (e: any) => out.push('err ' + e.name + ' ' + e.message + ' ' + cause(e)));
        w.SonanceShim.receive({ type: 'player', session: w.__engine.last, event: 'error', error });
        out.push(av.getState());
      };
      failedLoad('PLAYER_ERROR_NOT_SUPPORTED_FILE');
      failedLoad('PLAYER_ERROR_CONNECTION_FAILED');
      failedLoad('PLAYER_ERROR_GENEREIC');
      av.close();
      av.open('http://localhost/rest/stream.view?id=song-1');
      av.setListener(listener);
      av.prepareAsync(() => av.play(), () => out.push('err'));
      const id = w.__engine.last;
      const send = (event: string, extra?: any) => w.SonanceShim.receive(Object.assign({ type: 'player', session: id, event }, extra));
      send('prepared', { duration: 20000 });
      send('tick', { position: 200 });
      send('error', { error: 'PLAYER_ERROR_CONNECTION_FAILED' });
      send('completed');
      send('tick', { position: 400 });
      return out;
    });
    expect(r).toEqual([
      'err NotSupportedError PLAYER_ERROR_NOT_SUPPORTED_FILE format', 'IDLE',
      'err UnknownError PLAYER_ERROR_CONNECTION_FAILED load', 'IDLE',
      'err UnknownError PLAYER_ERROR_GENEREIC load', 'IDLE',
      'tick 200', 'onerror PLAYER_ERROR_CONNECTION_FAILED'
    ]);
  });

  test('in the app, an unsupported track shows "format not supported", a failed one "couldn\'t be loaded", and the next one plays', async ({ page }) => {
    await boot(page, { bridge: true });
    await recordToasts(page);
    await page.evaluate(() => {
      const w = window as any;
      w.__engine.fail = { 'song-0': 'PLAYER_ERROR_NOT_SUPPORTED_FILE', 'song-1': 'PLAYER_ERROR_CONNECTION_FAILED' };
      w.Player.setQueue(w.__MOCK__.songs.slice(0, 3), 0);
    });
    await page.waitForFunction(() => {
      const s = (window as any).Player.getState();
      return s.currentTrack && s.currentTrack.id === 'song-2' && s.isPlaying;
    });
    expect(await page.evaluate(() => (window as any).__toasts.slice())).toEqual([
      'Track 01 — format not supported', 'Track 02 — couldn\'t be loaded'
    ]);
  });
});

test.describe('S5 screen saver', () => {
  test('setScreenSaver(OFF / ON) asks the host to keep the screen on or not, then calls ok', async ({ page }) => {
    await boot(page, { bridge: true, auto: false });
    const r = await page.evaluate(() => {
      const w = window as any, ac = w.webapis.appcommon, out: string[] = [];
      const n = w.__bridgeCalls.length;
      ac.setScreenSaver(ac.AppCommonScreenSaverState.SCREEN_SAVER_OFF, () => out.push('ok off'), () => out.push('err off'));
      ac.setScreenSaver(ac.AppCommonScreenSaverState.SCREEN_SAVER_ON, () => out.push('ok on'), () => out.push('err on'));
      const calls = w.__bridgeCalls.slice(n);
      const before = out.slice();
      // The host answers once the window's flag is set.
      calls.forEach((c: any[]) => w.SonanceShim.receive({ type: 'callback', id: c[2] }));
      return { states: ac.AppCommonScreenSaverState, calls: calls.map((c: any[]) => c[0] + ' ' + c[1]), before, after: out };
    });
    expect(r.states).toEqual({ SCREEN_SAVER_OFF: 0, SCREEN_SAVER_ON: 1 });
    expect(r.calls).toEqual(['setKeepScreenOn true', 'setKeepScreenOn false']);
    expect(r.before).toEqual([]);
    expect(r.after).toEqual(['ok off', 'ok on']);
  });
});

test.describe('App playback on the bridge', () => {
  test('a track plays through the real Player: play, pause, a seek, then the end of the stream moves to the next', async ({ page }) => {
    await boot(page, { bridge: true });
    const n = await bridgeCount(page);
    const state = () => page.evaluate(() => {
      const s = (window as any).Player.getState();
      return { id: s.currentTrack && s.currentTrack.id, playing: s.isPlaying, at: s.currentTime, duration: s.duration };
    });
    await H.startTrack(page, 3);
    await playing(page, true);
    await expect.poll(async () => (await state()).at).toBeGreaterThanOrEqual(0.4);
    expect((await state()).duration).toBe(20);
    await page.evaluate(() => (window as any).Player.pause());
    await playing(page, false);
    await page.evaluate(() => (window as any).Player.play());
    await playing(page, true);
    await page.evaluate(() => (window as any).Player.seekTo(10));
    await expect.poll(async () => (await state()).at).toBeGreaterThanOrEqual(10.2);
    const first = await page.evaluate(() => (window as any).__engine.last);
    await native(page, [{ type: 'player', session: first, event: 'completed' }]);
    // isPlaying stays true across the track change, so wait for the engine's calls instead.
    await expect.poll(() => playerCalls(page, n)).toEqual([
      'open song-0', 'prepare 1', 'play 1', 'keepScreenOn true',
      'pause 1', 'keepScreenOn false',
      'play 1', 'keepScreenOn true',
      'seek 1 10000',
      'stop 1', 'close 1', 'open song-1', 'prepare 2', 'play 2', 'keepScreenOn true'
    ]);
    expect(await state()).toMatchObject({ id: 'song-1', playing: true });
  });

  test('A4 a transcode streams as MP3 and seeks by reloading with timeOffset, never seekTo', async ({ page }) => {
    await boot(page, { bridge: true });
    const n = await bridgeCount(page);
    await page.evaluate(() => (window as any).Player.setQueue([(window as any).__MOCK__.songs[4]], 0));
    await playing(page, true);
    await page.evaluate(() => (window as any).Player.seekTo(8));
    await expect.poll(() => page.evaluate(() => (window as any).__engine.last)).toBe(2);
    await playing(page, true);
    await expect.poll(() => page.evaluate(() => (window as any).Player.getState().currentTime)).toBeGreaterThanOrEqual(8.2);
    expect(await playerCalls(page, n)).toEqual([
      'open song-4 mp3', 'prepare 1', 'play 1', 'keepScreenOn true',
      'stop 1', 'close 1', 'open song-4 mp3 @8', 'prepare 2', 'play 2', 'keepScreenOn true'
    ]);
  });
});

// ---------------------------------------------------------------------------------------------
// Part 3 (S4): audio focus (B2) and the notification's title (B1). The host's PlayerEngine holds
// the focus; when another app takes it, the host sends {type:'focus', action:'pause'}, and after a
// transient loss {action:'resume'}. A duck is the host's alone (the volume), so the page is not told.
// ---------------------------------------------------------------------------------------------

const focus = (page: Page, action: string) => native(page, [{ type: 'focus', action }]);

// Every Player.pause() and Player.play() call, from any caller (focus.js and the shim both call the
// global Player).
async function countPlayerCalls(page: Page) {
  await page.evaluate(() => {
    const w = window as any;
    w.__pp = { pause: 0, play: 0 };
    ['pause', 'play'].forEach((m) => {
      const orig = w.Player[m];
      w.Player[m] = function() { w.__pp[m]++; return orig.apply(this, arguments as any); };
    });
  });
}

const npBarIcon = (page: Page) => page.evaluate(() => {
  const d = document.querySelector('#now-playing-bar .play-btn-main svg path')!.getAttribute('d');
  const P = (window as any).SonanceUtils.SVG_PATHS;
  return d === P.play ? 'play' : d === P.pause ? 'pause' : d;
});

const avState = (page: Page) => page.evaluate(() => (window as any).webapis.avplay.getState());

test.describe('B2 audio focus', () => {
  test('a focus pause pauses through Player.pause(), as the Stop key does: the UI shows paused, the engine pauses', async ({ page }) => {
    await boot(page, { bridge: true });
    await H.startTrack(page, 2);
    await playing(page, true);
    expect(await npBarIcon(page)).toBe('pause');
    await countPlayerCalls(page);
    const n = await bridgeCount(page);
    await focus(page, 'pause');
    await playing(page, false);
    expect(await page.evaluate(() => (window as any).__pp)).toEqual({ pause: 1, play: 0 });
    expect(await playerCalls(page, n)).toEqual(['pause 1', 'keepScreenOn false']);
    expect(await avState(page)).toBe('PAUSED');
    expect(await npBarIcon(page)).toBe('play');
  });

  test('a resume after a focus pause plays again, through Player.play()', async ({ page }) => {
    await boot(page, { bridge: true });
    await H.startTrack(page, 2);
    await playing(page, true);
    await countPlayerCalls(page);
    await focus(page, 'pause');
    await playing(page, false);
    const n = await bridgeCount(page);
    await focus(page, 'resume');
    await playing(page, true);
    expect(await page.evaluate(() => (window as any).__pp)).toEqual({ pause: 1, play: 1 });
    expect(await playerCalls(page, n)).toEqual(['play 1', 'keepScreenOn true']);
    expect(await npBarIcon(page)).toBe('pause');
    // A second resume, with nothing paused by focus, does nothing.
    await focus(page, 'resume');
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => (window as any).__pp)).toEqual({ pause: 1, play: 1 });
  });

  test('after the user pauses, a resume does nothing', async ({ page }) => {
    await boot(page, { bridge: true });
    await H.startTrack(page, 2);
    await playing(page, true);
    await countPlayerCalls(page);
    const quiet = async () => {
      await page.waitForTimeout(300);
      expect(await page.evaluate(() => (window as any).Player.getState().isPlaying)).toBe(false);
    };
    // (1) The user pauses first; then another app takes the focus and gives it back.
    await press(page, 10252, 'MediaPlayPause');
    await playing(page, false);
    let n = await bridgeCount(page);
    await focus(page, 'pause');
    await focus(page, 'resume');
    await quiet();
    expect(await playerCalls(page, n)).toEqual([]);
    // (2) Focus pauses it; the user plays, then pauses; then the focus comes back.
    await press(page, 10252, 'MediaPlayPause');
    await playing(page, true);
    await focus(page, 'pause');
    await playing(page, false);
    await press(page, 10252, 'MediaPlayPause');
    await playing(page, true);
    await press(page, 10252, 'MediaPlayPause');
    await playing(page, false);
    n = await bridgeCount(page);
    await focus(page, 'resume');
    await quiet();
    expect(await playerCalls(page, n)).toEqual([]);
    expect(await npBarIcon(page)).toBe('play');
  });

  test('a duck changes nothing in the page; a focus message with nothing loaded does nothing', async ({ page }) => {
    const errors = H.watchErrors(page);
    await boot(page, { bridge: true });
    // Nothing loaded yet.
    await focus(page, 'pause');
    await focus(page, 'resume');
    await H.startTrack(page, 2);
    await playing(page, true);
    await countPlayerCalls(page);
    const n = await bridgeCount(page);
    const at = await page.evaluate(() => (window as any).Player.getState().currentTime);
    await focus(page, 'duck');
    await focus(page, 'unduck');
    await page.waitForTimeout(600);
    expect(await page.evaluate(() => (window as any).__pp)).toEqual({ pause: 0, play: 0 });
    expect(await playerCalls(page, n)).toEqual([]);
    expect(await page.evaluate(() => (window as any).Player.getState().currentTime)).toBeGreaterThan(at);
    expect(await npBarIcon(page)).toBe('pause');
    expect(errors.pageErrors).toEqual([]);
  });

  // D227: player.js's prepare callback plays whatever happened while the stream prepared, so a
  // focus pause during a load would be undone, and Sonance would play over the other app.
  test('a focus pause while a track loads holds its start: it never plays, the app shows paused, and a resume plays it', async ({ page }) => {
    await boot(page, { bridge: true, auto: false });
    const n = await bridgeCount(page);
    await page.evaluate(() => (window as any).Player.setQueue((window as any).__MOCK__.songs.slice(0, 3), 0));
    await expect.poll(() => playerCalls(page, n)).toEqual(['open song-0', 'prepare 1']);
    await focus(page, 'pause');
    await native(page, [{ type: 'player', session: 1, event: 'prepared', duration: 20000 }]);
    await page.waitForTimeout(300);
    expect(await playerCalls(page, n)).toEqual(['open song-0', 'prepare 1', 'keepScreenOn true', 'keepScreenOn false']);
    expect(await page.evaluate(() => (window as any).Player.getState().isPlaying)).toBe(false);
    expect(await avState(page)).toBe('PAUSED');
    expect(await npBarIcon(page)).toBe('play');
    const m = await bridgeCount(page);
    await focus(page, 'resume');
    await playing(page, true);
    expect(await playerCalls(page, m)).toEqual(['play 1', 'keepScreenOn true']);
    expect(await avState(page)).toBe('PLAYING');
  });

  test('without a focus pause, a load plays as before', async ({ page }) => {
    await boot(page, { bridge: true, auto: false });
    const n = await bridgeCount(page);
    await page.evaluate(() => (window as any).Player.setQueue((window as any).__MOCK__.songs.slice(0, 3), 0));
    await expect.poll(() => playerCalls(page, n)).toEqual(['open song-0', 'prepare 1']);
    await native(page, [{ type: 'player', session: 1, event: 'prepared', duration: 20000 }]);
    await playing(page, true);
    expect(await playerCalls(page, n)).toEqual(['open song-0', 'prepare 1', 'play 1', 'keepScreenOn true']);
  });
});

test.describe('B1 the notification\'s title', () => {
  test('each track change gives the bridge the track\'s title', async ({ page }) => {
    await boot(page, { bridge: true });
    const titles = () => page.evaluate(() => (window as any).__bridgeCalls
      .filter((c: any[]) => c[0] === 'nowPlaying').map((c: any[]) => c[1]));
    expect(await titles()).toEqual([]);
    await H.startTrack(page, 3);
    await expect.poll(titles).toEqual(['Track 01']);
    await press(page, 10417, 'MediaFastForward');
    await expect.poll(titles).toEqual(['Track 01', 'Track 02']);
  });
});

// ---------------------------------------------------------------------------------------------
// Part 4 (fix round 1, F1): the system keyboard opens only on OK (X4), and a hidden keyboard never
// takes the remote's keys (X2). While Sonance has not opened the keyboard, every editable carries
// inputmode="none", so Chromium never shows it on focus (Login's programmatic focus, D223's
// return). The host's {type:'ime', action:'open'} drops the attribute and is answered with
// imeReady(), on which the host shows the keyboard; {action:'reset'} puts it back. The shim tells
// the host whether an editable has focus (imeEditing), after a setTimeout(0): login.js blurs a
// field before it focuses the next.
// ---------------------------------------------------------------------------------------------

async function bootLogin(page: Page, opts: { bridge: boolean }) {
  const hits = await routeShim(page);
  if (opts.bridge) await fakeBridge(page);
  await H.bootBundled(page, { extra: 'mockNoSession=1', waitFor: false });
  await page.waitForFunction(() => !document.getElementById('splash') && !!document.querySelector('.login-screen'));
  expect(hits.n).toBe(1);
}

const FIELDS = ['login-server', 'login-port', 'login-username', 'login-password'];

// Each Login field's inputmode attribute (null when it has none).
const inputmodes = (page: Page) => page.evaluate((ids) => ids.map((id: string) =>
  document.getElementById(id)!.getAttribute('inputmode')), FIELDS);

const imeCalls = (page: Page) => page.evaluate(() => (window as any).__bridgeCalls
  .filter((c: any[]) => c[0] === 'imeEditing' || c[0] === 'imeReady'));

test.describe('X4 the keyboard opens only on OK', () => {
  test('every editable carries inputmode="none" while the keyboard is closed: set when it is added, and on focus', async ({ page }) => {
    await bootLogin(page, { bridge: true });
    expect(await inputmodes(page)).toEqual(['none', 'none', 'none', 'none']);
    // An editable added later gets it from the observer, before it can be focused.
    expect(await page.evaluate(() => new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.innerHTML = '<input id="t-late"><textarea id="t-area"></textarea><div id="t-ce" contenteditable="true"></div><span id="t-span"></span>';
      document.body.appendChild(wrap);
      setTimeout(() => resolve(['t-late', 't-area', 't-ce', 't-span']
        .map((id) => document.getElementById(id)!.getAttribute('inputmode'))), 0);
    }))).toEqual(['none', 'none', 'none', null]);
    // The focusin backstop: an editable that lost the attribute gets it back as it takes focus.
    expect(await page.evaluate(() => {
      const f = document.getElementById('login-port')!;
      f.removeAttribute('inputmode');
      f.focus();
      return f.getAttribute('inputmode');
    })).toBe('none');
  });

  test('the host\'s open drops inputmode everywhere and calls imeReady(); Next keeps it off; reset puts it back', async ({ page }) => {
    await bootLogin(page, { bridge: true });
    const n = await bridgeCount(page);
    await native(page, [{ type: 'ime', action: 'open' }]);
    expect(await inputmodes(page)).toEqual([null, null, null, null]);
    expect(await page.evaluate((from) => (window as any).__bridgeCalls.slice(from), n)).toEqual([['imeReady']]);
    // Gboard's Next moves focus to the next field without a key event: that field must not hide the
    // keyboard, nor may an editable added while it is open.
    await page.evaluate(() => {
      document.getElementById('login-port')!.focus();
      const late = document.createElement('input');
      late.id = 't-late';
      document.body.appendChild(late);
    });
    await page.waitForTimeout(50);
    expect(await inputmodes(page)).toEqual([null, null, null, null]);
    expect(await page.evaluate(() => document.getElementById('t-late')!.getAttribute('inputmode'))).toBeNull();
    await native(page, [{ type: 'ime', action: 'reset' }]);
    expect(await inputmodes(page)).toEqual(['none', 'none', 'none', 'none']);
    expect(await page.evaluate(() => document.getElementById('t-late')!.getAttribute('inputmode'))).toBe('none');
    // Closed again: a field that takes focus keeps it.
    await page.evaluate(() => document.getElementById('login-username')!.focus());
    expect(await inputmodes(page)).toEqual(['none', 'none', 'none', 'none']);
  });

  test('the editing report: after a setTimeout(0), once per change; login.js\'s blur-then-focus reports nothing', async ({ page }) => {
    await bootLogin(page, { bridge: true });
    // Login's activate() focuses a field: one report.
    await expect.poll(() => imeCalls(page)).toEqual([['imeEditing', true]]);
    // Down on a field: login.js blurs it, then focuses the next, in one handler. Still editing.
    const before = await page.evaluate(() => document.activeElement!.id);
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => document.activeElement!.id)).toBe(FIELDS[FIELDS.indexOf(before) + 1]);
    expect(await imeCalls(page)).toEqual([['imeEditing', true]]);
    // A blur is reported, but not synchronously: only after a setTimeout(0).
    expect(await page.evaluate(() => new Promise((resolve) => {
      (document.activeElement as HTMLElement).blur();
      const sync = (window as any).__bridgeCalls.filter((c: any[]) => c[0] === 'imeEditing').length;
      setTimeout(() => setTimeout(() => resolve([sync,
        (window as any).__bridgeCalls.filter((c: any[]) => c[0] === 'imeEditing').length]), 0), 0);
    }))).toEqual([1, 2]);
    expect(await imeCalls(page)).toEqual([['imeEditing', true], ['imeEditing', false]]);
    // Focus back on a field: reported once more.
    await page.evaluate(() => document.getElementById('login-server')!.focus());
    await expect.poll(() => imeCalls(page)).toEqual([['imeEditing', true], ['imeEditing', false], ['imeEditing', true]]);
  });

  test('a focused field that is removed (Login torn down) reports the end of editing', async ({ page }) => {
    await bootLogin(page, { bridge: true });
    await expect.poll(() => imeCalls(page)).toEqual([['imeEditing', true]]);
    await page.evaluate(() => {
      const s = document.querySelector('.login-screen')!;
      s.parentNode!.removeChild(s);
    });
    await expect.poll(() => imeCalls(page)).toEqual([['imeEditing', true], ['imeEditing', false]]);
  });

  test('without the bridge, Login\'s fields have no inputmode, as today', async ({ page }) => {
    await bootLogin(page, { bridge: false });
    expect(await inputmodes(page)).toEqual([null, null, null, null]);
  });
});
