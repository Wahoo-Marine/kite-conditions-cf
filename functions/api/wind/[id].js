/**
 * GET /api/wind/:id
 * Returns live wind data + 6h history for the spot's weather station.
 * Throttles upstream fetches to MIN_FETCH_INTERVAL — between polls we serve
 * the cached current reading and KV-stored history (also populated by the cron).
 */
import {
  HISTORY_HOURS, MIN_FETCH_INTERVAL,
  parseStation, keysFor, loadHistory, getCachedCurrent, pollStation,
} from '../../lib/wind.js';

export async function onRequestGet(context) {
  const { env, params } = context;
  const spotId = params.id;

  const spot = await env.DB.prepare(
    'SELECT id, name, weather_station FROM spots WHERE id = ?'
  ).bind(spotId).first();

  if (!spot) {
    return Response.json({ error: 'Spot not found' }, { status: 404 });
  }
  if (!spot.weather_station) {
    return Response.json({ error: 'No weather station configured for this spot' }, { status: 404 });
  }

  const parsed = parseStation(spot.weather_station);
  const { historyKey, currentKey } = keysFor(parsed.key);
  const now = Math.floor(Date.now() / 1000);

  let current = null;
  let history = [];
  let fetchedFresh = false;

  const cached = await getCachedCurrent(env, currentKey);
  if (cached && (now - cached.ts) < MIN_FETCH_INTERVAL) {
    current = cached.data;
    history = await loadHistory(env, historyKey);
  } else {
    try {
      ({ current, history } = await pollStation(spot.weather_station, env));
      fetchedFresh = true;
    } catch (e) {
      if (cached) {
        current = cached.data;
        history = await loadHistory(env, historyKey);
      } else {
        return Response.json({ error: `Failed to fetch wind data: ${e.message}` }, { status: 502 });
      }
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
