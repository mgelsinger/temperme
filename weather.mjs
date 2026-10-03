// Optional outdoor forecasts. Only a chosen ZIP and its public coordinates leave
// this module; thermostat credentials and readings are never involved.
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const CACHE_TTL = 15 * MINUTE;
const STALE_TTL = 6 * HOUR;
const RETRY_DELAY = MINUTE;
const MAX_ENTRIES = 32;
const MAX_IN_FLIGHT = 4;
const MAX_RESPONSE_BYTES = 256 * 1024;
const GEOCODING_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

export class WeatherError extends Error {
  constructor(statusCode, message) { super(message); this.statusCode = statusCode; }
}

function zipCode(value) {
  if (typeof value !== 'string' || !/^\d{5}$/.test(value)) throw new WeatherError(400, 'Enter a five-digit US ZIP code.');
  return value;
}

function timezone(value) {
  if (typeof value !== 'string' || value.length > 100) throw new Error('Invalid weather timezone');
  new Intl.DateTimeFormat('en-US', { timeZone: value }).format(0);
  return value;
}

function localDate(time, zone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(time);
  const part = name => parts.find(item => item.type === name).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

const number = (value, min, max) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max ? value : null;
const temperature = value => number(value, -150, 160);
const epoch = value => number(value, 0, 4_102_444_800);
const text = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100) : '';

function condition(code, day) {
  if (code === 0) return { condition: day ? 'Clear sky' : 'Clear night', icon: 'clear' };
  if (code === 1) return { condition: 'Mostly clear', icon: 'partly-cloudy' };
  if (code === 2) return { condition: 'Partly cloudy', icon: 'partly-cloudy' };
  if (code === 3) return { condition: 'Overcast', icon: 'cloudy' };
  if ([45, 48].includes(code)) return { condition: 'Fog', icon: 'fog' };
  if ([51, 53, 55].includes(code)) return { condition: 'Drizzle', icon: 'drizzle' };
  if ([56, 57].includes(code)) return { condition: 'Freezing drizzle', icon: 'drizzle' };
  if ([61, 63, 65, 80, 81, 82].includes(code)) return { condition: 'Rain', icon: 'rain' };
  if ([66, 67].includes(code)) return { condition: 'Freezing rain', icon: 'rain' };
  if ([71, 73, 75, 77, 85, 86].includes(code)) return { condition: 'Snow', icon: 'snow' };
  if ([95, 96, 99].includes(code)) return { condition: 'Thunderstorm', icon: 'storm' };
  return { condition: 'Conditions unavailable', icon: 'unknown' };
}

function findLocation(data, zip) {
  const place = Array.isArray(data?.results) && data.results.find(item => item.country_code === 'US' && Array.isArray(item.postcodes) && item.postcodes.includes(zip));
  if (!place) throw new WeatherError(404, 'That US ZIP code was not found. Check it and try again.');
  const latitude = number(place.latitude, -90, 90);
  const longitude = number(place.longitude, -180, 180);
  const name = text(place.name);
  if (latitude === null || longitude === null || !name) throw new Error('Invalid weather location');
  return { latitude, longitude, timezone: timezone(place.timezone), name: [name, text(place.admin1)].filter(Boolean).join(', ') };
}

function normalize(data, place, receivedAt) {
  if (!data || typeof data !== 'object' || data.error) throw new Error('Invalid weather response');
  const zone = timezone(data.timezone);
  if (zone !== place.timezone) throw new Error('Unexpected weather timezone');
  if (!Array.isArray(data.hourly?.time) || !Array.isArray(data.daily?.time) || !data.current) throw new Error('Missing weather data');
  if (data.current_units?.temperature_2m !== '°F' || data.hourly_units?.temperature_2m !== '°F' || data.daily_units?.temperature_2m_max !== '°F' || data.daily_units?.temperature_2m_min !== '°F' || data.hourly_units?.precipitation_probability !== '%' || data.current_units?.time !== 'unixtime' || data.hourly_units?.time !== 'unixtime' || data.daily_units?.time !== 'unixtime') throw new Error('Unexpected weather units');
  if (epoch(data.current.time) === null || data.hourly.time.length < 12 || !data.daily.time.length) throw new Error('Incomplete weather data');
  if (data.hourly.time.length > 100 || data.daily.time.length > 4) throw new Error('Unexpected weather length');
  const offset = number(data.utc_offset_seconds, -14 * 3600, 14 * 3600);
  if (offset === null) throw new Error('Invalid weather offset');
  const daily = data.daily.time.map((value, i) => {
    if (epoch(value) === null) throw new Error('Invalid daily timestamp');
    // Open-Meteo documents daily epoch dates with this supplied offset. Hourly
    // epochs remain UTC, so repeated or skipped DST hours stay unambiguous.
    return { date: new Date((value + offset) * 1000).toISOString().slice(0, 10), high: temperature(data.daily.temperature_2m_max?.[i]), low: temperature(data.daily.temperature_2m_min?.[i]) };
  });
  const hourly = data.hourly.time.map((value, i) => {
    if (epoch(value) === null) throw new Error('Invalid hourly timestamp');
    const isDay = data.hourly.is_day?.[i] === 1;
    return { time: new Date(value * 1000).toISOString(), temperature: temperature(data.hourly.temperature_2m?.[i]), precipitationProbability: number(data.hourly.precipitation_probability?.[i], 0, 100), ...condition(data.hourly.weather_code?.[i], isDay), isDay };
  });
  if (hourly.some((item, i) => i && item.time <= hourly[i - 1].time)) throw new Error('Invalid hourly sequence');
  if (!hourly.some(item => Date.parse(item.time) >= Math.ceil(receivedAt / HOUR) * HOUR)) throw new Error('No upcoming weather data');
  const isDay = data.current.is_day === 1;
  return { location: place.name, timezone: zone, updatedAt: new Date(receivedAt).toISOString(), daily, hourly, current: { temperature: temperature(data.current.temperature_2m), ...condition(data.current.weather_code, isDay), isDay } };
}

function snapshot(forecast, zip, now, stale) {
  const date = localDate(now, forecast.timezone);
  const firstHour = Math.ceil(now / HOUR) * HOUR;
  return {
    state: stale ? 'stale' : 'fresh', zip, location: forecast.location, timezone: forecast.timezone, updatedAt: forecast.updatedAt,
    today: forecast.daily.find(day => day.date === date) || { date, high: null, low: null },
    current: forecast.current,
    hourly: forecast.hourly.filter(hour => Date.parse(hour.time) >= firstHour).slice(0, 12),
    ...(stale ? { message: 'Weather could not refresh. Showing the last available forecast; check its update time.' } : {}),
  };
}

export function createWeatherService({ fetchImpl = fetch, now = Date.now, defaultZip = process.env.TEMPERME_WEATHER_ZIP || '' } = {}) {
  const configuredZip = typeof defaultZip === 'string' ? defaultZip.trim() : '';
  const entries = new Map();
  const inFlight = new Map();
  const providerRequests = [];

  function entryFor(zip) {
    const previous = entries.get(zip);
    if (previous) { entries.delete(zip); entries.set(zip, previous); return previous; }
    if (entries.size >= MAX_ENTRIES) {
      const oldest = [...entries.keys()].find(key => !inFlight.has(key));
      if (oldest !== undefined) entries.delete(oldest);
    }
    const entry = {};
    entries.set(zip, entry);
    return entry;
  }

  async function json(url) {
    const time = now();
    while (providerRequests.length && providerRequests[0] <= time - 24 * HOUR) providerRequests.shift();
    if (providerRequests.length >= 1000 || providerRequests.filter(value => value > time - MINUTE).length >= 30) throw new WeatherError(429, 'Weather requests are temporarily limited. Please try again later.');
    providerRequests.push(time);
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetchImpl(url, { redirect: 'error', signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!response.ok || !response.body) throw new Error('Weather provider request failed');
      if (Number(response.headers.get('content-length')) > MAX_RESPONSE_BYTES) throw new Error('Weather response too large');
      let size = 0;
      const chunks = [];
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > MAX_RESPONSE_BYTES) throw new Error('Weather response too large');
        chunks.push(Buffer.from(chunk));
      }
      return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } finally { clearTimeout(deadline); controller.abort(); }
  }

  async function refresh(zip, entry) {
    try {
      if (!entry.place) {
        const url = new URL(GEOCODING_URL);
        url.search = new URLSearchParams({ name: zip, countryCode: 'US', count: '10', language: 'en', format: 'json' });
        entry.place = findLocation(await json(url), zip);
      }
      const url = new URL(FORECAST_URL);
      url.search = new URLSearchParams({
        latitude: String(entry.place.latitude), longitude: String(entry.place.longitude), timezone: entry.place.timezone,
        temperature_unit: 'fahrenheit', timeformat: 'unixtime', forecast_days: '3',
        current: 'temperature_2m,weather_code,is_day', hourly: 'temperature_2m,weather_code,is_day,precipitation_probability',
        daily: 'temperature_2m_max,temperature_2m_min',
      });
      const data = await json(url);
      entry.forecast = normalize(data, entry.place, now());
      entry.fetchedAt = now();
      entry.retryAfter = 0;
      entry.failure = null;
    } catch (error) {
      entry.retryAfter = now() + RETRY_DELAY;
      entry.failure = error instanceof WeatherError ? error : new WeatherError(503, 'Weather is unavailable right now. Please try again shortly.');
    }
  }

  return {
    async get(value) {
      if (value === undefined && !configuredZip) return { state: 'unconfigured', defaultZip: null };
      const zip = zipCode(value === undefined ? configuredZip : value);
      const entry = entryFor(zip);
      const time = now();
      if (entry.forecast && time - entry.fetchedAt < CACHE_TTL) return snapshot(entry.forecast, zip, time, false);
      if (!entry.retryAfter || time >= entry.retryAfter) {
        if (inFlight.has(zip)) await inFlight.get(zip);
        else if (inFlight.size < MAX_IN_FLIGHT) {
          const pending = refresh(zip, entry);
          inFlight.set(zip, pending);
          try { await pending; } finally { inFlight.delete(zip); }
        } else {
          if (entry.forecast && time - entry.fetchedAt < STALE_TTL) return snapshot(entry.forecast, zip, time, true);
          throw new WeatherError(429, 'Weather requests are busy. Please try again shortly.');
        }
      }
      if (entry.forecast && now() - entry.fetchedAt < STALE_TTL) return snapshot(entry.forecast, zip, now(), Boolean(entry.failure));
      throw entry.failure || new WeatherError(503, 'Weather is unavailable right now. Please try again shortly.');
    },
  };
}
