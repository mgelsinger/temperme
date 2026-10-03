// Usage: node scripts/media/capture.mjs [path-to-playwright-core-entry]
// Requires playwright-core, a Chromium browser, and ffmpeg on PATH.
// No connection to the production service is made. All data is synthetic.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { startDemoServer } from './demo-server.mjs';

const { chromium } = await import(process.argv[2] ? pathToFileURL(path.resolve(process.argv[2])).href : 'playwright-core');
const output = fileURLToPath(new URL('../../docs/media/', import.meta.url));
const temporary = await mkdtemp(path.join(tmpdir(), 'temperme-demo-'));
const temporaryRoot = path.resolve(tmpdir());
if (path.dirname(path.resolve(temporary)) !== temporaryRoot || !path.basename(temporary).startsWith('temperme-demo-')) {
  throw new Error('The media working directory must remain inside the temporary directory.');
}
await mkdir(output, { recursive: true });
let fixture;
let browser;
let context;
let page;
const errors = [];
const frames = [];
async function frame(caption, detail, seconds = 2) {
  await page.evaluate(({ caption, detail }) => {
    let label = document.getElementById('documentation-caption');
    if (!label) {
      label = document.createElement('aside');
      label.id = 'documentation-caption';
      label.style.cssText = 'margin-top:52px;padding:24px;border-left:3px solid #225f91;background:#edf2f2;border-radius:0 14px 14px 0;max-width:360px;';
      document.querySelector('.intro').append(label);
    }
    label.replaceChildren();
    for (const [text, style] of [
      ['INTERACTIVE DEMO', 'font-size:10px;letter-spacing:2px;color:#557386;font-weight:700;margin:0 0 14px'],
      [caption, 'font-size:23px;line-height:1.25;letter-spacing:-.6px;color:#20384a;font-weight:600;margin:0 0 12px'],
      [detail, 'font-size:14px;line-height:1.6;color:#687982;margin:0 0 20px'],
      ['Synthetic data. No live thermostat.', 'font-size:11px;color:#687982;margin:0'],
    ]) {
      const paragraph = document.createElement('p');
      paragraph.textContent = text;
      paragraph.style.cssText = style;
      label.append(paragraph);
    }
  }, { caption, detail });
  const filename = `frame-${String(frames.length).padStart(2, '0')}.png`;
  await page.screenshot({ path: path.join(temporary, filename) });
  frames.push({ filename, seconds });
}
async function apply() {
  await page.getByRole('button', { name: 'Apply settings', exact: true }).click();
  await page.waitForFunction(() => document.getElementById('connection-card').getAttribute('aria-busy') === 'false');
}

try {
  fixture = await startDemoServer();
  browser = await chromium.launch({ channel: process.env.TEMPERME_MEDIA_BROWSER || 'chrome', headless: true });
  context = await browser.newContext({ viewport: { width: 1280, height: 1280 }, deviceScaleFactor: 1, locale: 'en-US', timezoneId: 'UTC', colorScheme: 'light' });
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.message));
  // This is a fresh browser context. Refuse every request outside the fixture.
  await context.route('**/*', (route) => new URL(route.request().url()).origin === new URL(fixture.url).origin ? route.continue() : route.abort());
  await page.goto(fixture.url);
  await page.getByRole('heading', { name: 'Your thermostat', exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'dashboard.png'), fullPage: true });
  await frame('A little more comfort.', 'Check the room temperature and choose the setting that feels right.', 3);
  await page.getByLabel('Target temperature (F)').fill('72');
  await frame('Choose your target.', 'Set the cooling target to 72 degrees, then apply.', 2);
  await apply();
  assert.equal(await page.locator('#target-temperature').innerText(), '72°F');
  await frame('Cool, confirmed.', 'The latest reported setting appears above the controls.', 3);
  await page.getByLabel('Mode', { exact: true }).selectOption('fan_only');
  await frame('Just move the air.', 'Fan only switches heating and cooling off and runs the fan continuously.', 3);
  await apply();
  assert.equal(await page.locator('#current-mode').innerText(), 'Fan only');
  assert.equal(await page.locator('#fan-activity').innerText(), 'Running');
  assert.equal(await page.locator('#hvac-activity').innerText(), 'Idle');
  await page.locator('#documentation-caption').evaluate((element) => element.remove());
  await page.screenshot({ path: path.join(output, 'fan-only.png'), fullPage: true });
  await frame('Airflow without the chill.', 'Fan setting: On. Fan activity: Running. Heating and cooling: Idle.', 3);
  await page.getByLabel('Mode', { exact: true }).selectOption('heat_cool');
  await page.getByLabel('Heat below (F)').fill('68');
  await page.getByLabel('Cool above (F)').fill('76');
  await page.getByLabel('Fan setting', { exact: true }).selectOption('auto');
  await frame('A range that feels right.', 'Heat below 68 degrees. Cool above 76 degrees. Let the thermostat do the rest.', 3);
  await apply();
  assert.equal(await page.locator('#current-mode').innerText(), 'Heat & cool');
  assert.equal(await page.locator('#heat-target').innerText(), '68°F');
  assert.equal(await page.locator('#cool-target').innerText(), '76°F');
  await frame('Your comfort. Your interface.', 'Cool, heat, fan only, or a comfortable range. All in your browser.', 4);
  await page.locator('#documentation-caption').evaluate((element) => element.remove());
  await page.screenshot({ path: path.join(output, 'range.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(output, 'mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false);
  assert.deepEqual(fixture.commands, [
    { mode: 'cool', targetTemperature: 72 },
    { mode: 'fan_only' },
    { mode: 'heat_cool', heatTarget: 68, coolTarget: 76, fan: 'auto' },
  ]);
  assert.deepEqual(errors, []);
  const concat = frames.flatMap(({ filename, seconds }) => [`file '${filename}'`, `duration ${seconds}`]);
  concat.push(`file '${frames.at(-1).filename}'`);
  await writeFile(path.join(temporary, 'frames.txt'), concat.join('\n'));
  const ffmpeg = (args) => {
    const result = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { cwd: temporary, encoding: 'utf8' });
    if (result.status !== 0) throw new Error(result.stderr || 'ffmpeg failed');
  };
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', 'frames.txt', '-vf', 'fps=24,format=yuv420p', '-c:v', 'libx264', '-crf', '20', '-movflags', '+faststart', '-map_metadata', '-1', path.join(output, 'demo.mp4')]);
  ffmpeg(['-i', path.join(output, 'demo.mp4'), '-vf', 'fps=4,scale=960:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=3', '-loop', '0', path.join(output, 'demo.gif')]);
  console.log(JSON.stringify({ captured: ['dashboard.png', 'fan-only.png', 'range.png', 'mobile.png', 'demo.gif', 'demo.mp4'], browserErrors: errors.length, mockCommands: fixture.commands.length, syntheticDataOnly: true }));
} finally {
  const cleanupErrors = [];
  for (const resource of [context, browser, fixture]) {
    try { await resource?.close(); }
    catch (error) { cleanupErrors.push(error); }
  }
  // Delete only the exact temporary directory created and checked above.
  await rm(temporary, { recursive: true, force: true });
  if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Media capture cleanup failed.');
}
