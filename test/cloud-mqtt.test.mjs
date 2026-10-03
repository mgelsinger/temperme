// Run with: node --experimental-vm-modules --test test/cloud-mqtt.test.mjs
// All cloud and MQTT imports are replaced with local mocks. No network is used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import * as crypto from 'node:crypto';
import vm from 'node:vm';

const source = await readFile(new URL('../cloud-mqtt.mjs', import.meta.url), 'utf8');
const scope = { hubId: 'owned-hub', assignedHubId: 'owned-hub', assignedThingName: 'owned-thermostat' };
const claims = {
  iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_RccNji1RU',
  aud: '8p7a56ejp870vo59r8bdhsn0i', token_use: 'id', sub: 'resident-sub',
  exp: Math.floor(Date.now() / 1000) + 3600,
};
const idToken = `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.mock-signature`;

async function harness({ holdPublish = false, connectError, credentialError } = {}) {
  const calls = [];
  const state = { broker: null, signedUrl: null };
  const context = vm.createContext({
    Buffer, Date, Promise, Set, Object, Number, String, Error, JSON,
    encodeURIComponent, setTimeout, clearTimeout, AbortSignal,
  });
  class GetIdCommand { constructor(input) { this.input = input; } }
  class GetCredentialsForIdentityCommand { constructor(input) { this.input = input; } }
  class CognitoIdentityClient {
    constructor(config) { assert.equal(config.region, 'us-east-1'); }
    async send(command) {
      calls.push(command);
      if (credentialError) throw credentialError;
      if (command instanceof GetIdCommand) return { IdentityId: 'us-east-1:mock-identity' };
      return { Credentials: {
        AccessKeyId: 'mock-key', SecretKey: 'mock-secret', SessionToken: 'mock-session',
        Expiration: new Date(Date.now() + 3600_000),
      } };
    }
    destroy() {}
  }
  async function synthetic(exports) {
    const module = new vm.SyntheticModule(Object.keys(exports), function () {
      for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
    }, { context });
    await module.link(() => { throw new Error('Unexpected dependency import'); });
    await module.evaluate();
    return module;
  }
  const mocks = {
    '@aws-sdk/client-cognito-identity': { CognitoIdentityClient, GetIdCommand, GetCredentialsForIdentityCommand },
    mqtt: { connect(url, options) {
      state.signedUrl = new URL(url);
      const broker = state.broker = new EventEmitter();
      Object.assign(broker, { options, connected: false, sent: [], ends: 0 });
      broker.publish = (topic, payload, publishOptions, callback) => {
        broker.sent.push({ topic, payload, options: publishOptions });
        if (!holdPublish) setImmediate(() => callback());
      };
      broker.end = () => { broker.ends++; broker.connected = false; };
      setImmediate(() => {
        if (connectError) return broker.emit('error', connectError);
        broker.connected = true;
        broker.emit('connect');
      });
      return broker;
    } },
  };
  const module = new vm.SourceTextModule(source, {
    context,
    importModuleDynamically(name) {
      assert.ok(Object.hasOwn(mocks, name), 'Only mocked dependencies may load');
      return synthetic(mocks[name]);
    },
  });
  await module.link(name => {
    assert.equal(name, 'node:crypto');
    return synthetic({ createHash: crypto.createHash, createHmac: crypto.createHmac, randomUUID: crypto.randomUUID });
  });
  await module.evaluate();
  return { api: module.namespace, state, calls };
}

test('import and invalid assignment never obtain credentials', async () => {
  const { api, calls } = await harness();
  assert.equal(calls.length, 0);
  await assert.rejects(api.openResidentMqtt({ ...scope, idToken, hubId: 'another-hub' }), /INVALID_ASSIGNED_HUB/);
  await assert.rejects(api.openResidentMqtt({ ...scope, idToken, assignedThingName: '#' }), /INVALID_ASSIGNED_THERMOSTAT/);
  await assert.rejects(api.openResidentMqtt({ ...scope, idToken: 'malformed' }), /INVALID_ID_TOKEN/);
  assert.equal(calls.length, 0);
});

test('authenticated publish stays on the assigned thing and uses resident sub', async t => {
  const { api, calls, state } = await harness();
  const connection = await api.openResidentMqtt({ ...scope, idToken, appUserId: 123 });
  t.after(() => connection.close());
  assert.equal(calls.length, 2);
  assert.equal(calls[0].input.IdentityPoolId, 'us-east-1:3f9745dc-006d-4ffd-8936-3bf6152e56ca');
  assert.equal(calls[1].input.Logins['cognito-idp.us-east-1.amazonaws.com/us-east-1_RccNji1RU'], idToken);
  assert.equal(state.signedUrl.hostname, 'a1fy3zdlj0kjrw-ats.iot.us-east-1.amazonaws.com');
  assert.equal(state.signedUrl.pathname, '/mqtt');
  assert.equal(state.signedUrl.searchParams.get('X-Amz-Security-Token'), 'mock-session');
  assert.equal(state.broker.options.reconnectPeriod, 0);
  await assert.rejects(connection.publishShadow('another-thing', { tt: 24 }), /UNASSIGNED_THERMOSTAT/);
  await assert.rejects(connection.publishShadow(scope.assignedThingName, { unknown: 24 }), /UNSUPPORTED_FIELD/);
  await assert.rejects(connection.publishShadow(scope.assignedThingName, { htt: 25, ctt: 24 }), /INVALID_HEAT_COOL_ORDER/);
  assert.equal(state.broker.sent.length, 0);
  const result = await connection.publishShadow(scope.assignedThingName, { tt: 24.4, tm: 1 });
  assert.equal(result.brokerAcknowledged, true);
  assert.equal(result.deviceConfirmed, false);
  const message = state.broker.sent[0];
  assert.equal(message.topic, 'app/owned-hub/sh/$aws/things/owned-thermostat/shadow/update');
  assert.equal(message.options.retain, false);
  assert.deepEqual(JSON.parse(message.payload).state.desired, { tt: 24.4, tm: 1 });
  assert.match(JSON.parse(message.payload).clientToken, /^resident-sub:\d+$/);
});

test('closing rejects an outstanding publish and does not retry', async () => {
  const { api, state } = await harness({ holdPublish: true });
  const connection = await api.openResidentMqtt({ ...scope, idToken });
  const pending = connection.publishShadow(scope.assignedThingName, { tm: 0 });
  connection.close();
  connection.close();
  await assert.rejects(pending, /CONNECTION_CLOSED/);
  assert.equal(state.broker.ends, 1);
  assert.equal(state.broker.sent.length, 1);
  assert.equal(connection.connected, false);
  assert.equal(state.broker.options.path, undefined);
});

test('fan commands only permit documented Auto and On values', async t => {
  const { api, state } = await harness();
  const connection = await api.openResidentMqtt({ ...scope, idToken });
  t.after(() => connection.close());
  for (const value of [-1, 0.5, 2, 3, '1', null]) await assert.rejects(connection.publishShadow(scope.assignedThingName, { tf: value }));
  assert.equal(state.broker.sent.length, 0);
  await connection.publishShadow(scope.assignedThingName, { tf: 1 });
  await connection.publishShadow(scope.assignedThingName, { tf: 0 });
  assert.deepEqual(state.broker.sent.map(item => JSON.parse(item.payload).state.desired), [{ tf: 1 }, { tf: 0 }]);
});

test('connection probe publishes nothing and closes its connection', async () => {
  const { api, state } = await harness();
  const result = await api.probeResidentMqtt({ ...scope, idToken });
  assert.equal(result.connected, true);
  assert.equal(state.broker.sent.length, 0);
  assert.equal(state.broker.ends, 1);
  assert.equal(state.broker.connected, false);
});

test('credential and transport failures never expose raw errors', async () => {
  const secretMessage = 'sensitive signed URL or credential material';
  const first = await harness({ credentialError: new Error(secretMessage) });
  await assert.rejects(first.api.openResidentMqtt({ ...scope, idToken }), error => {
    assert.match(error.message, /CREDENTIALS_FAILED/);
    assert.equal(JSON.stringify(error).includes(secretMessage), false);
    return true;
  });
  const second = await harness({ connectError: Object.assign(new Error(secretMessage), { code: 5 }) });
  await assert.rejects(second.api.openResidentMqtt({ ...scope, idToken }), error => {
    assert.match(error.message, /MQTT_CODE_5/);
    assert.equal(JSON.stringify(error).includes(secretMessage), false);
    return true;
  });
});
