/**
 * GET /api/spot/:id?offset=0&days=7
 * Returns forecast + current conditions for a single spot.
 */
import {
  fetchForecast, processForecast, getCurrentConditions,
  fetchTides, processTides,
} from '../../lib/kite-logic.js';

export async function onRequestGet(context) {
  const { env, request, params } = context;
  const url = new URL(request.url);
  const spotId = params.id;

  const offset = Math.max(0, Math.min(parseInt(url.searchParams.get('offset') || '0') || 0, 15));
  const numDays = Math.max(1, Math.min(parseInt(url.searchParams.get('days') || '7') || 7, 16 - offset));

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() + offset);
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + numDays - 1);

  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);

  // Load spot from D1
  const spot = await env.DB.prepare(
    'SELECT id, name, lat, lon, webcams, weather_station FROM spots WHERE id = ?'
  ).bind(spotId).first();

  if (!spot) {
    return Response.json({ error: 'Spot not found' }, { status: 404 });
  }

  const webcams = JSON.parse(spot.webcams || '[]');
  let current = null;
  let days = [];
  let error = null;
  let cacheAge = 0;
  let tz = '';

  let tides = [];

  try {
    // Fetch weather and tides in parallel
    const [forecastResult, tidesResult] = await Promise.allSettled([
      fetchForecast(spot.lat, spot.lon, env.CACHE),
      fetchTides(spot.lat, spot.lon, env.CACHE),
    ]);

    if (forecastResult.status === 'fulfilled') {
      cacheAge = forecastResult.value.cacheAge;
      tz = forecastResult.value.data.timezone || 'UTC';
      days = processForecast(forecastResult.value.data, startStr, endStr);
      current = getCurrentConditions(forecastResult.value.data);
    } else {
      error = forecastResult.reason?.message || 'Forecast fetch failed';
    }

    if (tidesResult.status === 'fulfilled') {
      tides = processTides(tidesResult.value.data, startStr, endStr);
      // Merge tide data into matching days
      const tideMap = {};
      tides.forEach(t => { tideMap[t.date] = t; });
      days.forEach(d => {
        const td = tideMap[d.date];
        d.tide = td ? { hourly: td.hourly, extremes: td.extremes } : null;
      });
    }
  } catch (e) {
    error = e.message;
  }

  return Response.json({
    spot: {
      id: spot.id,
      name: spot.name,
      lat: spot.lat,
      lon: spot.lon,
      timezone: tz,
      webcams,
      weather_station: !!spot.weather_station,
      error,
      days,
    },
    current,
    generated: new Date().toLocaleString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    }),
    cache_age: Math.round(cacheAge),
    all_cached: cacheAge > 0,
    num_days: numDays,
    start_offset: offset,
  });
}
