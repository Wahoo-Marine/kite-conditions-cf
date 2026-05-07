/**
 * /api/spots/:id — Update or delete a spot
 * PUT    /api/spots/:id — update (must own it, or be admin for default spots)
 * DELETE /api/spots/:id — delete (must own it, or be admin for default spots)
 */
import { getUserEmail, isAdmin } from '../../lib/auth.js';

function normalizeShortSlug(value) {
  if (value == null || value === '') return null;
  const slug = String(value).trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return slug || null;
}

function isValidShortSlug(slug) {
  return slug == null || /^[a-z0-9](?:[a-z0-9-]{1,30}[a-z0-9])?$/.test(slug);
}

async function ensureShortSlugSchema(env) {
  try { await env.DB.prepare('ALTER TABLE spots ADD COLUMN short_slug TEXT DEFAULT NULL').run(); } catch (e) { /* already exists */ }
  try { await env.DB.prepare('CREATE UNIQUE INDEX IF NOT EXISTS idx_spots_short_slug ON spots(short_slug) WHERE short_slug IS NOT NULL').run(); } catch (e) { /* ignore */ }
}

async function hasShortSlugColumn(env) {
  try {
    const { results } = await env.DB.prepare('PRAGMA table_info(spots)').all();
    return (results || []).some(r => r.name === 'short_slug');
  } catch {
    return false;
  }
}

function canModify(spot, request, env) {
  const email = getUserEmail(request);
  if (!email) return false;
  if (spot.user_id === null) return isAdmin(request, env); // default spot: admin only
  return spot.user_id === email;                           // personal spot: must match
}

export async function onRequestPut(context) {
  const { env, request, params } = context;
  const spotId = params.id;
  const hasSlug = await hasShortSlugColumn(env);

  const spot = await env.DB.prepare('SELECT * FROM spots WHERE id = ?').bind(spotId).first();
  if (!spot) return Response.json({ error: 'Spot not found' }, { status: 404 });
  if (!canModify(spot, request, env)) return Response.json({ error: 'Forbidden' }, { status: 403 });

  const body = await request.json();
  const name = (body.name || '').trim() || spot.name;
  const lat = body.lat != null ? parseFloat(body.lat) : spot.lat;
  const lon = body.lon != null ? parseFloat(body.lon) : spot.lon;
  const webcams = body.webcams != null ? JSON.stringify(body.webcams) : spot.webcams;
  let shortSlug = hasSlug ? spot.short_slug : null;
  if (body.short_slug !== undefined) shortSlug = normalizeShortSlug(body.short_slug);
  const weatherStation = body.weather_station !== undefined ? (body.weather_station || null) : spot.weather_station;

  if (isNaN(lat) || isNaN(lon)) return Response.json({ error: 'Invalid lat/lon' }, { status: 400 });
  if (!isValidShortSlug(shortSlug)) return Response.json({ error: 'Short name must be 3-32 chars: a-z, 0-9, hyphen' }, { status: 400 });

  if (!hasSlug && shortSlug) {
    await ensureShortSlugSchema(env);
    if (!(await hasShortSlugColumn(env))) {
      return Response.json({ error: 'Short names are not available yet; please retry in a minute' }, { status: 503 });
    }
  }

  try {
    if (await hasShortSlugColumn(env)) {
      await env.DB.prepare(
        'UPDATE spots SET name = ?, lat = ?, lon = ?, webcams = ?, short_slug = ?, weather_station = ? WHERE id = ?'
      ).bind(name, lat, lon, webcams, shortSlug, weatherStation, spotId).run();
    } else {
      await env.DB.prepare(
        'UPDATE spots SET name = ?, lat = ?, lon = ?, webcams = ?, weather_station = ? WHERE id = ?'
      ).bind(name, lat, lon, webcams, weatherStation, spotId).run();
      shortSlug = null;
    }
  } catch (e) {
    if ((e.message || '').toLowerCase().includes('unique')) {
      return Response.json({ error: 'That short name is already in use' }, { status: 409 });
    }
    throw e;
  }

  return Response.json({ id: spotId, name, lat, lon, webcams: JSON.parse(webcams), short_slug: shortSlug, weather_station: weatherStation });
}

export async function onRequestDelete(context) {
  const { env, request, params } = context;
  const spot = await env.DB.prepare('SELECT * FROM spots WHERE id = ?').bind(params.id).first();
  if (!spot) return Response.json({ error: 'Spot not found' }, { status: 404 });
  if (!canModify(spot, request, env)) return Response.json({ error: 'Forbidden' }, { status: 403 });

  await env.DB.prepare('DELETE FROM spots WHERE id = ?').bind(params.id).run();
  return Response.json({ ok: true });
}
