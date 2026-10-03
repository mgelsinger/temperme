import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { AuthenticationDetails, CognitoUser, CognitoUserPool } from 'amazon-cognito-identity-js';
import { isLoopback, networkConfig, requestOrigin, sameOriginJson, sessionCookie } from './network-config.mjs';
import { createWeatherService, WeatherError } from './weather.mjs';

// Public client identifiers found in both iApartments' web client and resident app.
// These identify the vendor's authentication service, not an administrator account.
const POOL_ID = 'us-east-1_RccNji1RU';
const CLIENT_ID = '8p7a56ejp870vo59r8bdhsn0i';
const network = networkConfig();
const { port, bindHost } = network;
const sessions = new Map();
const MAX_SESSIONS = 256;
const signInAttempts = [];
const weather = createWeatherService();
const htmlPath = fileURLToPath(new URL('./public/index.html', import.meta.url));
const adapterUrl = new URL('./iapartments.mjs', import.meta.url);

// Reload adapter changes without discarding the resident's in-memory login.
async function adapter() {
  const info = await stat(adapterUrl);
  return import(`${adapterUrl.href}?v=${info.mtimeMs}`);
}

function newSession() {
  const storageData = new Map();
  const storage = {
    setItem(key, value) { storageData.set(key, value); return value; },
    getItem(key) { return storageData.get(key) ?? null; },
    removeItem(key) { storageData.delete(key); },
    clear() { storageData.clear(); },
  };
  return { stage: 'signed_out', storage, storageData, lastSeen: Date.now(), attempt: 0, attempts: [] };
}

function sessionFor(req, res) {
  const id = /(?:^|;\s*)temperme_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
  if (id && sessions.has(id)) {
    const session = sessions.get(id);
    session.lastSeen = Date.now();
    return session;
  }
  const newId = randomBytes(32).toString('hex');
  const session = newSession();
  // Bound memory even when a LAN visitor repeatedly discards their cookie.
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions].sort((a, b) => a[1].lastSeen - b[1].lastSeen)[0];
    reset(oldest[1]);
    sessions.delete(oldest[0]);
  }
  sessions.set(newId, session);
  res.setHeader('Set-Cookie', sessionCookie(newId, network));
  return session;
}

function reset(session) {
  session.attempt++;
  session.cancelAuth?.();
  session.cancelAuth = null;
  session.busy = false;
  session.storage.clear();
  session.stage = 'signed_out';
  session.user = null;
  session.tokens = null;
  session.email = null;
  session.challenge = null;
  session.deviceListing = null;
  session.profile = null;
  session.deviceDetails = null;
  session.discoveryMessage = null;
  session.thermostat = null;
  session.readState = 'unavailable';
  session.lastReadAt = null;
}

function status(session) {
  if (session.stage === 'connected') {
    return {
      stage: 'connected', account: { email: session.email }, thermostat: session.thermostat || null,
      readState: session.readState || 'unavailable', lastReadAt: session.lastReadAt || null,
      message: session.discoveryMessage || 'Sign-in verified. Waiting for thermostat readings.',
    };
  }
  return { stage: session.stage, challenge: session.challenge || undefined, thermostat: null };
}

function clearConfirmation(session, message) {
  if (session.thermostat) session.thermostat = { ...session.thermostat, controlMessage: undefined };
  session.discoveryMessage = message;
}

function invalidateRead(session, message) {
  clearConfirmation(session, message);
  session.readState = session.thermostat ? 'stale' : 'unavailable';
  if (session.thermostat) session.thermostat.canControl = false;
}

async function discover(session, { commandSent = false } = {}) {
  const attempt = session.attempt;
  const active = () => attempt === session.attempt && session.stage === 'connected';
  if (!active()) return;
  clearConfirmation(session, commandSent ? 'Command sent. Checking thermostat readings.' : 'Refreshing thermostat readings.');
  try {
    const api = await adapter();
    if (!active()) return;
    // Cognito refreshes expired sessions using the in-memory refresh token.
    const tokens = await new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('Session refresh timed out')), 30000);
      session.user.getSession((error, value) => {
        clearTimeout(deadline);
        error ? reject(error) : resolve(value);
      });
    });
    if (!active()) return;
    session.tokens = tokens;
    const idToken = session.tokens.getIdToken().getJwtToken();
    const profile = session.profile || await api.getResidentProfile(idToken);
    if (!active()) return;
    session.profile = profile;
    if (typeof profile.hubId !== 'string' || !profile.hubId) {
      const error = new Error('Missing assigned hub');
      error.diagnostic = { kind: 'missing_hub' };
      throw error;
    }
    const details = await api.getResidentDeviceDetails(idToken, profile.hubId, profile.zipcode);
    if (!active()) return;
    session.deviceDetails = details;
    const thermostat = api.mapThermostat(details);
    if (!thermostat) {
      const error = new Error('Unsupported thermostat readings');
      error.diagnostic = { kind: 'unsupported_readings' };
      throw error;
    }
    session.thermostat = thermostat;
    session.readState = 'fresh';
    session.lastReadAt = thermostat.updatedAt;
    session.discoveryMessage = thermostat.controlMessage || (commandSent ? 'Command sent. Readings received, but the requested settings have not been confirmed yet. Refresh readings shortly.' : 'Thermostat readings received.');
  } catch (error) {
    if (!active()) return;
    const detail = error.diagnostic;
    const reason = detail?.kind === 'empty' ? 'the device service returned an empty response' : detail?.kind === 'invalid_json' ? 'the device service returned an unexpected response format' : detail?.code === 'TIMEOUT' ? 'the device service did not respond within 45 seconds' : detail?.kind === 'http' ? `the device service returned HTTP ${detail.status}` : detail?.kind === 'missing_hub' ? 'this resident profile did not identify an assigned thermostat hub' : detail?.kind === 'unsupported_readings' ? 'the assigned-device read did not include supported thermostat readings' : 'the device read failed';
    const outcome = commandSent ? `Command sent, but ${reason}. The requested settings could not be confirmed.` : `Could not refresh thermostat readings because ${reason}.`;
    invalidateRead(session, `${outcome} ${session.thermostat ? 'Displayed readings are from the last successful read. ' : ''}Use Refresh readings before sending another command.`);
  }
}

function send(res, code, value) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

function authError(error) {
  const messages = {
    NotAuthorizedException: 'Sign-in was not accepted. Check your iApartments email and password.',
    UserNotFoundException: 'Sign-in was not accepted. Check your iApartments email and password.',
    UserNotConfirmedException: 'Your iApartments account needs activation before it can sign in.',
    PasswordResetRequiredException: 'iApartments requires a password reset through its official account flow.',
    TooManyRequestsException: 'iApartments has temporarily limited sign-in attempts. Please try later.',
    CodeMismatchException: 'That verification code was not accepted. Please try again.',
    ExpiredCodeException: 'The verification code expired. Please sign in again.',
  };
  return messages[error?.code || error?.name] || 'Could not complete iApartments sign-in. No thermostat changes were made.';
}

function authenticate(session, start) {
  const attempt = session.attempt;
  return new Promise((resolve, reject) => {
    let finished = false;
    session.cancelAuth = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      reject(new Error('Authentication cancelled'));
    };
    const timeout = setTimeout(() => {
      if (finished) return;
      finished = true;
      if (session.attempt === attempt) reset(session);
      reject(new Error('Authentication timed out'));
    }, 45000);
    const complete = action => {
      if (finished || session.attempt !== attempt) return;
      finished = true;
      clearTimeout(timeout);
      session.cancelAuth = null;
      action();
    };
    const challenge = name => complete(() => {
      session.stage = 'challenge';
      session.challenge = name;
      resolve(status(session));
    });
    start({
      onSuccess(tokens) {
        complete(() => {
          session.tokens = tokens;
          session.stage = 'connected';
          session.challenge = null;
          session.email = tokens.getIdToken().payload.email || session.email;
          resolve(status(session));
        });
      },
      onFailure(error) { complete(() => reject(error)); },
      mfaRequired() { challenge('SMS_MFA'); },
      totpRequired() { challenge('SOFTWARE_TOKEN_MFA'); },
      newPasswordRequired() { complete(() => reject({ code: 'PasswordResetRequiredException' })); },
      mfaSetup() { complete(() => reject(new Error('MFA setup must be completed with iApartments'))); },
      selectMFAType() { complete(() => reject(new Error('MFA selection is not supported by this connection proof'))); },
      customChallenge() { complete(() => reject(new Error('Custom challenge requires the official account flow'))); },
    });
  });
}

async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw new Error('Request is too large');
    chunks.push(chunk);
  }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!result || Array.isArray(result) || typeof result !== 'object') throw new Error('Invalid request');
  return result;
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  // Docker probes the app from inside its own container. This endpoint neither
  // creates sessions nor returns resident information and is never proxied.
  if (req.method === 'GET' && req.url === '/healthz' && isLoopback(req.socket.remoteAddress)) return send(res, 200, { ok: true });
  if (!requestOrigin(network, req.headers)) return send(res, 403, { error: 'Invalid host' });
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`);
    const path = url.pathname;
    if (req.method === 'GET' && path === '/') {
      sessionFor(req, res);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(await readFile(htmlPath));
    }
    if (req.method === 'GET' && path === '/api/status') return send(res, 200, status(sessionFor(req, res)));
    if (req.method === 'GET' && path === '/api/weather') {
      const session = sessionFor(req, res);
      if (session.stage !== 'connected' || !session.user) return send(res, 401, { state: 'unavailable', error: 'Sign in to view weather.' });
      if ([...url.searchParams.keys()].some(key => key !== 'zip') || url.searchParams.getAll('zip').length > 1) return send(res, 400, { state: 'unavailable', error: 'Enter one five-digit US ZIP code.' });
      const attempt = session.attempt;
      try {
        const forecast = await weather.get(url.searchParams.has('zip') ? url.searchParams.get('zip') : undefined);
        if (session.stage !== 'connected' || session.attempt !== attempt) return send(res, 401, { state: 'unavailable', error: 'Sign in to view weather.' });
        return send(res, 200, forecast);
      } catch (error) {
        if (session.stage !== 'connected' || session.attempt !== attempt) return send(res, 401, { state: 'unavailable', error: 'Sign in to view weather.' });
        return send(res, error instanceof WeatherError ? error.statusCode : 503, { state: 'unavailable', error: error instanceof WeatherError ? error.message : 'Weather is unavailable right now. Please try again shortly.' });
      }
    }
    if (req.method !== 'POST' || !['/api/login', '/api/mfa', '/api/logout', '/api/refresh', '/api/thermostat'].includes(path)) return send(res, 404, { error: 'Not found' });
    if (!sameOriginJson(network, req.headers)) return send(res, 403, { error: 'Same-origin JSON requests are required' });
    const session = sessionFor(req, res);
    const input = await body(req);
    if (path === '/api/logout') {
      reset(session);
      return send(res, 200, status(session));
    }
    if (path === '/api/refresh' || path === '/api/thermostat') {
      if (session.stage !== 'connected' || !session.user) return send(res, 401, { error: 'Sign in to read your thermostat' });
      if (session.busy) return send(res, 409, { error: 'A thermostat request is already running' });
      const attempt = session.attempt;
      session.busy = true;
      try {
        if (path === '/api/thermostat') {
          if (session.readState !== 'fresh' || !session.thermostat?.canControl) return send(res, 409, { ...status(session), error: 'Refresh readings to verify thermostat controls before trying again.' });
          clearConfirmation(session, 'Sending requested settings.');
          const api = await adapter();
          if (attempt !== session.attempt || session.stage !== 'connected') return send(res, 200, status(session));
          if (typeof api.setThermostat !== 'function') throw new Error('Thermostat controls are unavailable');
          const result = await api.setThermostat(session, input);
          if (attempt !== session.attempt || session.stage !== 'connected') return send(res, 200, status(session));
          await discover(session, { commandSent: result?.commandSent === true });
        } else {
          await discover(session);
        }
        return send(res, 200, status(session));
      } catch (error) {
        if (attempt !== session.attempt || session.stage !== 'connected') return send(res, 200, status(session));
        const message = error.userMessage || 'The thermostat request could not be completed. Some settings may have changed. Refresh readings before trying again.';
        invalidateRead(session, message);
        return send(res, 400, { ...status(session), error: message });
      } finally { if (attempt === session.attempt) session.busy = false; }
    }
    if (path === '/api/login') {
      if (session.busy) return send(res, 409, { error: 'A sign-in request is already running' });
      const email = typeof input.email === 'string' ? input.email.trim() : '';
      if (!email || email.length > 254 || typeof input.password !== 'string' || !input.password || input.password.length > 2048) return send(res, 400, { error: 'Enter your email and password' });
      while (signInAttempts.length && Date.now() - signInAttempts[0] >= 60000) signInAttempts.shift();
      if (signInAttempts.length >= 20) return send(res, 429, { error: 'Please wait one minute before trying again' });
      session.attempts = session.attempts.filter(time => Date.now() - time < 60000);
      if (session.attempts.length >= 4) return send(res, 429, { error: 'Please wait one minute before trying again' });
      session.attempts.push(Date.now());
      signInAttempts.push(Date.now());
      reset(session);
      const attempt = session.attempt;
      session.email = email;
      const pool = new CognitoUserPool({ UserPoolId: POOL_ID, ClientId: CLIENT_ID, Storage: session.storage });
      session.user = new CognitoUser({ Username: email, Pool: pool, Storage: session.storage });
      const details = new AuthenticationDetails({ Username: email, Password: input.password });
      input.password = '';
      session.busy = true;
      try {
        await authenticate(session, callbacks => session.user.authenticateUser(details, callbacks));
        if (session.stage === 'connected') await discover(session);
        return send(res, 200, status(session));
      }
      catch (error) {
        if (attempt !== session.attempt) return send(res, 409, { error: 'This sign-in was cancelled' });
        reset(session);
        return send(res, 401, { error: authError(error) });
      }
      finally { details.password = undefined; if (attempt === session.attempt) session.busy = false; }
    }
    if (session.stage !== 'challenge' || !session.user) return send(res, 400, { error: 'Sign in before entering a verification code' });
    if (session.busy) return send(res, 409, { error: 'A sign-in request is already running' });
    if (typeof input.code !== 'string' || !/^\d{6}$/.test(input.code.trim())) return send(res, 400, { error: 'Enter the six-digit verification code' });
    const attempt = session.attempt;
    session.busy = true;
    try {
      await authenticate(session, callbacks => session.user.sendMFACode(input.code.trim(), callbacks, session.challenge));
      if (session.stage === 'connected') await discover(session);
      return send(res, 200, status(session));
    }
    catch (error) { return send(res, 401, { error: authError(error) }); }
    finally { if (attempt === session.attempt) session.busy = false; }
  } catch {
    if (!res.headersSent) send(res, 400, { error: 'The request could not be completed' });
    else res.end();
  }
});

setInterval(() => {
  for (const [key, session] of sessions) {
    if (Date.now() - session.lastSeen > 8 * 60 * 60 * 1000) { reset(session); sessions.delete(key); }
  }
}, 60000).unref();

server.requestTimeout = 60000;
server.headersTimeout = 10000;
server.listen(port, bindHost, () => console.log(`TemperMe ready: ${network.origins.join(', ')}`));
