/**
 * /api/spots — CRUD operations for kite spots (user-scoped)
 * GET  /api/spots               — list spots (user's own, or defaults as fallback)
 *   ?source=mine                — user's personal spots only (may be empty array)
 *   ?source=defaults            — default spots only (admin use)
 * POST /api/spots               — add a new personal spot
 *   body.is_default=true        — admin only: save as a default spot (user_id=NULL)
 */
import { getUserEmail, isAdmin } from '../lib/auth.js';

function normalizeShortSlug(value) {
  if (!value) return null;
  const slug = String(value).trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return slug || null;
}

function isValidShortSlug(slug) {
  return slug == null || /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/.test(slug);
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const source = url.searchParams.get('source'); // 'mine' | 'defaults' | null
  const email = await getUserEmail(request, env);

  let results;

  if (source === 'defaults') {
    // Explicitly requesting defaults (admin view)
    ({ results } = await env.DB.prepare(
      'SELECT id, name, lat, lon, webcams, short_slug, weather_station, sort_order FROM spots WHERE user_id IS NULL ORDER BY sort_order, rowid'
    ).all());
  } else if (source === 'mine') {
    // Settings page: return only personal spots — never fall back to defaults
    if (!email) return Response.json([]);
    ({ results } = await env.DB.prepare(
      'SELECT id, name, lat, lon, webcams, short_slug, weather_station, sort_order FROM spots WHERE user_id = ? ORDER BY sort_order, rowid'
    ).bind(email).all());
  } else if (!email) {
    // Unauthenticated dashboard: show defaults
    ({ results } = await env.DB.prepare(
      'SELECT id, name, lat, lon, webcams, short_slug, weather_station, sort_order FROM spots WHERE user_id IS NULL ORDER BY sort_order, rowid'
    ).all());
  } else {
    // Authenticated dashboard: user's spots, or fall back to defaults
    const personal = await env.DB.prepare(
      'SELECT id, name, lat, lon, webcams, short_slug, weather_station, sort_order FROM spots WHERE user_id = ? ORDER BY sort_order, rowid'
    ).bind(email).all();
    if (personal.results.length > 0) {
      results = personal.results;
    } else {
      ({ results } = await env.DB.prepare(
        'SELECT id, name, lat, lon, webcams, short_slug, weather_station, sort_order FROM spots WHERE user_id IS NULL ORDER BY sort_order, rowid'
      ).all());
    }
  }

  return Response.json(results.map(r => ({
    ...r,
    webcams: JSON.parse(r.webcams || '[]'),
    weather_station: r.weather_station || null,
  })));
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const email = await getUserEmail(request, env);
  if (!email) return Response.json({ error: 'Authentication required' }, { status: 401 });

  const body = await request.json();

  // Admin can create default spots (user_id=NULL); everyone else gets user_id=email
  const userId = (body.is_default && await isAdmin(request, env)) ? null : email;

  const name = (body.name || '').trim();
  const lat = parseFloat(body.lat);
  const lon = parseFloat(body.lon);
  const webcams = body.webcams || [];
  const shortSlug = normalizeShortSlug(body.short_slug);
  const weatherStation = body.weather_station || null;

  if (!name) return Response.json({ error: 'Name is required' }, { status: 400 });
  if (isNaN(lat) || isNaN(lon)) return Response.json({ error: 'Invalid lat/lon' }, { status: 400 });
  if (!isValidShortSlug(shortSlug)) return Response.json({ error: 'Short name must be 3-32 chars: a-z, 0-9, hyphen' }, { status: 400 });

  const id = crypto.randomUUID().slice(0, 8);

  // Max sort_order within the same ownership scope
  let maxRow;
  if (userId) {
    maxRow = await env.DB.prepare(
      'SELECT MAX(sort_order) as m FROM spots WHERE user_id = ?'
    ).bind(userId).first();
  } else {
    maxRow = await env.DB.prepare(
      'SELECT MAX(sort_order) as m FROM spots WHERE user_id IS NULL'
    ).first();
  }
  const sortOrder = (maxRow?.m ?? -1) + 1;

  const webcamsJson = JSON.stringify(webcams);

  try {
    await env.DB.prepare(
      'INSERT INTO spots (id, name, lat, lon, webcams, short_slug, weather_station, sort_order, user_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
    ).bind(id, name, lat, lon, webcamsJson, shortSlug, weatherStation, sortOrder, userId).run();
  } catch (e) {
    if ((e.message || '').toLowerCase().includes('unique')) {
      return Response.json({ error: 'That short name is already in use' }, { status: 409 });
    }
    throw e;
  }

  return Response.json({ id, name, lat, lon, webcams, short_slug: shortSlug, weather_station: weatherStation, sort_order: sortOrder }, { status: 201 });
}
