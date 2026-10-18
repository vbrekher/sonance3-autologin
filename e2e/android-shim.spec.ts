import { test, expect, Page } from '@playwright/test';
import * as path from 'path';
import * as H from './helpers/sonance';

// Android TV port (ticket-3.xx-androidtv §7.1), part 1 (S2): the shim's tizen.* parts, the
// platform seam (S3), key injection (K1) and the bridge calls (S4), on the bundled build.
//
// The Android host serves android/shim/webapis.js where Tizen serves webapis.js; here it is routed
// to that path (the dev server 404s it). A fake window.SonanceNative, injected before any page
// script, stands in for the host's bridge: it answers androidVersion() with "11" and records every
// call. Without the fake the shim must do nothing (S1), so the browser and Tizen readings stay as
// they are today.

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
async function fakeBridge(page: Page) {
  await page.addInitScript(() => {
    const calls: any[] = [];
    (window as any).__bridgeCalls = calls;
    (window as any).SonanceNative = {
      androidVersion() { calls.push(['androidVersion']); return '11'; },
      exit() { calls.push(['exit']); }
    };
  });
}

async function boot(page: Page, opts: { bridge: boolean; jellyfin?: boolean }) {
  const hits = await routeShim(page);
  if (opts.bridge) await fakeBridge(page);
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
