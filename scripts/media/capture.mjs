// Optional, repeatable media regeneration with a locally installed browser.
// Usage: node scripts/media/capture.mjs [path-to-playwright-core-entry]
// Uses only the synthetic loopback fixture. No account or hardware is accessed.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startDemoServer } from './demo-server.mjs';
import { renderCapturedFrames } from './render-captures.mjs';

const { chromium } = await import(process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href : 'playwright-core');
const temporary = await mkdtemp(path.join(tmpdir(), 'temperme-demo-'));
if (path.dirname(path.resolve(temporary)) !== path.resolve(tmpdir()) || !path.basename(temporary).startsWith('temperme-demo-')) {
  throw new Error('The media working directory must remain inside the temporary directory.');
}
await mkdir(temporary, { recursive: true });
let fixture;
let browser;
let context;
const errors = [];
const frames = [];
const stills = [];

try {
  fixture = await startDemoServer();
  browser = await chromium.launch({ channel: process.env.TEMPERME_MEDIA_BROWSER || 'chrome', headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 1200 }, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light' });
  const page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  await context.route('**/*', (route) => new URL(route.request().url()).origin === new URL(fixture.url).origin ? route.continue() : route.abort());
  const capture = async (name, seconds, output) => {
    await page.evaluate(() => window.scrollTo(0, 0));
    if (seconds) {
      await page.screenshot({ path: path.join(temporary, name) });
      frames.push({ source: name, seconds });
    }
    if (output) {
      const source = `still-${name}`;
      await page.screenshot({ path: path.join(temporary, source), fullPage: true });
      stills.push({ source, output });
    }
  };
  const apply = async () => {
    await page.getByRole('button', { name: 'Apply settings', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('connection-card').getAttribute('aria-busy') === 'false');
  };
  await page.goto(fixture.url);
  await page.locator('#thermostat-view').waitFor({ state: 'visible' });
  await page.locator('#weather-forecast').waitFor({ state: 'visible' });
  assert.equal(await page.locator('#weather-location').textContent(), 'Demo location');
  assert.equal(await page.locator('#weather-hours > li').count(), 12);
  await capture('dashboard.png', 4, 'dashboard.png');
  await page.locator('#target').fill('72');
  assert.equal(fixture.commands.length, 0, 'Editing must not send a command.');
  await capture('cool-draft.png', 3);
  await apply();
  await capture('cool-confirmed.png', 3);
  await page.getByRole('button', { name: 'Fan only', exact: true }).click();
  await capture('fan-draft.png', 3);
  await apply();
  await capture('fan-only.png', 4, 'fan-only.png');
  await page.getByRole('button', { name: 'Range', exact: true }).click();
  await page.locator('#heat').fill('68');
  await page.locator('#cool').fill('76');
  await page.locator('#fan').selectOption('auto');
  await capture('range-draft.png', 3);
  await apply();
  await capture('range.png', 5, 'range.png');
  assert.deepEqual(fixture.commands, [
    { mode: 'cool', targetTemperature: 72 },
    { mode: 'fan_only' },
    { mode: 'heat_cool', heatTarget: 68, coolTarget: 76, fan: 'auto' },
  ]);
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth), false, `No horizontal overflow at ${width}px.`);
    if (width === 390) await capture('mobile.png', 0, 'mobile.png');
  }
  assert.deepEqual(errors, []);
  await writeFile(path.join(temporary, 'manifest.json'), JSON.stringify({ stills, frames }, null, 2));
  const result = await renderCapturedFrames(path.join(temporary, 'manifest.json'));
  console.log(JSON.stringify({ ...result, browserErrors: errors.length, mockCommands: fixture.commands.length }));
} finally {
  const cleanupErrors = [];
  for (const resource of [context, browser, fixture]) {
    try { await resource?.close(); } catch (error) { cleanupErrors.push(error); }
  }
  // Remove only the exact temporary directory created and checked above.
  await rm(temporary, { recursive: true, force: true });
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Media capture cleanup failed.');
}
