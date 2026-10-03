import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { networkConfig, requestOrigin, sameOriginJson, sessionCookie } from '../network-config.mjs';

test('native defaults retain loopback-only HTTP', () => {
  const config = networkConfig({});
  assert.equal(config.bindHost, '127.0.0.1');
  assert.equal(config.port, 8765);
  assert.equal(config.httpsProxy, false);
  assert.equal(requestOrigin(config, { host: 'localhost:8765' }), 'http://localhost:8765');
  assert.equal(requestOrigin(config, { host: '192.0.2.10:8765' }), null);
  assert.doesNotMatch(sessionCookie('test', config), /Secure/);
});

test('network exposure requires explicit HTTPS proxy mode and exact HTTPS origins', () => {
  for (const env of [
    { TEMPERME_BIND_HOST: '0.0.0.0' },
    { TEMPERME_BIND_HOST: '192.0.2.10' },
    { TEMPERME_HTTPS_PROXY: 'true' },
    { TEMPERME_HTTPS_PROXY: '1' },
    { TEMPERME_HTTPS_PROXY: '1', TEMPERME_PUBLIC_ORIGINS: 'http://192.0.2.10:9443' },
    { TEMPERME_HTTPS_PROXY: '1', TEMPERME_PUBLIC_ORIGINS: 'https://192.0.2.10:9443/' },
    { TEMPERME_HTTPS_PROXY: '1', TEMPERME_PUBLIC_ORIGINS: 'https://user:password@192.0.2.10:9443' },
    { TEMPERME_PUBLIC_ORIGINS: 'http://192.0.2.10:8765' },
    { TEMPERME_PUBLIC_ORIGINS: 'http://localhost:8766' },
    { TEMPERME_PORT: '0' },
  ]) assert.throws(() => networkConfig(env));
});

test('POSTs must match their actual Host even when multiple origins are configured', () => {
  const config = networkConfig({ TEMPERME_HTTPS_PROXY: '1', TEMPERME_PUBLIC_ORIGINS: 'https://192.0.2.10:9443,https://thermostat.example:9443' });
  const headers = { host: '192.0.2.10:9443', origin: 'https://192.0.2.10:9443', 'content-type': 'application/json; charset=UTF-8' };
  assert.equal(sameOriginJson(config, headers), true);
  assert.equal(sameOriginJson(config, { ...headers, origin: 'https://thermostat.example:9443' }), false);
  assert.equal(sameOriginJson(config, { ...headers, origin: undefined }), false);
  assert.equal(sameOriginJson(config, { ...headers, 'content-type': 'application/jsonp' }), false);
  assert.equal(sameOriginJson(config, { ...headers, host: 'attacker.example', 'x-forwarded-host': headers.host, 'x-forwarded-proto': 'https' }), false);
  assert.match(sessionCookie('test', config), /; Secure$/);
});

async function unusedPort() {
  const socket = net.createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const port = socket.address().port;
  await new Promise(resolve => socket.close(resolve));
  return port;
}

function request(port, path, headers, method = 'GET', body = '') {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, headers, method }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('proxy server issues secure cookies and rejects cross-origin control without cloud access', async t => {
  const port = await unusedPort();
  const publicHost = '192.0.2.10:9443';
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: new URL('..', import.meta.url),
    env: { ...process.env, TEMPERME_BIND_HOST: '127.0.0.1', TEMPERME_PORT: String(port), TEMPERME_HTTPS_PROXY: '1', TEMPERME_PUBLIC_ORIGINS: `https://${publicHost},https://other.example:9443` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { child.kill(); });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Test server did not start')), 10000);
    child.stdout.on('data', chunk => {
      if (chunk.toString().includes('TemperMe ready:')) { clearTimeout(timeout); resolve(); }
    });
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', code => { clearTimeout(timeout); reject(new Error(`Test server exited: ${code}`)); });
  });
  const health = await request(port, '/healthz', { host: `127.0.0.1:${port}` });
  assert.equal(health.status, 200);
  assert.equal(health.headers['set-cookie'], undefined);
  const status = await request(port, '/api/status', { host: publicHost });
  assert.equal(status.status, 200);
  assert.equal(status.headers['cache-control'], 'no-store');
  assert.equal(status.headers['referrer-policy'], 'no-referrer');
  assert.equal(status.body.stage, 'signed_out');
  assert.match(status.headers['set-cookie'][0], /HttpOnly; SameSite=Strict; Path=\/; Secure/);
  assert.equal((await request(port, '/api/status', { host: 'attacker.example', 'x-forwarded-host': publicHost })).status, 403);
  const headers = { host: publicHost, origin: 'https://other.example:9443', 'content-type': 'application/json', cookie: status.headers['set-cookie'][0].split(';')[0] };
  assert.equal((await request(port, '/api/thermostat', headers, 'POST', '{}')).status, 403);
  headers.origin = `https://${publicHost}`;
  assert.equal((await request(port, '/api/thermostat', headers, 'POST', '{}')).status, 401);
});
