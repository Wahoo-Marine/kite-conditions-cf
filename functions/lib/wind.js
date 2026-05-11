/**
 * Shared wind-station logic for the cron poller (src/worker.js) and the
 * on-demand API (functions/api/wind/[id].js).
 *
 * Two station kinds are supported:
 *   - WeatherLink embed (`weather_station` is the URL token)
 *   - NDBC realtime2 (`weather_station = 'ndbc:<STID>'`)
 *
 * History is stored in KV keyed by station token under HISTORY_KEY_PREFIX,
 * so multiple spots sharing a station share the same history series.
 */

export const HISTORY_HOURS = 6;
export const HISTORY_KEY_PREFIX = 'wind-history:';
export const CURRENT_KEY_PREFIX = 'wind-current:';
export const MIN_FETCH_INTERVAL = 30; // seconds — WeatherLink throttle window
export const GUST_WINDOW_MS = 10 * 60 * 1000; // 10-minute rolling gust window

const WEATHERLINK_URL = 'https://www.weatherlink.com/embeddablePage/getData/';
const MPS_TO_MPH = 2.23694;
const CURRENT_TTL = 120;
const HISTORY_TTL = 86400;

export function normalizeTimestamp(value, fallback = null) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    if (/^\d+$/.test(value)) {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function degreesToCardinal(deg) {
  if (deg == null || isNaN(deg)) return '?';
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const idx = Math.round(((deg % 360) + 360) % 360 / 22.5) % 16;
  return dirs[idx];
}

export function computeRollingGusts(entries) {
  return entries.map(entry => {
    const windowStart = entry.ts - GUST_WINDOW_MS;
    const windowEnd = entry.ts + GUST_WINDOW_MS;
    const windowVals = entries
      .filter(h => h.ts >= windowStart && h.ts <= windowEnd)
      .map(h => h.wind);
    const rollingGust = windowVals.length > 0 ? Math.max(...windowVals) : entry.wind;
    return { ...entry, gust: rollingGust };
  });
}

export function parseStation(rawToken) {
  if (rawToken.startsWith('ndbc:')) {
    const stid = rawToken.slice(5).toUpperCase();
    return { kind: 'ndbc', key: `ndbc:${stid}`, stid };
  }
  return { kind: 'weatherlink', key: rawToken, token: rawToken };
}

export function keysFor(stationKey) {
  return {
    historyKey: `${HISTORY_KEY_PREFIX}${stationKey}`,
    currentKey: `${CURRENT_KEY_PREFIX}${stationKey}`,
  };
}

export async function loadHistory(env, historyKey) {
  try {
    const raw = await env.CACHE.get(historyKey, { type: 'json' });
    if (raw && Array.isArray(raw)) {
      return raw
        .map(h => ({ ...h, ts: normalizeTimestamp(h.ts, null) }))
        .filter(h => h.ts != null && Number.isFinite(h.ts))
        .sort((a, b) => a.ts - b.ts);
    }
  } catch {}
  return [];
}

async function saveHistory(env, historyKey, history) {
  await env.CACHE.put(historyKey, JSON.stringify(history), { expirationTtl: HISTORY_TTL });
}

async function saveCurrent(env, currentKey, current) {
  const ts = Math.floor(Date.now() / 1000);
  await env.CACHE.put(currentKey, JSON.stringify({ ts, data: current }), { expirationTtl: CURRENT_TTL });
}

export async function getCachedCurrent(env, currentKey) {
  try {
    return await env.CACHE.get(currentKey, { type: 'json' });
  } catch {
    return null;
  }
}

function trimHistory(history) {
  const cutoff = Date.now() - (HISTORY_HOURS * 60 * 60 * 1000);
  return history.filter(h => h.ts > cutoff).sort((a, b) => a.ts - b.ts);
}

async function fetchWeatherLink(token) {
  const resp = await fetch(`${WEATHERLINK_URL}${token}`, {
    signal: AbortSignal.timeout(10000),
    headers: { 'User-Agent': 'KiteConditions/1.0', 'Accept': 'application/json' },
  });
  if (!resp.ok) throw new Error(`WeatherLink HTTP ${resp.status}`);
  const wl = await resp.json();

  const windDir = wl.windDirection || 0;
  const current = {
    wind: parseFloat(wl.wind) || 0,
    gust: parseFloat(wl.gust) || 0,
    wind_dir: windDir,
    wind_dir_cardinal: degreesToCardinal(windDir),
    temp: parseFloat(wl.temperature) || null,
    feels_like: parseFloat(wl.temperatureFeelLike) || null,
    humidity: parseFloat(wl.humidity) || null,
    hi_temp: parseFloat(wl.hiTemp) || null,
    lo_temp: parseFloat(wl.loTemp) || null,
    barometer: wl.barometer || null,
    barometer_trend: wl.barometerTrend || null,
    rain: wl.rain || null,
    wind_units: wl.windUnits || 'mph',
    temp_units: wl.tempUnits || '°F',
    last_received: wl.lastReceived || null,
    station_location: wl.systemLocation || null,
  };

  const readingTs = normalizeTimestamp(wl.lastReceived, Date.now());
  return { current, readingTs };
}

async function fetchNdbc(stid) {
  const resp = await fetch(`https://www.ndbc.noaa.gov/data/realtime2/${stid}.txt`, {
    signal: AbortSignal.timeout(10000),
    headers: { 'User-Agent': 'KiteConditions/1.0' },
  });
  if (!resp.ok) throw new Error(`NDBC HTTP ${resp.status}`);
  const text = await resp.text();
  const lines = text.trim().split('\n').filter(l => !l.startsWith('#'));
  if (!lines.length) throw new Error('No NDBC data');
  const parts = lines[0].trim().split(/\s+/);
  // Columns: YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP DEWP VIS PTDY TIDE
  const wdir = parseFloat(parts[5]);
  const wspd = parseFloat(parts[6]); // m/s
  const gst  = parseFloat(parts[7]); // m/s
  const pres = parseFloat(parts[12]);
  const atmp = parseFloat(parts[13]); // °C

  const windMph = isNaN(wspd) ? 0 : Math.round(wspd * MPS_TO_MPH * 10) / 10;
  const gustMph = isNaN(gst)  ? windMph : Math.round(gst  * MPS_TO_MPH * 10) / 10;
  const windDeg = isNaN(wdir) ? 0 : wdir;
  const tempF   = isNaN(atmp) ? null : Math.round(atmp * 9/5 + 32);

  const [yy, mo, dd, hh, mm] = parts.slice(0, 5).map(Number);
  const readingTs = Date.UTC(yy, mo - 1, dd, hh, mm);

  const current = {
    wind: windMph,
    gust: gustMph,
    wind_dir: windDeg,
    wind_dir_cardinal: degreesToCardinal(windDeg),
    dir: degreesToCardinal(windDeg),
    temp: tempF,
    feels_like: null,
    humidity: null,
    barometer: isNaN(pres) ? null : pres,
    barometer_trend: null,
    rain: null,
    wind_units: 'mph',
    temp_units: '°F',
    last_received: new Date(readingTs).toISOString(),
    station_location: `NDBC ${stid}`,
  };

  return { current, readingTs };
}

function appendWeatherLinkReading(history, current, readingTs) {
  const last = history.length > 0 ? history[history.length - 1] : null;
  if (last && last.ts === readingTs) return history;

  history.push({
    ts: readingTs,
    wind: current.wind,
    dir: current.wind_dir,
    temp: current.temp,
  });
  return computeRollingGusts(trimHistory(history));
}

function appendNdbcReading(history, current, readingTs) {
  const last = history.length > 0 ? history[history.length - 1] : null;
  if (last && last.ts === readingTs) return history;

  history.push({
    ts: readingTs,
    wind: current.wind,
    gust: current.gust,
    dir: current.wind_dir,
    temp: current.temp,
  });
  return trimHistory(history);
}

async function pollWeatherLinkStation(token, env) {
  const { historyKey, currentKey } = keysFor(token);
  const { current, readingTs } = await fetchWeatherLink(token);
  await saveCurrent(env, currentKey, current);

  let history = await loadHistory(env, historyKey);
  const next = appendWeatherLinkReading(history, current, readingTs);
  if (next !== history) {
    history = next;
    await saveHistory(env, historyKey, history);
  }
  return { current, history };
}

async function pollNdbcStation(stid, env) {
  const { historyKey, currentKey } = keysFor(`ndbc:${stid}`);
  const { current, readingTs } = await fetchNdbc(stid);
  await saveCurrent(env, currentKey, current);

  let history = await loadHistory(env, historyKey);
  const next = appendNdbcReading(history, current, readingTs);
  if (next !== history) {
    history = next;
    await saveHistory(env, historyKey, history);
  }
  return { current, history };
}

export async function pollStation(rawToken, env) {
  const parsed = parseStation(rawToken);
  if (parsed.kind === 'ndbc') return pollNdbcStation(parsed.stid, env);
  return pollWeatherLinkStation(parsed.token, env);
}
