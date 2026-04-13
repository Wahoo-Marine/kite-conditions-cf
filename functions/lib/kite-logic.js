/**
 * Kite Conditions — shared logic
 * Ported from Python kite_web.py
 */

export const WIND_IDEAL_MIN = 15;
export const WIND_IDEAL_MAX = 30;
export const WIND_MARGINAL_MIN = 12;
export const WIND_MARGINAL_MAX = 35;

export const OPEN_METEO_URL = 'https://api.open-meteo.com/v1/forecast';
export const MARINE_API_URL = 'https://marine-api.open-meteo.com/v1/marine';
export const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';

export const HOURLY_PARAMS = [
  'temperature_2m',
  'apparent_temperature',
  'wind_speed_10m',
  'wind_direction_10m',
  'wind_gusts_10m',
  'weather_code',
  'is_day',
];

export const DAILY_PARAMS = [
  'sunrise',
  'sunset',
  'daylight_duration',
  'temperature_2m_max',
  'temperature_2m_min',
  'wind_speed_10m_max',
  'wind_gusts_10m_max',
  'wind_direction_10m_dominant',
];

export const WMO_CODES = {
  0: 'Clear', 1: 'Mostly Clear', 2: 'Partly Cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Rime Fog',
  51: 'Light Drizzle', 53: 'Drizzle', 55: 'Heavy Drizzle',
  61: 'Light Rain', 63: 'Rain', 65: 'Heavy Rain',
  71: 'Light Snow', 73: 'Snow', 75: 'Heavy Snow',
  80: 'Light Showers', 81: 'Showers', 82: 'Heavy Showers',
  95: 'Thunderstorm', 96: 'T-storm + Hail', 99: 'T-storm + Heavy Hail',
};

export const WMO_ICONS = {
  0: '☀️', 1: '🌤️', 2: '⛅', 3: '☁️',
  45: '🌫️', 48: '🌫️',
  51: '🌦️', 53: '🌧️', 55: '🌧️',
  61: '🌧️', 63: '🌧️', 65: '🌧️',
  71: '🌨️', 73: '🌨️', 75: '🌨️',
  80: '🌦️', 81: '🌧️', 82: '⛈️',
  95: '⛈️', 96: '⛈️', 99: '⛈️',
};

const COMPASS = [
  'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
  'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
];

export function degreesToCompass(deg) {
  if (deg == null) return '?';
  const idx = Math.round(deg / 22.5) % 16;
  return COMPASS[idx];
}

export function kiteRating(windMph) {
  if (windMph == null) return 'unknown';
  if (windMph >= WIND_IDEAL_MIN && windMph <= WIND_IDEAL_MAX) return 'send-it';
  if (windMph >= WIND_MARGINAL_MIN && windMph < WIND_IDEAL_MIN) return 'maybe';
  if (windMph > WIND_IDEAL_MAX && windMph <= WIND_MARGINAL_MAX) return 'maybe';
  return 'nope';
}

export function dayKiteRating(daylightWinds, daylightGusts) {
  if (!daylightWinds || daylightWinds.length === 0) return 'unknown';

  const total = daylightWinds.length;
  const ideal = daylightWinds.filter(w => w >= WIND_IDEAL_MIN && w <= WIND_IDEAL_MAX).length;
  const rideable = daylightWinds.filter(w => w >= WIND_MARGINAL_MIN && w <= WIND_MARGINAL_MAX).length;
  const avgWind = daylightWinds.reduce((a, b) => a + b, 0) / total;

  const maxGust = daylightGusts && daylightGusts.length > 0
    ? Math.max(...daylightGusts) : 0;
  const gustFactor = avgWind > 0 ? maxGust / avgWind : 0;

  if (rideable < total * 0.5 || maxGust > WIND_MARGINAL_MAX) return 'nope';
  if (ideal === total && gustFactor <= 1.5) return 'send-it';
  if (rideable >= total * 0.6) return 'maybe';
  return 'nope';
}

export function ratingLabel(rating) {
  return { 'send-it': 'SEND IT', maybe: 'MAYBE', nope: 'NOPE', unknown: '?' }[rating] || '?';
}

export function ratingEmoji(rating) {
  return { 'send-it': '🟢', maybe: '🟡', nope: '🔴', unknown: '⚪' }[rating] || '⚪';
}

export function weatherDesc(code) {
  return WMO_CODES[code] || `Code ${code}`;
}

export function weatherIcon(code) {
  return WMO_ICONS[code] || '🌡️';
}

/** Cache TTL in seconds */
export const CACHE_TTL = 900; // 15 minutes

/**
 * Fetch forecast from Open-Meteo, caching in KV.
 * Returns { data, cacheAge } where cacheAge=0 means fresh.
 */
export async function fetchForecast(lat, lon, kvCache) {
  const cacheKey = `forecast:${lat.toFixed(4)},${lon.toFixed(4)}`;

  // Try KV cache
  if (kvCache) {
    const cached = await kvCache.get(cacheKey, { type: 'json' });
    if (cached) {
      const age = Math.floor(Date.now() / 1000) - cached.ts;
      if (age < CACHE_TTL) {
        return { data: cached.data, cacheAge: age };
      }
    }
  }

  // Fetch from Open-Meteo with retry
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    hourly: HOURLY_PARAMS.join(','),
    daily: DAILY_PARAMS.join(','),
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    timezone: 'auto',
    forecast_days: 16,
  });

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) await new Promise(r => setTimeout(r, 2 ** attempt * 1000));
      const resp = await fetch(`${OPEN_METEO_URL}?${params}`, {
        signal: AbortSignal.timeout(30000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();

      // Store in KV with TTL
      if (kvCache) {
        await kvCache.put(cacheKey, JSON.stringify({ ts: Math.floor(Date.now() / 1000), data }), {
          expirationTtl: CACHE_TTL * 2,
        });
      }

      return { data, cacheAge: 0 };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/**
 * Process raw Open-Meteo data into structured day+hourly format.
 * startDate and endDate are ISO date strings (YYYY-MM-DD).
 */
export function processForecast(rawData, startDate, endDate) {
  const hourly = rawData.hourly;
  const daily = rawData.daily;
  const times = hourly.time;

  // Build requested date set
  const reqDates = new Set();
  if (startDate && endDate) {
    let d = new Date(startDate + 'T00:00:00');
    const end = new Date(endDate + 'T00:00:00');
    while (d <= end) {
      reqDates.add(d.toISOString().slice(0, 10));
      d.setDate(d.getDate() + 1);
    }
  }

  // Group hours by date
  const daysMap = new Map();
  for (let i = 0; i < times.length; i++) {
    const dateStr = times[i].slice(0, 10);
    if (reqDates.size > 0 && !reqDates.has(dateStr)) continue;
    if (!daysMap.has(dateStr)) daysMap.set(dateStr, []);
    daysMap.get(dateStr).push(i);
  }

  // Daily index lookup
  const dailyDates = daily.time || [];
  const dailyIdxMap = {};
  dailyDates.forEach((d, i) => { dailyIdxMap[d] = i; });

  const days = [];

  for (const [dateStr, hourIndices] of daysMap) {
    const dayIdx = dailyIdxMap[dateStr];
    const dt = new Date(dateStr + 'T00:00:00');

    let sunrise = '?', sunset = '?', hi = null, lo = null;
    let maxWind = null, maxGust = null, domDirDeg = null;

    if (dayIdx != null) {
      sunrise = daily.sunrise[dayIdx]?.slice(-5) || '?';
      sunset = daily.sunset[dayIdx]?.slice(-5) || '?';
      hi = daily.temperature_2m_max[dayIdx];
      lo = daily.temperature_2m_min[dayIdx];
      maxWind = daily.wind_speed_10m_max[dayIdx];
      maxGust = daily.wind_gusts_10m_max[dayIdx];
      domDirDeg = daily.wind_direction_10m_dominant[dayIdx];
    }

    const hours = [];
    const daylightWinds = [];
    const daylightGusts = [];
    const daylightTemps = [];

    for (const i of hourIndices) {
      if (!hourly.is_day[i]) continue;
      const wind = hourly.wind_speed_10m[i];
      const gust = hourly.wind_gusts_10m[i];
      const temp = hourly.temperature_2m[i];
      if (wind != null) daylightWinds.push(wind);
      if (gust != null) daylightGusts.push(gust);
      if (temp != null) daylightTemps.push(temp);
      hours.push({
        time: times[i].slice(-5),
        temp: temp != null ? Math.round(temp) : null,
        feels: hourly.apparent_temperature[i] != null ? Math.round(hourly.apparent_temperature[i]) : null,
        wind: wind != null ? Math.round(wind) : null,
        gust: gust != null ? Math.round(gust) : null,
        dir: degreesToCompass(hourly.wind_direction_10m[i]),
        sky: weatherDesc(hourly.weather_code[i]),
        sky_icon: weatherIcon(hourly.weather_code[i]),
        rating: kiteRating(wind),
      });
    }

    const avgWind = daylightWinds.length > 0
      ? Math.round(daylightWinds.reduce((a, b) => a + b, 0) / daylightWinds.length)
      : null;
    const avgTemp = daylightTemps.length > 0
      ? Math.round(daylightTemps.reduce((a, b) => a + b, 0) / daylightTemps.length)
      : null;

    const rating = dayKiteRating(daylightWinds, daylightGusts);
    let gustFactor = null, gustPct = null;
    if (avgWind && daylightGusts.length > 0) {
      gustFactor = Math.round((Math.max(...daylightGusts) / (daylightWinds.reduce((a, b) => a + b, 0) / daylightWinds.length)) * 10) / 10;
      gustPct = Math.round((gustFactor - 1) * 100);
    }

    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const dayNamesFull = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    days.push({
      date: dateStr,
      day_name: dayNamesFull[dt.getDay()],
      day_short: dayNames[dt.getDay()],
      month_day: `${monthNames[dt.getMonth()]} ${String(dt.getDate()).padStart(2, '0')}`,
      sunrise, sunset,
      hi: hi != null ? Math.round(hi) : null,
      lo: lo != null ? Math.round(lo) : null,
      avg_temp: avgTemp,
      max_wind: maxWind != null ? Math.round(maxWind) : null,
      avg_wind: avgWind,
      max_gust: maxGust != null ? Math.round(maxGust) : null,
      gust_factor: gustFactor,
      gust_pct: gustPct,
      dom_dir: degreesToCompass(domDirDeg),
      rating,
      rating_label: ratingLabel(rating),
      rating_emoji: ratingEmoji(rating),
      hours,
    });
  }

  return days;
}

/* ────────────────────────────────────────
 * Tides  (Open-Meteo Marine API)
 * ──────────────────────────────────────── */

/**
 * Fetch tide data (sea_level_height_msl) from Open-Meteo Marine API.
 * Returns { data, cacheAge }.
 */
export async function fetchTides(lat, lon, kvCache) {
  const cacheKey = `tides:${lat.toFixed(4)},${lon.toFixed(4)}`;

  if (kvCache) {
    const cached = await kvCache.get(cacheKey, { type: 'json' });
    if (cached) {
      const age = Math.floor(Date.now() / 1000) - cached.ts;
      if (age < CACHE_TTL) {
        return { data: cached.data, cacheAge: age };
      }
    }
  }

  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    hourly: 'sea_level_height_msl',
    timezone: 'auto',
    forecast_days: 16,
  });

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (attempt > 0) await new Promise(r => setTimeout(r, 2 ** attempt * 1000));
      const resp = await fetch(`${MARINE_API_URL}?${params}`, {
        signal: AbortSignal.timeout(15000),
      });
      if (!resp.ok) throw new Error(`Marine HTTP ${resp.status}`);
      const data = await resp.json();

      if (kvCache) {
        await kvCache.put(cacheKey, JSON.stringify({ ts: Math.floor(Date.now() / 1000), data }), {
          expirationTtl: CACHE_TTL * 2,
        });
      }
      return { data, cacheAge: 0 };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

/**
 * Process raw marine data into per-day tide info.
 * Returns array of { date, hourly: [{time,level}], extremes: [{time,level,type:'H'|'L'}] }
 */
export function processTides(rawMarine, startDate, endDate) {
  const times = rawMarine?.hourly?.time || [];
  const levels = rawMarine?.hourly?.sea_level_height_msl || [];

  if (times.length === 0) return [];

  // Build requested date set
  const reqDates = new Set();
  if (startDate && endDate) {
    let d = new Date(startDate + 'T00:00:00');
    const end = new Date(endDate + 'T00:00:00');
    while (d <= end) {
      reqDates.add(d.toISOString().slice(0, 10));
      d.setDate(d.getDate() + 1);
    }
  }

  // Group by date
  const daysMap = new Map();
  for (let i = 0; i < times.length; i++) {
    const level = levels[i];
    if (level == null) continue;
    const dateStr = times[i].slice(0, 10);
    if (reqDates.size > 0 && !reqDates.has(dateStr)) continue;
    if (!daysMap.has(dateStr)) daysMap.set(dateStr, []);
    daysMap.get(dateStr).push({ time: times[i].slice(11, 16), level, idx: i });
  }

  const result = [];

  for (const [dateStr, entries] of daysMap) {
    // Hourly readings for chart
    const hourly = entries.map(e => ({ time: e.time, level: +(e.level.toFixed(2)) }));

    // Find local extremes (H/L) — simple peak/trough detection
    const extremes = [];
    for (let i = 1; i < entries.length - 1; i++) {
      const prev = entries[i - 1].level;
      const curr = entries[i].level;
      const next = entries[i + 1].level;

      if (curr >= prev && curr >= next && curr !== prev) {
        extremes.push({ time: entries[i].time, level: +(curr.toFixed(2)), type: 'H' });
      } else if (curr <= prev && curr <= next && curr !== prev) {
        extremes.push({ time: entries[i].time, level: +(curr.toFixed(2)), type: 'L' });
      }
    }

    // Also check first and last hour against neighbors from adjacent days
    // (edge detection) — keep it simple: just mark if clearly a peak/trough
    if (entries.length >= 2) {
      const first = entries[0], second = entries[1];
      if (first.level > second.level) {
        extremes.unshift({ time: first.time, level: +(first.level.toFixed(2)), type: 'H' });
      } else if (first.level < second.level) {
        extremes.unshift({ time: first.time, level: +(first.level.toFixed(2)), type: 'L' });
      }

      const last = entries[entries.length - 1], secondLast = entries[entries.length - 2];
      if (last.level > secondLast.level) {
        extremes.push({ time: last.time, level: +(last.level.toFixed(2)), type: 'H' });
      } else if (last.level < secondLast.level) {
        extremes.push({ time: last.time, level: +(last.level.toFixed(2)), type: 'L' });
      }
    }

    // Deduplicate extremes (no consecutive same-type)
    const cleaned = [];
    for (const e of extremes) {
      if (cleaned.length === 0 || cleaned[cleaned.length - 1].type !== e.type) {
        cleaned.push(e);
      }
    }

    result.push({ date: dateStr, hourly, extremes: cleaned });
  }

  return result;
}

/**
 * Find "current" conditions from hourly data (closest past hour to now).
 */
export function getCurrentConditions(rawData) {
  const hourly = rawData.hourly;
  const times = hourly.time;
  const now = new Date();
  const nowStr = now.toISOString().slice(0, 13) + ':00'; // YYYY-MM-DDTHH:00

  let idx = null;
  for (let i = 0; i < times.length; i++) {
    if (times[i] <= nowStr) idx = i;
  }

  if (idx == null) return null;

  return {
    time: times[idx].slice(-5),
    temp: hourly.temperature_2m[idx] != null ? Math.round(hourly.temperature_2m[idx]) : null,
    feels: hourly.apparent_temperature[idx] != null ? Math.round(hourly.apparent_temperature[idx]) : null,
    wind: hourly.wind_speed_10m[idx] != null ? Math.round(hourly.wind_speed_10m[idx]) : null,
    gust: hourly.wind_gusts_10m[idx] != null ? Math.round(hourly.wind_gusts_10m[idx]) : null,
    dir: degreesToCompass(hourly.wind_direction_10m[idx]),
    sky: weatherDesc(hourly.weather_code[idx]),
    sky_icon: weatherIcon(hourly.weather_code[idx]),
    rating: kiteRating(hourly.wind_speed_10m[idx]),
    is_day: hourly.is_day[idx],
  };
}
