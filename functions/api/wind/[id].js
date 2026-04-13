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
  const historyKey = `${HISTORY_KEY_PREFIX}${spotId}`;
  const currentKey = `${CURRENT_KEY_PREFIX}${spotId}`;

  // Load existing history from KV
  let history = [];
  try {
    const raw = await env.CACHE.get(historyKey, { type: 'json' });
    if (raw && Array.isArray(raw)) history = raw;
  } catch (e) { /* ignore */ }

  // Check if we need to fetch fresh data (throttle to MIN_FETCH_INTERVAL)
  let current = null;
  let fetchedFresh = false;

  try {
    const cachedCurrent = await env.CACHE.get(currentKey, { type: 'json' });
    const now = Math.floor(Date.now() / 1000);

    if (cachedCurrent && (now - cachedCurrent.ts) < MIN_FETCH_INTERVAL) {
      // Use cached current data
      current = cachedCurrent.data;
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
        history.push({
          ts: readingTs,
          wind: current.wind,
          gust: current.gust,
          dir: current.wind_dir,
          temp: current.temp,
        });

        // Trim history to HISTORY_HOURS
        const cutoff = Date.now() - (HISTORY_HOURS * 60 * 60 * 1000);
        history = history.filter(h => h.ts > cutoff);

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

function degreesToCardinal(deg) {
  if (deg == null || isNaN(deg)) return '?';
  const dirs = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
                'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  const idx = Math.round(((deg % 360) + 360) % 360 / 22.5) % 16;
  return dirs[idx];
}
