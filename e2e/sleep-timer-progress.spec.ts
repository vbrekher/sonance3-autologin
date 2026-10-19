import { test, expect, Page } from '@playwright/test';
import * as H from './helpers/sonance';

// Fix round 1, X5 (ticket-3.xx-androidtv B4): the sleep timer also checks its deadline on Player's
// progress events. On Android TV a hidden page's timer chains stop about five minutes after Home
// (WebView 113), so the timer's setTimeout chain never reaches the deadline there; the progress
// events keep coming while anything plays, because native code drives them. Here the page's clock
// jumps past the deadline without firing any timer (Playwright's setSystemTime), as a frozen chain
// would leave it: only a progress event can notice.

declare const Player: any;

async function chip(page: Page) {
  return page.evaluate(() => document.getElementById('np-sleep-chip')!.textContent);
}

async function nowPlayingWithTimer(page: Page) {
  await page.clock.install();
  await H.bootMock(page);
  await H.startTrack(page, 12, { paused: true });
  await H.navTo(page, 'nowplaying');
  await H.press(page, 'ArrowDown');
  await H.settle(page, 300);
  await page.evaluate(() => Player.play());
  await page.waitForFunction(() => Player.getState().isPlaying);
  // Down to the controls, then Right along them to the chip, as A7 does; Enter sets 15 min.
  await H.press(page, 'ArrowDown');
  await H.press(page, 'ArrowRight', 5, 30);
  await H.settle(page);
  expect((await H.focus(page)).id).toBe('np-sleep-chip');
  await H.press(page, 'Enter');
  await H.settle(page, 20);
  expect(await chip(page)).toBe('Sleep in 15 min');
}

test('X5 the deadline passes with every timer frozen: the next progress event pauses playback within 1 s', async ({ page }) => {
  await nowPlayingWithTimer(page);
  const now = await page.evaluate(() => Date.now());
  await page.clock.setSystemTime(now + 15 * 60000 + 1000);
  const t0 = Date.now();
  await page.waitForFunction(() => !Player.getState().isPlaying, null, { timeout: 1000 });
  expect(Date.now() - t0).toBeLessThan(1000);
  expect(await page.evaluate(() => document.querySelector('.sonance-toast')!.textContent)).toBe('Sleep timer: playback paused');
  expect(await chip(page)).toBe('Sleep timer');
});

test('X5 before the deadline, progress events change nothing; the timer\'s own chain still expires it once', async ({ page }) => {
  await nowPlayingWithTimer(page);
  await page.evaluate(() => {
    const w = window as any;
    w.__pauses = 0;
    const orig = Player.pause;
    Player.pause = function() { w.__pauses++; return orig.apply(this, arguments as any); };
  });
  const now = await page.evaluate(() => Date.now());
  // A minute before the deadline: still playing, through many progress events.
  await page.clock.setSystemTime(now + 14 * 60000);
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => Player.getState().isPlaying)).toBe(true);
  // The chain fires at the deadline: one pause, one toast, even though progress events follow.
  await page.clock.fastForward('01:01');
  await page.waitForFunction(() => !Player.getState().isPlaying);
  await page.waitForTimeout(500);
  await page.clock.fastForward('02:00');
  expect(await page.evaluate(() => (window as any).__pauses)).toBe(1);
  expect(await chip(page)).toBe('Sleep timer');
});
