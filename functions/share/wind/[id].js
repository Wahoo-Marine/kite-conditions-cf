/**
 * GET /api/wind/:id
 * Fetches live wind data from a WeatherLink station associated with the spot,
 * stores each reading in KV for historical graphing, and returns both current
 * conditions and the last 6 hours of wind history.
 */

const HISTORY_HOURS = 6;
const HISTORY_KEY_PREFIX = 'wind-history:';
const CURRENT_KEY_PREFIX = 'wind-current:';
const WEATHERLINK_URL = 'https://www.weatherlink.com/embeddablePage/getData/';
const MIN_FETCH_INTERVAL = 30; // seconds – don't hit WeatherLink more than once per 30s

export async function onRequestGet(context) {
  const { env, request, params } = context;
  const spotId = params.id;

  // Look up spot + weather_station token
  const spot = await env.DB.prepare(
    'SELECT id, name, weather_station FROM spots WHERE id = ?'
  ).bind(spotId).first();

  if (!spot) {
    return Response.json({ error: 'Spot not found' }, { status: 404 });
  }

  if (!spot.weather_station) {
    return Response.json({ error: 'No weather station configured for this spot' }, { status: 404 });
  }

  const token = spot.weather_station;

  // Route to NDBC handler if token starts with 'ndbc:'
  if (token.startsWith('ndbc:')) {
    const stid = token.slice(5).toUpperCase();
    return handleNdbc(stid, spotId, spot.name, env);
  }

  const historyKey = `${HISTORY_KEY_PREFIX}${spotId}`;
  const currentKey = `${CURRENT_KEY_PREFIX}${spotId}`;

  // Load existing history from KV
  let history = [];
  let historyNeedsRecompute = false;
  try {
    const raw = await env.CACHE.get(historyKey, { type: 'json' });
    if (raw && Array.isArray(raw)) {
      history = raw;
      // Migration: if all gust values are identical (stale daily-high), mark for recompute
      if (history.length > 2) {
        const gusts = history.map(h => h.gust).filter(g => g != null);
        const allSame = gusts.length > 1 && gusts.every(g => g === gusts[0]);
        if (allSame) {
          history = history.map(h => { const e = { ...h }; delete e.gust; return e; });
          historyNeedsRecompute = true;
        }
      }
    }
  } catch (e) { /* ignore */ }

  // Helper: compute rolling-window gusts for all history entries
  function computeRollingGusts(entries) {
    const GUST_WINDOW_MS = 10 * 60 * 1000; // 10-minute rolling window
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

  // Check if we need to fetch fresh data (throttle to MIN_FETCH_INTERVAL)
  let current = null;
  let fetchedFresh = false;

  try {
    const cachedCurrent = await env.CACHE.get(currentKey, { type: 'json' });
    const now = Math.floor(Date.now() / 1000);

    if (cachedCurrent && (now - cachedCurrent.ts) < MIN_FETCH_INTERVAL) {
      // Use cached current data
      current = cachedCurrent.data;
      // If history had stale gusts stripped, recompute and save now
      if (historyNeedsRecompute && history.length > 0) {
        history = computeRollingGusts(history);
        await env.CACHE.put(historyKey, JSON.stringify(history), { expirationTtl: 86400 });
      }
    } else {
      // Fetch from WeatherLink
      const resp = await fetch(`${WEATHERLINK_URL}${token}`, {
        signal: AbortSignal.timeout(10000),
        headers: {
          'User-Agent': 'KiteConditions/1.0',
          'Accept': 'application/json',
        },
      });

      if (!resp.ok) throw new Error(`WeatherLink HTTP ${resp.status}`);
      const wlData = await resp.json();

      current = {
        wind: parseFloat(wlData.wind) || 0,
        gust: parseFloat(wlData.gust) || 0,
        wind_dir: wlData.windDirection || 0,
        wind_dir_cardinal: degreesToCardinal(wlData.windDirection || 0),
        temp: parseFloat(wlData.temperature) || null,
        feels_like: parseFloat(wlData.temperatureFeelLike) || null,
        humidity: parseFloat(wlData.humidity) || null,
        hi_temp: parseFloat(wlData.hiTemp) || null,
        lo_temp: parseFloat(wlData.loTemp) || null,
        barometer: wlData.barometer || null,
        barometer_trend: wlData.barometerTrend || null,
        rain: wlData.rain || null,
        wind_units: wlData.windUnits || 'mph',
        temp_units: wlData.tempUnits || '°F',
        last_received: wlData.lastReceived || null,
        station_location: wlData.systemLocation || null,
      };

      fetchedFresh = true;

      // Cache current data
      await env.CACHE.put(currentKey, JSON.stringify({ ts: now, data: current }), {
        expirationTtl: 120,
      });

      // Append to history if it's a genuinely new reading
      const lastReading = history.length > 0 ? history[history.length - 1] : null;
      const readingTs = wlData.lastReceived || (now * 1000);

      // Only add if this is a different timestamp than the last reading
      if (!lastReading || lastReading.ts !== readingTs) {
        // Store the raw wind speed — we'll compute rolling-window gust below
        history.push({
          ts: readingTs,
          wind: current.wind,
          dir: current.wind_dir,
          temp: current.temp,
        });

        // Trim history to HISTORY_HOURS
        const cutoff = Date.now() - (HISTORY_HOURS * 60 * 60 * 1000);
        history = history.filter(h => h.ts > cutoff);

        // Compute per-entry rolling gust: max wind over a ±10-minute window
        // This replaces the stale daily-high gust from the WeatherLink embed API
        history = computeRollingGusts(history);

        // Save updated history to KV (TTL = 24 hours)
        await env.CACHE.put(historyKey, JSON.stringify(history), {
          expirationTtl: 86400,
        });
      }
    }
  } catch (e) {
    // If fetch failed but we have cached data, use it
    if (!current) {
      const cachedCurrent = await env.CACHE.get(currentKey, { type: 'json' });
      if (cachedCurrent) current = cachedCurrent.data;
    }
    if (!current) {
      return Response.json({ error: `Failed to fetch wind data: ${e.message}` }, { status: 502 });
    }
  }

  return Response.json({
    spot_id: spotId,
    spot_name: spot.name,
    current,
    history,
    history_hours: HISTORY_HOURS,
    fetched_fresh: fetchedFresh,
  }, {
    headers: {
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

// ── NDBC handler ─────────────────────────────────────────────────────────────
const MPS_TO_MPH = 2.23694;
const NDBC_HISTORY_HOURS = 6;

async function handleNdbc(stid, spotId, spotName, env) {
  const historyKey = `${HISTORY_KEY_PREFIX}${spotId}`;
  const currentKey = `${CURRENT_KEY_PREFIX}${spotId}`;
  const now = Math.floor(Date.now() / 1000);

  // Check throttle
  let current = null;
  let fetchedFresh = false;

  try {
    const cachedCurrent = await env.CACHE.get(currentKey, { type: 'json' });
    if (cachedCurrent && (now - cachedCurrent.ts) < MIN_FETCH_INTERVAL) {
      current = cachedCurrent.data;
    } else {
      // Fetch NDBC realtime2 txt
      const resp = await fetch(`https://www.ndbc.noaa.gov/data/realtime2/${stid}.txt`, {
        signal: AbortSignal.timeout(10000),
        headers: { 'User-Agent': 'KiteConditions/1.0' },
      });
      if (!resp.ok) throw new Error(`NDBC HTTP ${resp.status}`);
      const text = await resp.text();

      // Parse: skip 2 header lines, take first data line
      const lines = text.trim().split('\n').filter(l => !l.startsWith('#'));
      if (!lines.length) throw new Error('No NDBC data');
      const parts = lines[0].trim().split(/\s+/);
      // Columns: YY MM DD hh mm WDIR WSPD GST WVHT DPD APD MWD PRES ATMP WTMP DEWP VIS PTDY TIDE
      const wdir = parseFloat(parts[5]);
      const wspd = parseFloat(parts[6]); // m/s
      const gst  = parseFloat(parts[7]); // m/s
      const pres = parseFloat(parts[12]);
      const atmp = parseFloat(parts[13]); // °C

      const windMph  = isNaN(wspd) ? 0 : Math.round(wspd * MPS_TO_MPH * 10) / 10;
      const gustMph  = isNaN(gst)  ? windMph : Math.round(gst  * MPS_TO_MPH * 10) / 10;
      const windDeg  = isNaN(wdir) ? 0 : wdir;
      const tempF    = isNaN(atmp) ? null : Math.round(atmp * 9/5 + 32);

      // Build timestamp from data line
      const [yy, mo, dd, hh, mm] = parts.slice(0, 5).map(Number);
      const readingTs = Date.UTC(yy, mo - 1, dd, hh, mm);

      current = {
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
        station_location: `Sand Key (SANF1)`,
      };

      fetchedFresh = true;
      await env.CACHE.put(currentKey, JSON.stringify({ ts: now, data: current }), { expirationTtl: 120 });

      // Append to history
      let history = [];
      try {
        const raw = await env.CACHE.get(historyKey, { type: 'json' });
        if (raw && Array.isArray(raw)) history = raw;
      } catch (e) { /* ignore */ }

      const lastReading = history.length > 0 ? history[history.length - 1] : null;
      if (!lastReading || lastReading.ts !== readingTs) {
        history.push({ ts: readingTs, wind: windMph, gust: gustMph, dir: windDeg, temp: tempF });
        const cutoff = Date.now() - (NDBC_HISTORY_HOURS * 60 * 60 * 1000);
        history = history.filter(h => h.ts > cutoff);
        await env.CACHE.put(historyKey, JSON.stringify(history), { expirationTtl: 86400 });
      }

      let history2 = [];
      try {
        const raw = await env.CACHE.get(historyKey, { type: 'json' });
        if (raw && Array.isArray(raw)) history2 = raw;
      } catch (e) { /* ignore */ }

      return Response.json({
        spot_id: spotId,
        spot_name: spotName,
        current,
        history: history2,
        history_hours: NDBC_HISTORY_HOURS,
        fetched_fresh: fetchedFresh,
      }, { headers: { 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' } });
    }
  } catch (e) {
    if (!current) {
      return Response.json({ error: `NDBC fetch failed: ${e.message}` }, { status: 502 });
    }
  }

  // Served from cache — load history too
  let history = [];
  try {
    const raw = await env.CACHE.get(historyKey, { type: 'json' });
    if (raw && Array.isArray(raw)) history = raw;
  } catch (e) { /* ignore */ }

  return Response.json({
    spot_id: spotId,
    spot_name: spotName,
    current,
    history,
    history_hours: NDBC_HISTORY_HOURS,
    fetched_fresh: false,
  }, { headers: { 'Cache-Control': 'no-cache', 'Access-Control-Allow-Origin': '*' } });
}
// ─────────────────────────────────────────────────────────────────────────────

function degreesToCardinal(deg) {
  if (deg == null || isNaN(deg)) return '?';
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const idx = Math.round(((deg % 360) + 360) % 360 / 22.5) % 16;
  return dirs[idx];
}
