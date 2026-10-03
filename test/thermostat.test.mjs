import test from 'node:test';
import assert from 'node:assert/strict';
import { desiredSettings, findThermostat, mapThermostat, commandSequence } from '../iapartments.mjs';

const reported = {
  ct: 24.7, tm: 1, tt: 24.4, htt: 23.9, ctt: 26.1,
  tt_min: 10, tt_max: 32.2, tf: 0,
};

function device(overrides = {}, state = reported) {
  return {
    deviceType: 'Thermostat', nodeId: '', HubType: 'Gen1',
    thingName: 'TEST_ASSIGNED_THERMOSTAT',
    shadowPayload: JSON.stringify({ state: { reported: state } }),
    ...overrides,
  };
}

function details(devices = [device()], overrides = {}) {
  return { HubId: 'TEST_ASSIGNED_HUB', HubType: 'Gen1', DeviceDetailList: devices, ...overrides };
}

function rejectsSettings(input, pattern = /./, readings = reported) {
  assert.throws(() => desiredSettings(input, readings), error => {
    assert.match(error.userMessage, pattern);
    assert.equal(error.message, error.userMessage);
    return true;
  });
}

test('Gen1 scalar readings normalize to the resident app Fahrenheit display', () => {
  const result = mapThermostat(details());
  assert.deepEqual({
    current: result.currentTemperature, target: result.targetTemperature,
    heat: result.heatTarget, cool: result.coolTarget,
    minimum: result.minimumTemperature, maximum: result.maximumTemperature,
    mode: result.mode, fan: result.fan, unit: result.unit,
  }, {
    current: 76, target: 76, heat: 75, cool: 79,
    minimum: 50, maximum: 90, mode: 'cool', fan: 'Auto', unit: 'F',
  });
  assert.equal(result.canControl, false, 'Mapping alone must not authorize a cloud command');
  assert.ok(Number.isFinite(Date.parse(result.updatedAt)));
});

test('absent optional readings stay absent instead of becoming zero', () => {
  const result = mapThermostat(details([device({}, { ct: 20, tm: 0 })]));
  assert.equal(result.mode, 'off');
  for (const key of ['targetTemperature', 'heatTarget', 'coolTarget', 'minimumTemperature', 'maximumTemperature', 'fan']) {
    assert.equal(result[key], null, key);
  }
});

test('mapped modes preserve Emergency Heat without allowing it as a command', () => {
  for (const [tm, expected] of [[0, 'off'], [1, 'cool'], [2, 'heat'], [3, 'emergency_heat'], [4, 'heat_cool'], [99, 'unknown']]) {
    assert.equal(mapThermostat(details([device({}, { ...reported, tm })])).mode, expected);
  }
  rejectsSettings({ mode: 'emergency_heat', targetTemperature: 76 }, /Choose Off/);
});

test('only the unique built-in thermostat can be selected', () => {
  const builtIn = device();
  assert.equal(findThermostat(details([
    device({ nodeId: 'zwave-node-7' }), { deviceType: 'Lock' }, builtIn,
  ])).device, builtIn);
  for (const response of [
    null, {}, details([]), details([device({ nodeId: 'zwave-node-7' })]),
    details([device(), device({ thingName: 'SECOND_THERMOSTAT' })]),
  ]) assert.equal(findThermostat(response), null);
});

test('Gen2 devices and Gen2 hubs are rejected before Gen1 normalization', () => {
  for (const response of [
    details([device({ HubType: 'Gen2' })]),
    details([device()], { HubType: 'Gen2' }),
  ]) {
    assert.equal(findThermostat(response), null);
    assert.equal(mapThermostat(response), null);
  }
});

test('an unknown or missing generation cannot authorize the Gen1 protocol', () => {
  for (const generation of [undefined, null, '', 'Gen3', 'gen1', 1]) {
    const response = details([device({ HubType: generation })], { HubType: generation });
    assert.equal(findThermostat(response), null);
  }
});

test('malformed and nonnumeric required shadow readings are rejected', () => {
  for (const shadowPayload of [
    '', 'not json', 'null', '{}', '{"state":{"desired":{"ct":20,"tm":1}}}',
    '{"state":{"reported":{"ct":"24.7","tm":1}}}',
    '{"state":{"reported":{"ct":24.7,"tm":"1"}}}',
    '{"state":{"reported":{"ct":{"value":24.7},"tm":1}}}',
    '{"state":{"reported":{"ct":null,"tm":1}}}',
  ]) assert.equal(findThermostat(details([device({ shadowPayload })])), null, shadowPayload);
});

test('nonfinite JSON numbers cannot make a thermostat eligible for control', () => {
  for (const shadowPayload of [
    '{"state":{"reported":{"ct":1e400,"tm":1}}}',
    '{"state":{"reported":{"ct":24.7,"tm":-1e400}}}',
  ]) assert.equal(findThermostat(details([device({ shadowPayload })])), null);
});

test('mode and targets normalize into only verified Gen1 command fields', () => {
  assert.deepEqual(desiredSettings({ mode: 'off' }, reported), { tm: 0, tf: 0 });
  assert.deepEqual(desiredSettings({ mode: 'cool', targetTemperature: 76 }, reported), { tm: 1, tt: 24.4 });
  assert.deepEqual(desiredSettings({ mode: 'heat', targetTemperature: 75 }, reported), { tm: 2, tt: 23.9 });
  assert.deepEqual(desiredSettings({ mode: 'heat_cool', heatTarget: 75, coolTarget: 79 }, reported), { tm: 4, htt: 23.9, ctt: 26.1 });
});

test('actual reported 50-90 Fahrenheit bounds include both endpoints', () => {
  for (const mode of ['cool', 'heat']) {
    assert.equal(desiredSettings({ mode, targetTemperature: 50 }, reported).tt, 10);
    assert.equal(desiredSettings({ mode, targetTemperature: 90 }, reported).tt, 32.2);
    rejectsSettings({ mode, targetTemperature: 49 }, /between 50 and 90/);
    rejectsSettings({ mode, targetTemperature: 91 }, /between 50 and 90/);
  }
  assert.deepEqual(desiredSettings({ mode: 'heat_cool', heatTarget: 50, coolTarget: 90 }, reported), { tm: 4, htt: 10, ctt: 32.2 });
  rejectsSettings({ mode: 'heat_cool', heatTarget: 49, coolTarget: 79 }, /between 50 and 90/);
  rejectsSettings({ mode: 'heat_cool', heatTarget: 75, coolTarget: 91 }, /between 50 and 90/);
});

test('HeatCool requires at least 3 Fahrenheit degrees and rounds each Celsius target independently', () => {
  assert.deepEqual(desiredSettings({ mode: 'heat_cool', heatTarget: 73, coolTarget: 76 }, reported), { tm: 4, htt: 22.8, ctt: 24.4 });
  for (const coolTarget of [75, 74, 73, 72]) {
    rejectsSettings({ mode: 'heat_cool', heatTarget: 73, coolTarget }, /at least 3 degrees/);
  }
});

test('temperature input requires whole numeric Fahrenheit degrees', () => {
  for (const value of [undefined, null, '76', true, 76.5, NaN, Infinity, -Infinity]) {
    rejectsSettings({ mode: 'cool', targetTemperature: value }, /whole degrees/);
    rejectsSettings({ mode: 'heat_cool', heatTarget: value, coolTarget: 79 }, /whole degrees/);
    rejectsSettings({ mode: 'heat_cool', heatTarget: 73, coolTarget: value }, /whole degrees/);
  }
});

test('omitted device limits use conservative 50-90 Fahrenheit service bounds', () => {
  for (const bounds of [{}, { tt_min: null, tt_max: null }, { tt_min: NaN, tt_max: Infinity }]) {
    assert.equal(desiredSettings({ mode: 'cool', targetTemperature: 50 }, bounds).tt, 10);
    assert.equal(desiredSettings({ mode: 'cool', targetTemperature: 90 }, bounds).tt, 32.2);
    rejectsSettings({ mode: 'cool', targetTemperature: 49 }, /between 50 and 90/, bounds);
    rejectsSettings({ mode: 'cool', targetTemperature: 91 }, /between 50 and 90/, bounds);
  }
});

test('invalid modes, raw protocol fields, fan settings and cross-mode inputs are rejected', () => {
  for (const mode of ['auto', 'emergency_heat', 'Heat', 1, null, 'constructor', '__proto__']) {
    rejectsSettings({ mode, targetTemperature: 76 }, /Choose Off/);
  }
  for (const input of [
    { mode: 'cool', targetTemperature: 76, tm: 1 },
    { mode: 'cool', targetTemperature: 76, tt: 24.4 },
    { mode: 'cool', targetTemperature: 76, hvac_test_en: 1 },
    { mode: 'cool', targetTemperature: 76, thingName: 'OTHER_DEVICE' },
    { mode: 'cool', targetTemperature: 76, hubId: 'OTHER_HUB' },
    { mode: 'off', targetTemperature: 76 },
    { mode: 'heat', targetTemperature: 76, heatTarget: 75 },
    { mode: 'heat_cool', heatTarget: 75, coolTarget: 79, targetTemperature: 76 },
    JSON.parse('{"mode":"off","__proto__":{"tm":1}}'),
  ]) rejectsSettings(input, /unsupported settings/);
});

test('fan only stops heating and cooling, then enables fan without changing temperatures', () => {
  const result = commandSequence({ mode: 'fan_only' }, { ...reported, tm: 2, tf: 0 });
  assert.deepEqual(result, { desired: { tm: 0, tf: 1 }, commands: [{ tm: 0 }, { tf: 1 }] });
  const state = mapThermostat(details([device({}, { ...reported, tm: 0, tf: 1, cf: 1, cs: 0 })]));
  assert.equal(state.mode, 'fan_only');
  assert.equal(state.fanMode, 'on');
  assert.equal(state.fanRunning, true);
  assert.equal(state.activity, 'off');
});

test('Off removes fan-only operation while normal climate commands preserve fan unless specified', () => {
  assert.deepEqual(commandSequence({ mode: 'off' }, { ...reported, tm: 0, tf: 1 }).commands, [{ tf: 0 }]);
  assert.deepEqual(desiredSettings({ mode: 'cool', targetTemperature: 76 }, reported), { tm: 1, tt: 24.4 });
  assert.deepEqual(desiredSettings({ mode: 'cool', targetTemperature: 76, fan: 'auto' }, reported), { tm: 1, tt: 24.4, tf: 0 });
  assert.deepEqual(desiredSettings({ mode: 'cool', targetTemperature: 76, fan: 'on' }, reported), { tm: 1, tt: 24.4, tf: 1 });
});

test('fan settings validate independently and fan-only cannot carry hidden targets', () => {
  for (const fan of ['On', 'circulate', 'off', 1, null, false]) rejectsSettings({ mode: 'cool', targetTemperature: 76, fan }, /Auto or On/);
  rejectsSettings({ mode: 'fan_only', targetTemperature: 76 }, /unsupported settings/);
  rejectsSettings({ mode: 'fan_only', fan: 'auto' }, /unsupported settings/);
  rejectsSettings({ mode: 'off', fan: 'on' }, /unsupported settings/);
});

test('mode transitions reapply an explicit target and fan, even if old reported values match', () => {
  assert.deepEqual(commandSequence({ mode: 'heat', targetTemperature: 76, fan: 'auto' }, reported).commands, [{ tm: 2 }, { tt: 24.4 }, { tf: 0 }]);
  assert.deepEqual(commandSequence({ mode: 'fan_only' }, { ...reported, tf: 1 }).commands, [{ tm: 0 }, { tf: 1 }]);
  assert.deepEqual(commandSequence({ mode: 'fan_only' }, { ...reported, tm: 0, tf: 1 }).commands, []);
});

test('missing or unknown physical fan activity is not shown as off', () => {
  assert.equal(mapThermostat(details()).fanRunning, null);
  assert.equal(mapThermostat(details([device({}, { ...reported, cf: 0 })])).fanRunning, false);
  assert.equal(mapThermostat(details([device({}, { ...reported, cf: 3 })])).fanRunning, null);
});

test('normalization does not mutate requested settings or reported state', () => {
  const input = Object.freeze({ mode: 'heat_cool', heatTarget: 75, coolTarget: 79 });
  const readings = Object.freeze({ ...reported });
  desiredSettings(input, readings);
  assert.deepEqual(input, { mode: 'heat_cool', heatTarget: 75, coolTarget: 79 });
  assert.deepEqual(readings, reported);
});
