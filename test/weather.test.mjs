import test from 'node:test';
import assert from 'node:assert/strict';
import { createWeatherService, WeatherError } from '../weather.mjs';

const HOUR = 3_600_000;
const START = Date.parse('2026-10-02T16:20:00Z');
const place = { name: 'Example City', admin1: 'New York', country_code: 'US', postcodes: ['10001'], latitude: 40.71, longitude: -74.01, timezone: 'America/New_York' };
function forecast({ time = START, zone = 'America/New_York', offset = -14400, dates = ['2026-10-02', '2026-10-03', '2026-10-04'] } = {}) {
  const first = Math.floor(time / HOUR) * HOUR - 2 * HOUR;
  const hours = Array.from({ length: 60 }, (_, i) => (first + i * HOUR) / 1000);
  return {
    timezone: zone, utc_offset_seconds: offset,
    current: { time: time / 1000, temperature_2m: 72.5, weather_code: 2, is_day: 1 },
    current_units: { time: 'unixtime', temperature_2m: '°F' },
    hourly: { time: hours, temperature_2m: hours.map((_, i) => 70 + i / 10), weather_code: hours.map(() => 0), is_day: hours.map(() => 1), precipitation_probability: hours.map(() => 25) },
    hourly_units: { time: 'unixtime', temperature_2m: '°F', precipitation_probability: '%' },
    daily: { time: dates.map(date => Date.parse(`${date}T00:00:00Z`) / 1000 - offset), temperature_2m_max: [80, 81, 82], temperature_2m_min: [60, 61, 62] },
    daily_units: { time: 'unixtime', temperature_2m_max: '°F', temperature_2m_min: '°F' },
  };
}
function harness({ defaultZip = '', start = START, data = forecast(), location = place } = {}) {
  const state = { time: start, requests: [], geo: { results: [location] }, forecast: data, fail: false, handler: null };
  const service = createWeatherService({ defaultZip, now: () => state.time, fetchImpl: async (url, options) => {
    state.requests.push({ url: new URL(url), options });
    if (state.handler) return state.handler(url, options);
    if (state.fail) throw new Error('Private provider error that must never reach the browser');
    return Response.json(url.hostname === 'geocoding-api.open-meteo.com' ? state.geo : state.forecast);
  } });
  return { service, state };
}
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test('unconfigured weather makes no request and strictly validates ZIP input', async () => {
  const { service, state } = harness();
  assert.deepEqual(await service.get(), { state: 'unconfigured', defaultZip: null });
  for (const bad of ['', '1000', '10001-1234', ' 10001', '10001 ', 10001, null, 'https://example.test']) await assert.rejects(service.get(bad), error => error instanceof WeatherError && error.statusCode === 400);
  assert.equal(state.requests.length, 0);
});

test('verified US ZIP produces Fahrenheit, today, and twelve UTC hours via fixed providers', async () => {
  const { service, state } = harness({ defaultZip: '10001' });
  const result = await service.get();
  assert.equal(result.state, 'fresh');
  assert.equal(result.zip, '10001');
  assert.equal(result.location, 'Example City, New York');
  assert.deepEqual(result.today, { date: '2026-10-02', high: 80, low: 60 });
  assert.deepEqual(result.current, { temperature: 72.5, condition: 'Partly cloudy', icon: 'partly-cloudy', isDay: true });
  assert.equal(result.hourly.length, 12);
  assert.equal(result.hourly[0].time, '2026-10-02T17:00:00.000Z');
  assert.equal(result.hourly[0].precipitationProbability, 25);
  assert.equal(result.updatedAt, new Date(START).toISOString());
  assert.equal(state.requests[0].url.origin, 'https://geocoding-api.open-meteo.com');
  assert.equal(state.requests[0].url.searchParams.get('countryCode'), 'US');
  assert.equal(state.requests[1].url.origin, 'https://api.open-meteo.com');
  assert.equal(state.requests[1].url.searchParams.get('temperature_unit'), 'fahrenheit');
  assert.equal(state.requests[1].url.searchParams.get('timezone'), 'America/New_York');
  for (const request of state.requests) { assert.equal(request.options.redirect, 'error'); assert.ok(request.options.signal); }
});

test('geocoder requires an exact US postal-code match rather than accepting a fuzzy result', async () => {
  for (const mismatched of [{ ...place, postcodes: ['10002'] }, { ...place, country_code: 'CA' }]) {
    const { service, state } = harness({ location: mismatched });
    await assert.rejects(service.get('10001'), error => error.statusCode === 404);
    await assert.rejects(service.get('10001'), error => error.statusCode === 404);
    assert.equal(state.requests.length, 1, 'failed locations have a short retry backoff');
  }
});

test('cache avoids duplicate upstream reads and refreshes after fifteen minutes', async () => {
  const { service, state } = harness();
  const first = await service.get('10001');
  state.time += 14 * 60_000;
  assert.equal((await service.get('10001')).updatedAt, first.updatedAt);
  assert.equal(state.requests.length, 2);
  state.time += 60_000;
  assert.equal((await service.get('10001')).updatedAt, new Date(state.time).toISOString());
  assert.equal(state.requests.length, 3, 'geocoded coordinates are reused in memory');
});

test('provider failures return sanitized errors, with stale fallback restricted to the same ZIP', async () => {
  const { service, state } = harness();
  const first = await service.get('10001');
  state.fail = true;
  state.time += 16 * 60_000;
  const stale = await service.get('10001');
  assert.equal(stale.state, 'stale');
  assert.equal(stale.updatedAt, first.updatedAt);
  assert.match(stale.message, /last available forecast/);
  const count = state.requests.length;
  await service.get('10001');
  assert.equal(state.requests.length, count, 'failed forecasts back off for one minute');
  await assert.rejects(service.get('10002'), error => error.statusCode === 503 && !error.message.includes('Private'));
  state.time = START + 6 * HOUR;
  await assert.rejects(service.get('10001'), error => error.statusCode === 503);
});

test('cached and stale responses roll the ZIP-local day and hours forward over midnight', async () => {
  const start = Date.parse('2026-10-03T03:55:00Z');
  const { service, state } = harness({ start, data: forecast({ time: start }) });
  const first = await service.get('10001');
  assert.equal(first.today.date, '2026-10-02');
  state.time += 10 * 60_000;
  const nextDay = await service.get('10001');
  assert.equal(nextDay.state, 'fresh');
  assert.deepEqual(nextDay.today, { date: '2026-10-03', high: 81, low: 61 });
  assert.equal(nextDay.hourly[0].time, '2026-10-03T05:00:00.000Z');
  assert.equal(state.requests.length, 2);
  state.fail = true;
  state.time += 20 * 60_000;
  const stale = await service.get('10001');
  assert.equal(stale.state, 'stale');
  assert.equal(stale.today.date, '2026-10-03');
  assert.equal(stale.updatedAt, first.updatedAt);
});

test('missing today never presents yesterday high and low under today', async () => {
  const start = Date.parse('2026-10-03T03:55:00Z');
  const { service, state } = harness({ start, data: forecast({ time: start, dates: ['2026-10-02'] }) });
  await service.get('10001');
  state.time += 10 * 60_000;
  assert.deepEqual((await service.get('10001')).today, { date: '2026-10-03', high: null, low: null });
});

test('DST repeat and skipped hours stay UTC-ordered with local calendar dates', async () => {
  for (const [start, dates, offset, expectedHours] of [
    ['2026-11-01T04:30:00Z', ['2026-11-01', '2026-11-02', '2026-11-03'], -14400, [1, 1, 2]],
    ['2026-03-08T05:30:00Z', ['2026-03-08', '2026-03-09', '2026-03-10'], -18000, [1, 3, 4]],
  ]) {
    const time = Date.parse(start);
    const { service } = harness({ start: time, data: forecast({ time, dates, offset }) });
    const result = await service.get('10001');
    assert.equal(result.today.date, dates[0]);
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: result.timezone, hour: 'numeric', hourCycle: 'h23' });
    assert.deepEqual(result.hourly.slice(0, 3).map(hour => Number(formatter.format(new Date(hour.time)))), expectedHours);
    for (let i = 1; i < result.hourly.length; i++) assert.equal(Date.parse(result.hourly[i].time) - Date.parse(result.hourly[i - 1].time), HOUR);
  }
});

test('null, missing, and invalid numeric values are never coerced into zero', async () => {
  const data = forecast();
  data.current.temperature_2m = null;
  data.current.weather_code = null;
  data.daily.temperature_2m_max[0] = null;
  data.daily.temperature_2m_min[0] = '60';
  data.hourly.temperature_2m.fill(null);
  data.hourly.precipitation_probability.fill(101);
  const { service } = harness({ data });
  const result = await service.get('10001');
  assert.equal(result.current.temperature, null);
  assert.equal(result.current.icon, 'unknown');
  assert.deepEqual(result.today, { date: '2026-10-02', high: null, low: null });
  assert.ok(result.hourly.every(hour => hour.temperature === null && hour.precipitationProbability === null));
});

test('malformed units, timezones, epochs, and provider errors become safe unavailable responses', async () => {
  for (const mutate of [
    data => { data.hourly_units.temperature_2m = '°C'; },
    data => { data.timezone = 'not/a/timezone'; },
    data => { data.timezone = 'Europe/London'; },
    data => { data.current.time = null; },
    data => { data.daily.time[0] = null; },
    data => { data.hourly.time[1] = data.hourly.time[0]; },
    data => { data.hourly.time = data.hourly.time.map(time => time - 10 * 24 * 3600); },
    data => { data.error = true; data.reason = 'private error'; },
  ]) {
    const data = forecast();
    mutate(data);
    const { service } = harness({ data });
    await assert.rejects(service.get('10001'), error => error.statusCode === 503 && error.message === 'Weather is unavailable right now. Please try again shortly.');
  }
});

test('concurrent requests for one ZIP share the upstream work', async () => {
  const { service, state } = harness();
  const release = deferred();
  state.handler = async url => {
    if (url.hostname === 'geocoding-api.open-meteo.com') { await release.promise; return Response.json(state.geo); }
    return Response.json(state.forecast);
  };
  const first = service.get('10001');
  const second = service.get('10001');
  release.resolve();
  const results = await Promise.all([first, second]);
  assert.deepEqual(results[0], results[1]);
  assert.equal(state.requests.length, 2);
});

test('only four ZIP lookups can run at once', async () => {
  const { service, state } = harness();
  const release = deferred();
  state.handler = async () => { await release.promise; return Response.json({ results: [] }); };
  const pending = ['10001', '10002', '10003', '10004'].map(zip => service.get(zip).catch(error => error));
  await assert.rejects(service.get('10005'), error => error.statusCode === 429);
  assert.equal(state.requests.length, 4);
  release.resolve();
  await Promise.all(pending);
});

test('bounded ZIP cache evicts old entries and provider budget limits uncached queries', async () => {
  const { service, state } = harness();
  for (let i = 0; i < 33; i++) {
    const zip = String(10000 + i);
    state.geo = { results: [{ ...place, postcodes: [zip] }] };
    await service.get(zip);
    state.time += 5_000;
  }
  const before = state.requests.length;
  state.geo = { results: [{ ...place, postcodes: ['10000'] }] };
  await service.get('10000');
  assert.equal(state.requests.length, before + 2, 'evicted ZIP requires a fresh geocode and forecast');

  const limited = harness();
  limited.state.geo = { results: [] };
  for (let i = 0; i < 30; i++) await assert.rejects(limited.service.get(String(10000 + i)), error => error.statusCode === 404);
  await assert.rejects(limited.service.get('10030'), error => error.statusCode === 429);
  assert.equal(limited.state.requests.length, 30);
});

test('responses are bounded even when content-length is omitted', async () => {
  const { service, state } = harness();
  state.handler = async () => new Response('x'.repeat(256 * 1024 + 1));
  await assert.rejects(service.get('10001'), error => error.statusCode === 503);
});
