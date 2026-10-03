// Exercise the HTTP routes with local Cognito/device mocks. No listener or cloud
// connection is opened, and no thermostat command can leave this process.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import * as network from '../network-config.mjs';

const sourceUrl = new URL('../server.mjs', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
const fixture = (overrides = {}) => ({
  currentTemperature: 74, targetTemperature: 75, heatTarget: 68, coolTarget: 77,
  mode: 'cool', fanMode: 'auto', fan: 'Auto', fanRunning: false, activity: 'off',
  canControl: true, updatedAt: '2026-01-01T12:00:00.000Z',
  controlMessage: 'Settings confirmed by the thermostat.', ...overrides,
});
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

async function harness() {
  let handler;
  let cookie;
  const state = { reads: 0, writes: 0, read: async () => ({ thermostat: fixture() }), write: async () => ({ commandSent: true }) };
  const tokens = { getIdToken: () => ({ payload: { email: 'resident@example.test' }, getJwtToken: () => 'mock-token' }) };
  class CognitoUser {
    authenticateUser(_details, callbacks) { callbacks.onSuccess(tokens); }
    getSession(callback) { callback(null, tokens); }
  }
  const api = {
    getResidentProfile: async () => ({ hubId: 'mock-assigned-hub' }),
    async getResidentDeviceDetails() { state.reads++; return state.read(); },
    mapThermostat: details => details.thermostat ? { ...details.thermostat } : null,
    async setThermostat() { state.writes++; return state.write(); },
  };
  const context = vm.createContext({
    Buffer, URL, setTimeout, clearTimeout,
    setInterval: () => ({ unref() {} }), console: { log() {} },
  });
  async function synthetic(exports) {
    const module = new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
    await module.link(() => { throw new Error('Unexpected mock dependency'); });
    await module.evaluate();
    return module;
  }
  const mocks = {
    'node:http': { default: { createServer(callback) { handler = callback; return { listen() {} }; } } },
    'node:fs/promises': { readFile: async () => '<!doctype html>', stat: async () => ({ mtimeMs: 1 }) },
    'node:crypto': { randomBytes },
    'node:url': { fileURLToPath },
    'amazon-cognito-identity-js': { CognitoUser, CognitoUserPool: class {}, AuthenticationDetails: class {} },
    './network-config.mjs': { ...network, networkConfig: () => network.networkConfig({}) },
  };
  const module = new vm.SourceTextModule(source, {
    context, identifier: sourceUrl.href,
    initializeImportMeta(meta) { meta.url = sourceUrl.href; },
    importModuleDynamically(name) {
      assert.equal(new URL(name).pathname, new URL('../iapartments.mjs', import.meta.url).pathname);
      return synthetic(api);
    },
  });
  await module.link(name => {
    assert.ok(Object.hasOwn(mocks, name), `Unexpected dependency: ${name}`);
    return synthetic(mocks[name]);
  });
  await module.evaluate();
  async function request(path, input) {
    const headers = { host: '127.0.0.1:8765', origin: 'http://127.0.0.1:8765', 'content-type': 'application/json' };
    if (cookie) headers.cookie = cookie;
    const req = {
      method: input === undefined ? 'GET' : 'POST', url: path, headers,
      socket: { remoteAddress: '127.0.0.1' },
      async *[Symbol.asyncIterator]() { if (input !== undefined) yield Buffer.from(JSON.stringify(input)); },
    };
    const res = {
      headers: {}, statusCode: null, value: null,
      setHeader(name, value) { this.headers[name] = value; },
      writeHead(code) { this.statusCode = code; },
      end(value) { this.value = JSON.parse(value); },
    };
    await handler(req, res);
    if (res.headers['Set-Cookie']) cookie = res.headers['Set-Cookie'].split(';')[0];
    return { code: res.statusCode, body: res.value };
  }
  return { state, request, login: () => request('/api/login', { email: 'resident@example.test', password: 'mock-password' }) };
}

test('a failed refresh removes old confirmation, preserves timestamp, and blocks commands until recovery', async () => {
  const h = await harness();
  const signedIn = await h.login();
  assert.equal(signedIn.body.readState, 'fresh');
  assert.match(signedIn.body.message, /Settings confirmed/);
  h.state.read = async () => { throw Object.assign(new Error('mock timeout'), { diagnostic: { code: 'TIMEOUT' } }); };
  const failed = await h.request('/api/refresh', {});
  assert.equal(failed.code, 200);
  assert.equal(failed.body.readState, 'stale');
  assert.equal(failed.body.lastReadAt, signedIn.body.lastReadAt);
  assert.equal(failed.body.thermostat.updatedAt, signedIn.body.thermostat.updatedAt);
  assert.equal(failed.body.thermostat.currentTemperature, 74);
  assert.equal(failed.body.thermostat.canControl, false);
  assert.equal(failed.body.thermostat.controlMessage, undefined);
  assert.match(failed.body.message, /did not respond/);
  assert.doesNotMatch(failed.body.message, /Settings confirmed|No device settings were changed/);
  const blocked = await h.request('/api/thermostat', { mode: 'cool', targetTemperature: 75 });
  assert.equal(blocked.code, 409);
  assert.equal(h.state.writes, 0);
  assert.equal(blocked.body.readState, 'stale');
  h.state.read = async () => ({ thermostat: fixture({ controlMessage: undefined, updatedAt: '2026-01-01T12:01:00.000Z' }) });
  const recovered = await h.request('/api/refresh', {});
  assert.equal(recovered.body.readState, 'fresh');
  assert.equal(recovered.body.thermostat.canControl, true);
  assert.equal(recovered.body.lastReadAt, '2026-01-01T12:01:00.000Z');
  assert.equal(recovered.body.message, 'Thermostat readings received.');
});

test('a successful send followed by a failed read is explicitly unconfirmed', async () => {
  const h = await harness();
  await h.login();
  h.state.read = async () => { throw new Error('mock read failure'); };
  const result = await h.request('/api/thermostat', { mode: 'fan_only' });
  assert.equal(result.code, 200);
  assert.equal(h.state.writes, 1);
  assert.equal(result.body.readState, 'stale');
  assert.match(result.body.message, /Command sent/);
  assert.match(result.body.message, /requested settings could not be confirmed/);
  assert.doesNotMatch(result.body.message, /Settings confirmed|No device settings were changed/);
  assert.equal(result.body.thermostat.controlMessage, undefined);
});

test('a no-op followed by a failed read does not claim that a command was sent', async () => {
  const h = await harness();
  await h.login();
  h.state.write = async () => ({ commandSent: false });
  h.state.read = async () => { throw new Error('mock read failure'); };
  const result = await h.request('/api/thermostat', { mode: 'cool', targetTemperature: 75 });
  assert.equal(result.body.readState, 'stale');
  assert.doesNotMatch(result.body.message, /Command sent|Settings confirmed|No device settings were changed/);
});

test('partial write failures include current stale status without keeping previous success', async () => {
  const h = await harness();
  await h.login();
  h.state.write = async () => { throw Object.assign(new Error('mock partial failure'), { userMessage: 'Some settings may have changed. Refresh readings before trying again.' }); };
  const result = await h.request('/api/thermostat', { mode: 'fan_only' });
  assert.equal(result.code, 400);
  assert.equal(result.body.readState, 'stale');
  assert.equal(result.body.thermostat.canControl, false);
  assert.equal(result.body.thermostat.controlMessage, undefined);
  assert.match(result.body.error, /Some settings may have changed/);
  assert.equal(result.body.message, result.body.error);
});

test('the old confirmation clears while a new command is still in flight', async () => {
  const h = await harness();
  await h.login();
  const entered = deferred();
  const release = deferred();
  h.state.write = async () => { entered.resolve(); return release.promise; };
  const pending = h.request('/api/thermostat', { mode: 'fan_only' });
  await entered.promise;
  const inFlight = await h.request('/api/status');
  assert.equal(inFlight.body.thermostat.controlMessage, undefined);
  assert.equal(inFlight.body.message, 'Sending requested settings.');
  h.state.read = async () => ({ thermostat: fixture({ controlMessage: 'Command sent. The thermostat has not yet reported the requested settings.' }) });
  release.resolve({ commandSent: true });
  const result = await pending;
  assert.match(result.body.message, /has not yet reported/);
});

test('missing initial readings are unavailable, and missing later readings preserve stale values', async () => {
  const h = await harness();
  h.state.read = async () => ({ thermostat: null });
  const unavailable = await h.login();
  assert.equal(unavailable.body.readState, 'unavailable');
  assert.equal(unavailable.body.lastReadAt, null);
  assert.equal(unavailable.body.thermostat, null);
  h.state.read = async () => ({ thermostat: fixture() });
  await h.request('/api/refresh', {});
  h.state.read = async () => ({ thermostat: null });
  const stale = await h.request('/api/refresh', {});
  assert.equal(stale.body.readState, 'stale');
  assert.equal(stale.body.thermostat.currentTemperature, 74);
  assert.match(stale.body.message, /did not include supported thermostat readings/);
});

test('a read that finishes after logout cannot restore readings or authentication', async () => {
  const h = await harness();
  await h.login();
  const entered = deferred();
  const release = deferred();
  h.state.read = async () => { entered.resolve(); return release.promise; };
  const pending = h.request('/api/refresh', {});
  await entered.promise;
  await h.request('/api/logout', {});
  release.resolve({ thermostat: fixture() });
  assert.equal((await pending).body.stage, 'signed_out');
  const status = await h.request('/api/status');
  assert.equal(status.body.stage, 'signed_out');
  assert.equal(status.body.thermostat, null);
});

test('a write that finishes after logout does not start a new discovery', async () => {
  const h = await harness();
  await h.login();
  const entered = deferred();
  const release = deferred();
  h.state.write = async () => { entered.resolve(); return release.promise; };
  const pending = h.request('/api/thermostat', { mode: 'fan_only' });
  await entered.promise;
  await h.request('/api/logout', {});
  release.resolve({ commandSent: true });
  const result = await pending;
  assert.equal(result.body.stage, 'signed_out');
  assert.equal(result.body.thermostat, null);
  assert.equal(h.state.reads, 1);
});

test('an old failed read cannot overwrite a new login session', async () => {
  const h = await harness();
  await h.login();
  const entered = deferred();
  const release = deferred();
  h.state.read = async () => { entered.resolve(); await release.promise; throw new Error('old read failure'); };
  const oldRead = h.request('/api/refresh', {});
  await entered.promise;
  await h.request('/api/logout', {});
  h.state.read = async () => ({ thermostat: fixture({ currentTemperature: 72, controlMessage: undefined }) });
  await h.login();
  release.resolve();
  await oldRead;
  const status = await h.request('/api/status');
  assert.equal(status.body.stage, 'connected');
  assert.equal(status.body.readState, 'fresh');
  assert.equal(status.body.thermostat.currentTemperature, 72);
  assert.equal(status.body.message, 'Thermostat readings received.');
});
