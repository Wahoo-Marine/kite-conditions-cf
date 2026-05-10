import pages from '../dist/pages-bundle.js';

const HISTORY_HOURS = 6;
const HISTORY_KEY_PREFIX = 'wind-history:';
const CURRENT_KEY_PREFIX = 'wind-current:';
const WEATHERLINK_URL = 'https://www.weatherlink.com/embeddablePage/getData/';
const MPS_TO_MPH = 2.23694;

function normalizeTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    if (/^\d+$/.test(value)) {
      const n = Number(value);
      if (Number.isFinite(n)) return n;
    }
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function computeRollingGusts(entries) {
  const GUST_WINDOW_MS = 10 * 60 * 1000;
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

async function loadHistory(env, key) {
  try {
    const raw = await env.CACHE.get(key, { type: 'json' });
    if (raw && Array.isArray(raw)) {
      return raw
        .map(h => ({ ...h, ts: normalizeTimestamp(h.ts) }))
        .filter(h => h.ts != null)
        .sort((a, b) => a.ts - b.ts);
    }
  } catch {}
  return [];
}

async function pollWeatherLink(token, env) {
  const historyKey = `${HISTORY_KEY_PREFIX}${token}`;
  const currentKey = `${CURRENT_KEY_PREFIX}${token}`;
  const now = Math.floor(Date.now() / 1000);

  const resp = await fetch(`${WEATHERLINK_URL}${token}`, {
    signal: AbortSignal.timeout(10000),
    headers: { 'User-Agent': 'KiteConditions/1.0', 'Accept': 'application/json' },
  });
  if (!resp.ok) throw new Error(`WeatherLink HTTP ${resp.status}`);
  const wl = await resp.json();

  const current = {
    wind: parseFloat(wl.wind) || 0,
    gust: parseFloat(wl.gust) || 0,
    wind_dir: wl.windDirection || 0,
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

  await env.CACHE.put(currentKey, JSON.stringify({ ts: now, data: current }), { expirationTtl: 120 });

  let history = await loadHistory(env, historyKey);
  const readingTs = normalizeTimestamp(wl.lastReceived) ?? now * 1000;
  const lastTs = history.length > 0 ? history[history.length - 1].ts : null;

  if (lastTs == null || lastTs !== readingTs) {
    history.push({ ts: readingTs, wind: current.wind, dir: current.wind_dir, temp: current.temp });
    const cutoff = Date.now() - (HISTORY_HOURS * 60 * 60 * 1000);
    history = history.filter(h => h.ts > cutoff).sort((a, b) => a.ts - b.ts);
    history = computeRollingGusts(history);
    await env.CACHE.put(historyKey, JSON.stringify(history), { expirationTtl: 86400 });
  }
}

async function pollNdbc(stid, env) {
  const tokenKey = `ndbc:${stid}`;
  const historyKey = `${HISTORY_KEY_PREFIX}${tokenKey}`;
  const currentKey = `${CURRENT_KEY_PREFIX}${tokenKey}`;
  const now = Math.floor(Date.now() / 1000);

  const resp = await fetch(`https://www.ndbc.noaa.gov/data/realtime2/${stid}.txt`, {
    signal: AbortSignal.timeout(10000),
    headers: { 'User-Agent': 'KiteConditions/1.0' },
  });
  if (!resp.ok) throw new Error(`NDBC HTTP ${resp.status}`);
  const text = await resp.text();
  const lines = text.trim().split('\n').filter(l => !l.startsWith('#'));
  if (!lines.length) throw new Error('No NDBC data');
  const parts = lines[0].trim().split(/\s+/);
  const wdir = parseFloat(parts[5]);
  const wspd = parseFloat(parts[6]);
  const gst  = parseFloat(parts[7]);
  const pres = parseFloat(parts[12]);
  const atmp = parseFloat(parts[13]);

  const windMph = isNaN(wspd) ? 0 : Math.round(wspd * MPS_TO_MPH * 10) / 10;
  const gustMph = isNaN(gst)  ? windMph : Math.round(gst  * MPS_TO_MPH * 10) / 10;
  const windDeg = isNaN(wdir) ? 0 : wdir;
  const tempF   = isNaN(atmp) ? null : Math.round(atmp * 9/5 + 32);
  const [yy, mo, dd, hh, mm] = parts.slice(0, 5).map(Number);
  const readingTs = Date.UTC(yy, mo - 1, dd, hh, mm);

  const current = {
    wind: windMph, gust: gustMph, wind_dir: windDeg, temp: tempF,
    feels_like: null, humidity: null,
    barometer: isNaN(pres) ? null : pres,
    barometer_trend: null, rain: null,
    wind_units: 'mph', temp_units: '°F',
    last_received: new Date(readingTs).toISOString(),
    station_location: null,
  };

  await env.CACHE.put(currentKey, JSON.stringify({ ts: now, data: current }), { expirationTtl: 120 });

  let history = await loadHistory(env, historyKey);
  const lastTs = history.length > 0 ? history[history.length - 1].ts : null;
  if (lastTs == null || lastTs !== readingTs) {
    history.push({ ts: readingTs, wind: windMph, gust: gustMph, dir: windDeg, temp: tempF });
    const cutoff = Date.now() - (HISTORY_HOURS * 60 * 60 * 1000);
    history = history.filter(h => h.ts > cutoff).sort((a, b) => a.ts - b.ts);
    await env.CACHE.put(historyKey, JSON.stringify(history), { expirationTtl: 86400 });
  }
}

async function pollAllStations(env) {
  const { results } = await env.DB.prepare(
    "SELECT DISTINCT weather_station FROM spots WHERE weather_station IS NOT NULL AND weather_station != ''"
  ).all();

  await Promise.allSettled((results || []).map(row => {
    const token = row.weather_station;
    if (!token) return Promise.resolve();
    return token.startsWith('ndbc:')
      ? pollNdbc(token.slice(5).toUpperCase(), env)
      : pollWeatherLink(token, env);
  }));
}

export default {
  async fetch(request, env, ctx) {
    return pages.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollAllStations(env));
  },
};
