// Documentation fixture only. This server never imports the cloud adapter,
// credentials, a real session, or a thermostat identifier.
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const ui = new URL('../../public/index.html', import.meta.url);
const latestMessage = 'Showing the latest thermostat readings received by this service.';
const initial = () => ({
  canControl: true, unit: 'F', currentTemperature: 75, mode: 'cool',
  fan: 'auto', fanMode: 'auto', fanRunning: true, activity: 'cool',
  targetTemperature: 74, heatTarget: 68, coolTarget: 76,
  minimumTemperature: 50, maximumTemperature: 90,
  updatedAt: new Date().toISOString(),
});

export async function startDemoServer() {
  let thermostat = initial();
  let device = structuredClone(thermostat);
  let stage = 'connected';
  let readState = 'fresh';
  let lastReadAt = thermostat.updatedAt;
  let message = latestMessage;
  let failReads = false;
  let failAfterWrite = false;
  let delayMs = 0;
  const commands = [];
  const requests = [];
  const state = () => stage === 'signed_out'
    ? { stage, thermostat: null, message: 'Sign in with your iApartments resident account.' }
    : { stage, account: { email: 'demo@example.com' }, thermostat, readState, lastReadAt, message };
  const markRead = (failed, afterWrite = false) => {
    readState = failed ? (thermostat ? 'stale' : 'unavailable') : 'fresh';
    if (thermostat) thermostat.canControl = !failed;
    if (failed) {
      message = afterWrite
        ? 'Command sent, but the latest thermostat reading could not be retrieved. The requested settings could not be confirmed.'
        : 'The latest thermostat reading could not be retrieved. Showing older readings; refresh to try again.';
    } else {
      thermostat = structuredClone(device);
      thermostat.canControl = true;
      lastReadAt = new Date().toISOString();
      thermostat.updatedAt = lastReadAt;
      message = afterWrite ? 'Settings confirmed by the thermostat.' : latestMessage;
    }
  };
  const reset = () => {
    thermostat = initial(); stage = 'connected'; readState = 'fresh';
    device = structuredClone(thermostat);
    lastReadAt = thermostat.updatedAt; message = latestMessage;
    failReads = false; failAfterWrite = false; delayMs = 0;
    commands.length = 0; requests.length = 0;
  };
  const control = (input) => {
    if (input.reset) reset();
    if (typeof input.failReads === 'boolean') failReads = input.failReads;
    if (typeof input.failAfterWrite === 'boolean') failAfterWrite = input.failAfterWrite;
    if (typeof input.delayMs === 'number') delayMs = Math.max(0, Math.min(input.delayMs, 3000));
    if (input.thermostat) { Object.assign(thermostat, input.thermostat); Object.assign(device, input.thermostat); }
    if (input.stage === 'signed_out' || input.stage === 'connected') stage = input.stage;
    if (input.markRead) markRead(failReads);
    return { state: state(), commands, requests };
  };
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    // Prevent the demo from fetching external scripts, fonts, frames or APIs.
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; font-src 'none'; frame-src 'none'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'");
    const json = (data, status = 200) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(data));
    };
    try {
      if (req.url === '/' && req.method === 'GET') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(await readFile(ui));
        return;
      }
      // A loopback-only test control surface, never part of the product server.
      if (req.url === '/__demo/control') {
        let text = '';
        for await (const chunk of req) text += chunk;
        json(control(req.method === 'POST' ? JSON.parse(text || '{}') : {}));
        return;
      }
      requests.push({ method: req.method, path: req.url });
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
      if (req.url === '/api/status' && req.method === 'GET') {
        json(state()); return;
      }
      if (req.url === '/api/refresh' && req.method === 'POST') {
        if (stage === 'connected') markRead(failReads);
        json(state()); return;
      }
      if (req.url === '/api/logout' && req.method === 'POST') {
        stage = 'signed_out'; json(state()); return;
      }
      if (req.url === '/api/thermostat' && req.method === 'POST') {
        let text = '';
        for await (const chunk of req) text += chunk;
        const command = JSON.parse(text);
        if (stage !== 'connected' || readState !== 'fresh') {
          json({ ...state(), error: 'Refresh the demo readings before sending a command.' }, 400); return;
        }
        if (!['cool', 'heat', 'heat_cool', 'fan_only', 'off'].includes(command.mode)) {
          json({ ...state(), error: 'Choose a supported climate mode.' }, 400); return;
        }
        const targets = command.mode === 'heat_cool' ? [command.heatTarget, command.coolTarget]
          : ['cool', 'heat'].includes(command.mode) ? [command.targetTemperature] : [];
        if (targets.some((value) => !Number.isFinite(value) || value < 50 || value > 90)
          || (command.mode === 'heat_cool' && command.coolTarget - command.heatTarget < 3)) {
          json({ ...state(), error: 'Use temperatures from 50 to 90 degrees and keep the heating target at least 3 degrees below cooling.' }, 400); return;
        }
        commands.push(command);
        device.mode = command.mode;
        if (command.mode === 'fan_only') {
          Object.assign(device, { mode: 'off', fan: 'on', fanMode: 'on', fanRunning: true, activity: 'off' });
        } else if (command.mode === 'off') {
          Object.assign(device, { fan: 'auto', fanMode: 'auto', fanRunning: false, activity: 'off' });
        } else {
          for (const field of ['targetTemperature', 'heatTarget', 'coolTarget']) {
            if (typeof command[field] === 'number') device[field] = command[field];
          }
          if (command.fan) device.fan = device.fanMode = command.fan;
          device.activity = command.mode === 'cool' ? 'cool' : 'off';
          device.fanRunning = device.fan === 'on' || device.activity !== 'off';
        }
        markRead(failAfterWrite, true);
        json(state()); return;
      }
      json({ error: 'This documentation demo has no cloud connection.' }, 404);
    } catch {
      json({ error: 'Invalid demo request.' }, 400);
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/`, commands, requests, reset, control,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = await startDemoServer();
  console.log(fixture.url);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await fixture.close(); process.exit(0); });
}
