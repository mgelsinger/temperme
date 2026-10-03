// Resident app 2.991.8 uses these endpoints. They are private vendor APIs.
const cloudUrl = new URL('./cloud-mqtt.mjs', import.meta.url);
cloudUrl.search = new URL(import.meta.url).search;
const { probeResidentMqtt, openResidentMqtt } = await import(cloudUrl.href);

const capabilities = new WeakMap();
const pendingCommands = new Map();
const commandLocks = new Set();
const modeValues = { off: 0, fan_only: 0, cool: 1, heat: 2, heat_cool: 4 };
const toCelsius = value => Math.round((value - 32) * 5 / 9 * 10) / 10;
const matches = (reported, desired) => Object.entries(desired).every(([key, value]) => typeof reported[key] === 'number' && Math.abs(reported[key] - value) < 0.11);

async function readJson(stage, url, idToken, body, bearer = false) {
  let response;
  let text;
  try {
    response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: bearer ? `Bearer ${idToken}` : idToken, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(45000),
    });
    text = await response.text();
  } catch (cause) {
    const code = cause?.name === 'TimeoutError' ? 'TIMEOUT' : cause?.cause?.code;
    const error = new Error(`${stage}: network request failed`);
    error.diagnostic = { stage, kind: 'network', code: typeof code === 'string' && /^[A-Z_0-9]+$/.test(code) ? code : 'UNKNOWN' };
    throw error;
  }
  const diagnostic = { stage, status: response.status, contentType: response.headers.get('content-type')?.split(';')[0], bytes: Buffer.byteLength(text) };
  if (!response.ok) {
    const error = new Error(`${stage}: HTTP ${response.status}`);
    error.diagnostic = { ...diagnostic, kind: 'http' };
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error(`${stage}: response was ${text.trim() ? 'not JSON' : 'empty'}`);
    error.diagnostic = { ...diagnostic, kind: text.trim() ? 'invalid_json' : 'empty' };
    throw error;
  }
}

export async function getResidentProfile(idToken) {
  return readJson('Profile read', 'https://webm.api.iapts.com/secure/api/user/get-info', idToken);
}

export async function getResidentDevices(idToken) {
  return readJson('Device listing', 'https://webm.api.iapts.com/secure/api/devices', idToken, undefined, true);
}

async function readDeviceDetails(idToken, hubId, zipcode = '') {
  if (typeof hubId !== 'string' || !hubId || hubId.length > 256) throw new Error('Invalid assigned hub ID');
  const details = await readJson('Device details', 'https://slsm.api.iapts.com/app/device_detail/get', idToken,
    { HubId: hubId, IncludeWeatherData: false, Zipcode: typeof zipcode === 'string' ? zipcode : '', IncludeHub: true });
  if (details?.Error === true || details?.HubId !== hubId) throw new Error('Assigned-device response was not valid');
  return details;
}

export async function getResidentDeviceDetails(idToken, hubId, zipcode = '') {
  const details = await readDeviceDetails(idToken, hubId, zipcode);
  const found = findThermostat(details);
  if (found) {
    try {
      const profile = await getResidentProfile(idToken);
      await probeResidentMqtt({ idToken, hubId, assignedHubId: profile.hubId, assignedThingName: found.device.thingName, residentUserId: profile.userId });
      let controlMessage;
      const pending = pendingCommands.get(hubId);
      if (pending) {
        if (matches(found.reported, pending.desired)) {
          controlMessage = pending.unchanged ? 'The thermostat already has these settings.' : 'Settings confirmed by the thermostat.';
          pendingCommands.delete(hubId);
        } else {
          controlMessage = pending.failed ? 'The command did not finish. Some settings may have changed; review the readings before trying again.' : 'Command sent. The thermostat has not yet reported the requested settings. Refresh readings shortly.';
          if (Date.now() - pending.sentAt > 120000) {
            controlMessage = 'The thermostat has not confirmed the last command. Check its wall display before trying again.';
            pendingCommands.delete(hubId);
          }
        }
      }
      capabilities.set(details, { canControl: true, controlMessage });
    } catch {
      capabilities.set(details, { canControl: false, controlMessage: 'Thermostat readings are available, but the cloud control connection could not be verified.' });
    }
  }
  return details;
}

export function findThermostat(details) {
  const devices = Array.isArray(details?.DeviceDetailList) ? details.DeviceDetailList : details?.Rooms?.[0]?.DeviceList;
  if (!Array.isArray(devices)) return null;
  const candidates = devices.filter(device => device?.deviceType === 'Thermostat' && !device.nodeId);
  if (candidates.length !== 1) return null;
  const device = candidates[0];
  const generations = [device.HubType, details.HubType].filter(value => value != null && value !== '');
  if (!generations.length || generations.some(value => value !== 'Gen1')) return null;
  let shadow;
  try { shadow = JSON.parse(device.shadowPayload); } catch { return null; }
  const reported = shadow?.state?.reported;
  if (!reported || typeof reported !== 'object' || !Number.isFinite(reported.ct) || !Number.isFinite(reported.tm)) return null;
  return { device, reported };
}

export function mapThermostat(details) {
  const found = findThermostat(details);
  if (!found) return null;
  const { reported } = found;
  const fahrenheit = value => typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 9 / 5 + 32) : null;
  return {
    currentTemperature: fahrenheit(reported.ct),
    targetTemperature: fahrenheit(reported.tt),
    heatTarget: fahrenheit(reported.htt), coolTarget: fahrenheit(reported.ctt),
    mode: reported.tm === 0 && reported.tf === 1 ? 'fan_only' : ({ 0: 'off', 1: 'cool', 2: 'heat', 3: 'emergency_heat', 4: 'heat_cool' })[reported.tm] || 'unknown',
    fan: ({ 0: 'Auto', 1: 'On', 2: 'Circulate' })[reported.tf] || null,
    fanMode: ({ 0: 'auto', 1: 'on', 2: 'circulate' })[reported.tf] || null,
    fanRunning: reported.cf === 1 ? true : reported.cf === 0 ? false : null,
    activity: ({ 0: 'off', 1: 'cool', 2: 'heat' })[reported.cs] || null,
    unit: 'F', updatedAt: new Date().toISOString(),
    minimumTemperature: fahrenheit(reported.tt_min), maximumTemperature: fahrenheit(reported.tt_max),
    canControl: capabilities.get(details)?.canControl === true,
    controlMessage: capabilities.get(details)?.controlMessage,
  };
}

function inputError(message) {
  const error = new Error(message);
  error.userMessage = message;
  return error;
}

export function desiredSettings(input, reported) {
  if (!input || typeof input !== 'object' || !Object.hasOwn(modeValues, input.mode)) throw inputError('Choose Off, Fan only, Cool, Heat, or Heat & cool.');
  const noTemperature = input.mode === 'off' || input.mode === 'fan_only';
  const allowed = noTemperature ? ['mode'] : input.mode === 'heat_cool' ? ['mode', 'heatTarget', 'coolTarget', 'fan'] : ['mode', 'targetTemperature', 'fan'];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw inputError('The request contains unsupported settings.');
  const minimum = Number.isFinite(reported.tt_min) ? reported.tt_min : 10;
  const maximum = Number.isFinite(reported.tt_max) ? Math.min(reported.tt_max, 35) : 32.2;
  const temperature = value => {
    if (!Number.isInteger(value)) throw inputError('Use whole degrees Fahrenheit.');
    const celsius = toCelsius(value);
    if (celsius < minimum - 0.01 || celsius > maximum + 0.01) throw inputError(`Choose a temperature between ${Math.round(minimum * 9 / 5 + 32)} and ${Math.round(maximum * 9 / 5 + 32)} degrees Fahrenheit.`);
    return celsius;
  };
  const desired = { tm: modeValues[input.mode] };
  if (input.mode === 'fan_only') desired.tf = 1;
  else if (input.mode === 'off') desired.tf = 0;
  else if (Object.hasOwn(input, 'fan')) {
    if (!['auto', 'on'].includes(input.fan)) throw inputError('Choose Auto or On for the fan.');
    desired.tf = input.fan === 'on' ? 1 : 0;
  }
  if (input.mode === 'cool' || input.mode === 'heat') desired.tt = temperature(input.targetTemperature);
  if (input.mode === 'heat_cool') {
    desired.htt = temperature(input.heatTarget);
    desired.ctt = temperature(input.coolTarget);
    if (input.coolTarget - input.heatTarget < 3) throw inputError('Keep the cooling target at least 3 degrees above the heating target.');
  }
  return desired;
}

export function commandSequence(input, reported) {
  const desired = desiredSettings(input, reported);
  const modeChanges = reported.tm !== desired.tm;
  const commands = [];
  if (modeChanges) commands.push({ tm: desired.tm });
  if (desired.tt !== undefined && (modeChanges || !matches(reported, { tt: desired.tt }))) commands.push({ tt: desired.tt });
  if (desired.htt !== undefined) {
    const range = { htt: desired.htt, ctt: desired.ctt };
    if (modeChanges || !matches(reported, range)) commands.push(range);
  }
  // Apply the independent fan setting after the HVAC mode, without modifying targets.
  if (desired.tf !== undefined && (modeChanges || reported.tf !== desired.tf)) commands.push({ tf: desired.tf });
  return { desired, commands };
}

export async function setThermostat(session, input) {
  const hubId = session.profile?.hubId;
  if (!hubId || commandLocks.has(hubId)) throw inputError('A thermostat command is already running. Wait for it to finish.');
  commandLocks.add(hubId);
  try { return await applyThermostatSettings(session, input); }
  finally { commandLocks.delete(hubId); }
}

async function applyThermostatSettings(session, input) {
  const attempt = session.attempt;
  const tokens = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(inputError('Session refresh timed out. Refresh readings and try again.')), 30000);
    session.user.getSession((error, value) => { clearTimeout(timer); error ? reject(inputError('Your session could not be refreshed. Please sign in again.')) : resolve(value); });
  });
  if (session.attempt !== attempt || session.stage !== 'connected') throw inputError('The signed-in session changed.');
  session.tokens = tokens;
  const idToken = tokens.getIdToken().getJwtToken();
  const profile = await getResidentProfile(idToken);
  if (profile.hubId !== session.profile?.hubId) throw inputError('Your assigned thermostat changed. Sign in again before controlling it.');
  const details = await readDeviceDetails(idToken, profile.hubId, profile.zipcode);
  const found = findThermostat(details);
  if (!found) throw inputError('The assigned thermostat could not be verified.');
  const { desired, commands } = commandSequence(input, found.reported);
  if (matches(found.reported, desired)) {
    pendingCommands.set(profile.hubId, { desired, unchanged: true, sentAt: Date.now() });
    return { commandSent: false };
  }
  const connection = await openResidentMqtt({ idToken, hubId: profile.hubId, assignedHubId: profile.hubId, assignedThingName: found.device.thingName, residentUserId: profile.userId });
  const pending = { desired, sentAt: Date.now(), failed: false };
  try {
    if (session.attempt !== attempt || session.stage !== 'connected') throw inputError('The signed-in session changed.');
    pendingCommands.set(profile.hubId, pending);
    // Use the app's separate mode, setpoint, and fan messages in that order.
    for (const values of commands) {
      if (session.attempt !== attempt || session.stage !== 'connected') throw inputError('The signed-in session changed.');
      await connection.publishShadow(found.device.thingName, values);
    }
  } catch {
    pending.failed = true;
    throw inputError('The command could not be completed. Some settings may have changed. Refresh readings before trying again.');
  } finally {
    connection.close();
  }
  // The ordinary follow-up read reports confirmation only when state.reported matches.
  await new Promise(resolve => setTimeout(resolve, 1500));
  return { commandSent: true };
}
