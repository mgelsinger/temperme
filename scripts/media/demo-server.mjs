// Documentation fixture only. This server never loads the cloud adapter,
// credentials, a real session, or a thermostat identifier.
import http from 'node:http';
import { readFile } from 'node:fs/promises';

const ui = new URL('../../public/index.html', import.meta.url);

export async function startDemoServer() {
  const initial = () => ({
    canControl: true,
    unit: 'F',
    currentTemperature: 75,
    mode: 'cool',
    fan: 'auto',
    fanMode: 'auto',
    fanRunning: true,
    activity: 'cool',
    targetTemperature: 74,
    heatTarget: 68,
    coolTarget: 76,
    minimumTemperature: 50,
    maximumTemperature: 90,
    updatedAt: '2026-01-01T14:30:00.000Z',
  });
  let thermostat = initial();
  let message = 'Showing the latest thermostat readings received by this service.';
  const state = () => ({ stage: 'connected', account: { email: 'demo@example.com' }, thermostat, message });
  const commands = [];
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    try {
      if (req.url === '/' && req.method === 'GET') {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.end(await readFile(ui));
        return;
      }
      res.setHeader('Content-Type', 'application/json');
      if (req.url === '/api/status' || req.url === '/api/refresh') {
        res.end(JSON.stringify(state()));
        return;
      }
      if (req.url === '/api/thermostat' && req.method === 'POST') {
        let input = '';
        for await (const chunk of req) input += chunk;
        const command = JSON.parse(input);
        commands.push(command);
        thermostat.mode = command.mode;
        if (command.mode === 'fan_only') {
          Object.assign(thermostat, { fan: 'on', fanMode: 'on', fanRunning: true, activity: 'off' });
        } else if (command.mode === 'off') {
          Object.assign(thermostat, { fan: 'auto', fanMode: 'auto', fanRunning: false, activity: 'off' });
        } else {
          for (const field of ['targetTemperature', 'heatTarget', 'coolTarget']) {
            if (typeof command[field] === 'number') thermostat[field] = command[field];
          }
          if (command.fan) thermostat.fan = thermostat.fanMode = command.fan;
          thermostat.activity = command.mode === 'cool' ? 'cool' : 'off';
          thermostat.fanRunning = thermostat.fan === 'on' || thermostat.activity !== 'off';
        }
        message = 'Settings confirmed by the thermostat.';
        res.end(JSON.stringify(state()));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ error: 'This is a documentation demo with no cloud connection.' }));
    } catch {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: 'Invalid demo request.' }));
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/`,
    commands,
    reset() { thermostat = initial(); },
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}
