/**
 * POST /api/spots/copy-defaults
 * Copies all default spots (user_id IS NULL) into the current user's account.
 * Only works if the user has no personal spots yet (safe one-time bootstrap).
 */
import { getUserEmail } from '../../lib/auth.js';

export async function onRequestPost(context) {
  const { env, request } = context;
  const email = getUserEmail(request);
  if (!email) return Response.json({ error: 'Authentication required' }, { status: 401 });

  // Prevent overwriting existing personal spots
  const existing = await env.DB.prepare(
    'SELECT COUNT(*) as c FROM spots WHERE user_id = ?'
  ).bind(email).first();
  if (existing.c > 0) {
    return Response.json({ error: 'You already have personal spots' }, { status: 400 });
  }

  // Fetch defaults
  const { results: defaults } = await env.DB.prepare(
    'SELECT name, lat, lon, webcams, weather_station, sort_order FROM spots WHERE user_id IS NULL ORDER BY sort_order, rowid'
  ).all();
  if (defaults.length === 0) {
    return Response.json({ error: 'No default spots to copy' }, { status: 404 });
  }

  const stmt = env.DB.prepare(
    'INSERT INTO spots (id, name, lat, lon, webcams, weather_station, sort_order, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  for (const spot of defaults) {
    const id = crypto.randomUUID().slice(0, 8);
    await stmt.bind(id, spot.name, spot.lat, spot.lon, spot.webcams, spot.weather_station, spot.sort_order, email).run();
  }

  return Response.json({ copied: defaults.length });
}
