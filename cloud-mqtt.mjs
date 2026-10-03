import { createHash, createHmac, randomUUID } from 'node:crypto';

const REGION = 'us-east-1';
const USER_POOL = 'us-east-1_RccNji1RU';
const APP_CLIENT = '8p7a56ejp870vo59r8bdhsn0i';
const IDENTITY_POOL = 'us-east-1:3f9745dc-006d-4ffd-8936-3bf6152e56ca';
const IOT_HOST = 'a1fy3zdlj0kjrw-ats.iot.us-east-1.amazonaws.com';
const LOGIN_PROVIDER = `cognito-idp.${REGION}.amazonaws.com/${USER_POOL}`;
const CONNECT_TIMEOUT_MS = 20_000;
const PUBLISH_TIMEOUT_MS = 10_000;

function failure(stage, code = 'FAILED') {
  const error = new Error(`${stage}: ${code}`);
  error.diagnostic = { stage, code };
  return error;
}

function authFailure(cause) {
  const code = ['NotAuthorizedException', 'ResourceNotFoundException', 'TooManyRequestsException',
    'InvalidIdentityPoolConfigurationException', 'InvalidParameterException', 'AbortError', 'TimeoutError']
    .includes(cause?.name) ? cause.name : 'CREDENTIALS_FAILED';
  return failure('Cloud MQTT authentication', code);
}

function validateSession({ idToken, hubId, assignedHubId, assignedThingName, residentUserId }) {
  // Both assigned values must come from the authenticated profile/device response.
  if (typeof hubId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(hubId) || hubId !== assignedHubId) {
    throw failure('Cloud MQTT scope', 'INVALID_ASSIGNED_HUB');
  }
  if (typeof assignedThingName !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(assignedThingName)) {
    throw failure('Cloud MQTT scope', 'INVALID_ASSIGNED_THERMOSTAT');
  }
  let claims;
  try {
    if (typeof idToken !== 'string' || idToken.length > 20_000 || idToken.split('.').length !== 3) throw new Error();
    claims = JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString('utf8'));
  } catch {
    throw failure('Cloud MQTT authentication', 'INVALID_ID_TOKEN');
  }
  // This checks routing and expiry only. Cognito verifies the JWT signature remotely.
  if (claims.iss !== `https://${LOGIN_PROVIDER}` || claims.aud !== APP_CLIENT || claims.token_use !== 'id') {
    throw failure('Cloud MQTT authentication', 'WRONG_ID_TOKEN');
  }
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= Date.now()) {
    throw failure('Cloud MQTT authentication', 'ID_TOKEN_EXPIRED');
  }
  // Sign-in starts with userId=attributes.sub, then merges the resident profile.
  // A profile.appUserId is a different field and must not replace that userId.
  const userId = residentUserId ?? claims.sub;
  if (!['string', 'number'].includes(typeof userId) || !/^[A-Za-z0-9_-]{1,100}$/.test(String(userId))) {
    throw failure('Cloud MQTT scope', 'INVALID_RESIDENT_USER');
  }
  return String(userId);
}

const sha256 = value => createHash('sha256').update(value).digest('hex');
const hmac = (key, value) => createHmac('sha256', key).update(value).digest();
const encode = value => encodeURIComponent(value).replace(/[!'()*]/g, character =>
  `%${character.charCodeAt(0).toString(16).toUpperCase()}`);

function websocketUrl(credentials) {
  const amzDate = new Date().toISOString().replace(/[:-]|\.\d{3}/g, '');
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${REGION}/iotdevicegateway/aws4_request`;
  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${credentials.AccessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': '900',
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.keys(query).sort().map(key => `${encode(key)}=${encode(query[key])}`).join('&');
  const canonicalRequest = ['GET', '/mqtt', canonicalQuery, `host:${IOT_HOST}\n`, 'host', sha256('')].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${credentials.SecretKey}`, date), REGION), 'iotdevicegateway'), 'aws4_request');
  const signature = hmac(signingKey, stringToSign).toString('hex');
  // The resident app's Amplify signer appends the session token AFTER signing for IoT.
  return `wss://${IOT_HOST}/mqtt?${canonicalQuery}&X-Amz-Signature=${signature}&X-Amz-Security-Token=${encode(credentials.SessionToken)}`;
}

function validateDesired(desired) {
  if (!desired || Object.getPrototypeOf(desired) !== Object.prototype || !Object.keys(desired).length) {
    throw failure('Thermostat command', 'INVALID_DESIRED_STATE');
  }
  for (const [key, value] of Object.entries(desired)) {
    if (!['tm', 'tt', 'htt', 'ctt', 'tf'].includes(key) || !Number.isFinite(value)) {
      throw failure('Thermostat command', 'UNSUPPORTED_FIELD');
    }
    if (key === 'tm' ? ![0, 1, 2, 4].includes(value) : key === 'tf' ? ![0, 1].includes(value) : value < 5 || value > 35) {
      throw failure('Thermostat command', 'VALUE_OUT_OF_RANGE');
    }
  }
  if (desired.htt !== undefined && desired.ctt !== undefined && desired.htt >= desired.ctt) {
    throw failure('Thermostat command', 'INVALID_HEAT_COOL_ORDER');
  }
}

/**
 * Connect using the resident's existing permissions. No access-policy API is called.
 * Importing this module never opens a connection. Credentials remain in memory.
 * assignedHubId/assignedThingName must be supplied by the server from vendor reads,
 * never from a browser request. The caller must apply the device's actual limits.
 */
export async function openResidentMqtt(options) {
  const userId = validateSession(options);
  const { hubId, assignedThingName } = options;
  let idToken = options.idToken;
  const { CognitoIdentityClient, GetIdCommand, GetCredentialsForIdentityCommand } =
    await import('@aws-sdk/client-cognito-identity');
  const { connect } = await import('mqtt');
  const identity = new CognitoIdentityClient({ region: REGION, maxAttempts: 1 });
  let credentials;
  try {
    const Logins = { [LOGIN_PROVIDER]: idToken };
    const result = await identity.send(new GetIdCommand({ IdentityPoolId: IDENTITY_POOL, Logins }),
      { abortSignal: AbortSignal.timeout(15_000) });
    if (!result.IdentityId) throw new Error();
    const response = await identity.send(new GetCredentialsForIdentityCommand({ IdentityId: result.IdentityId, Logins }),
      { abortSignal: AbortSignal.timeout(15_000) });
    credentials = response.Credentials;
    if (!credentials?.AccessKeyId || !credentials.SecretKey || !credentials.SessionToken) throw new Error();
  } catch (cause) {
    throw authFailure(cause);
  } finally {
    idToken = undefined;
    identity.destroy();
  }

  const expiresAt = new Date(credentials.Expiration).getTime();
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now() + 60_000) {
    credentials = undefined;
    throw failure('Cloud MQTT authentication', 'CREDENTIALS_EXPIRED');
  }
  let signedUrl = websocketUrl(credentials);
  credentials = undefined;
  let client;
  try {
    client = connect(signedUrl, {
      protocolVersion: 4,
      clientId: `temperme-${randomUUID()}`,
      clean: true,
      keepalive: 30,
      reconnectPeriod: 0,
      resubscribe: false,
      queueQoSZero: false,
      connectTimeout: CONNECT_TIMEOUT_MS,
      wsOptions: { handshakeTimeout: CONNECT_TIMEOUT_MS, followRedirects: false },
    });
  } catch {
    throw failure('Cloud MQTT connection', 'CONNECT_FAILED');
  } finally {
    signedUrl = undefined;
  }

  let closed = false;
  let closeCode = 'CONNECTION_CLOSED';
  let expiryTimer;
  const pending = new Set();
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(expiryTimer);
    for (const cancel of [...pending]) cancel();
    client.end(true);
    // MQTT.js retains parsed connection options. Remove signed query material after close.
    for (const key of ['href', 'query', 'search', 'path']) delete client.options[key];
  };
  // Never surface the library error object, which can contain the signed URL.
  client.on('error', error => {
    if (Number.isInteger(error?.code) && error.code >= 0 && error.code <= 255) {
      closeCode = `MQTT_CODE_${error.code}`;
    } else if (['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN',
      'CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'].includes(error?.code)) {
      closeCode = error.code;
    }
    close();
  });
  client.on('close', () => close());
  try {
    await new Promise((resolve, reject) => {
      const cancel = () => finish(failure('Cloud MQTT connection', closeCode));
      const connected = () => finish();
      const timer = setTimeout(() => {
        finish(failure('Cloud MQTT connection', 'CONNECTION_TIMEOUT'));
        close();
      }, CONNECT_TIMEOUT_MS);
      function finish(error) {
        clearTimeout(timer);
        pending.delete(cancel);
        client.removeListener('connect', connected);
        if (error) reject(error); else resolve();
      }
      pending.add(cancel);
      client.once('connect', connected);
      if (closed) cancel();
    });
  } catch (error) {
    close();
    throw error;
  }
  expiryTimer = setTimeout(close, Math.min(expiresAt - Date.now() - 30_000, 60 * 60 * 1000));
  expiryTimer.unref();
  let lastClientTime = 0;

  return {
    get connected() { return !closed && client.connected; },
    expiresAt: new Date(expiresAt).toISOString(),
    async publishShadow(thingName, desired) {
      if (thingName !== assignedThingName) throw failure('Cloud MQTT scope', 'UNASSIGNED_THERMOSTAT');
      validateDesired(desired);
      if (closed || !client.connected) throw failure('Thermostat command', 'CONNECTION_CLOSED');
      const topic = `app/${hubId}/sh/$aws/things/${assignedThingName}/shadow/update`;
      lastClientTime = Math.max(Date.now(), lastClientTime + 1);
      const payload = JSON.stringify({ state: { desired }, clientToken: `${userId}:${lastClientTime}` });
      await new Promise((resolve, reject) => {
        let settled = false;
        const cancel = () => finish(failure('Thermostat command', 'CONNECTION_CLOSED'));
        const timer = setTimeout(() => {
          finish(failure('Thermostat command', 'PUBLISH_TIMEOUT'));
          close();
        }, PUBLISH_TIMEOUT_MS);
        function finish(error) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          pending.delete(cancel);
          if (error) reject(error); else resolve();
        }
        pending.add(cancel);
        try {
          client.publish(topic, payload, { qos: 1, retain: false }, error =>
            finish(error ? failure('Thermostat command', 'PUBLISH_FAILED') : undefined));
        } catch {
          finish(failure('Thermostat command', 'PUBLISH_FAILED'));
          close();
        }
      });
      // PUBACK confirms the broker received the command, not that the HVAC changed.
      return { brokerAcknowledged: true, deviceConfirmed: false };
    },
    close,
  };
}

export async function probeResidentMqtt(options) {
  const connection = await openResidentMqtt(options);
  try {
    return { connected: connection.connected, expiresAt: connection.expiresAt };
  } finally {
    connection.close();
  }
}
