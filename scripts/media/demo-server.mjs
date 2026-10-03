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

// Deliberately fictional weather. The placeholder ZIP never reaches a provider.
const daylight = (date) => {
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(date));
  return hour >= 7 && hour < 19;
};
const initialWeather = (zip = '12345') => ({
  state: 'fresh', zip, location: 'Demo location', timezone: 'America/New_York',
  updatedAt: new Date().toISOString(),
  today: { date: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()), high: 73, low: 54 },
  current: { temperature: 68, condition: 'Partly cloudy', icon: 'partly-cloudy', isDay: daylight(new Date()) },
  hourly: Array.from({ length: 12 }, (_, index) => ({
    time: new Date((Math.floor(Date.now() / 3600000) + 1 + index) * 3600000).toISOString(),
    temperature: [68, 66, 64, 62, 61, 60, 59, 58, 58, 57, 56, 55][index],
    precipitationProbability: [10, 10, 15, 25, 40, 55, 60, 45, 30, 20, 15, 10][index],
    condition: index < 4 ? 'Partly cloudy' : index < 8 ? 'Light rain' : 'Cloudy',
    icon: index < 4 ? 'partly-cloudy' : index < 8 ? 'rain' : 'cloudy',
    isDay: daylight(new Date((Math.floor(Date.now() / 3600000) + 1 + index) * 3600000)),
  })),
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
  let weatherState = 'fresh';
  let weatherFail = false;
  let weatherDelayMs = 0;
  let weatherOverrides = {};
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
    weatherState = 'fresh'; weatherFail = false; weatherDelayMs = 0; weatherOverrides = {};
    commands.length = 0; requests.length = 0;
  };
  const control = (input) => {
    if (input.reset) reset();
    if (typeof input.failReads === 'boolean') failReads = input.failReads;
    if (typeof input.failAfterWrite === 'boolean') failAfterWrite = input.failAfterWrite;
    if (typeof input.delayMs === 'number') delayMs = Math.max(0, Math.min(input.delayMs, 3000));
    if (['fresh', 'stale', 'unconfigured'].includes(input.weatherState)) weatherState = input.weatherState;
    if (typeof input.weatherFail === 'boolean') weatherFail = input.weatherFail;
    if (typeof input.weatherDelayMs === 'number') weatherDelayMs = Math.max(0, Math.min(input.weatherDelayMs, 3000));
    if (input.weatherOverrides) weatherOverrides = structuredClone(input.weatherOverrides);
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
      const requestUrl = new URL(req.url, 'http://127.0.0.1');
      if (requestUrl.pathname === '/api/weather' && req.method === 'GET') {
        // Snapshot before the artificial delay so race tests can distinguish responses.
        const zip = requestUrl.searchParams.get('zip') || '12345';
        const weather = { ...initialWeather(zip), state: weatherState, ...structuredClone(weatherOverrides) };
        const failed = weatherFail;
        if (weatherDelayMs) await new Promise((resolve) => setTimeout(resolve, weatherDelayMs));
        if (!/^\d{5}$/.test(zip)) { json({ state: 'unavailable', error: 'Enter a valid five-digit US ZIP code.' }, 400); return; }
        if (failed) { json({ state: 'unavailable', error: 'Weather is unavailable. Try again later.' }, 503); return; }
        if (weather.state === 'unconfigured') { json({ state: 'unconfigured', defaultZip: null }); return; }
        if (weather.state === 'stale') weather.message = 'Weather could not be refreshed. Showing the last available forecast.';
        json(weather); return;
      }
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
