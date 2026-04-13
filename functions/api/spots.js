/**
 * /api/spots — CRUD operations for kite spots
 * GET  /api/spots          — list all spots
 * POST /api/spots          — add a new spot
 */

export async function onRequestGet(context) {
  const { env } = context;
  const { results } = await env.DB.prepare(
    'SELECT id, name, lat, lon, webcams, sort_order FROM spots ORDER BY sort_order, rowid'
  ).all();

  const spots = results.map(r => ({
    ...r,
    webcams: JSON.parse(r.webcams || '[]'),
  }));

  return Response.json(spots);
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const body = await request.json();
  const name = (body.name || '').trim();
  const lat = parseFloat(body.lat);
  const lon = parseFloat(body.lon);
  const webcams = body.webcams || [];

  if (!name) return Response.json({ error: 'Name is required' }, { status: 400 });
  if (isNaN(lat) || isNaN(lon)) return Response.json({ error: 'Invalid lat/lon' }, { status: 400 });

  const id = crypto.randomUUID().slice(0, 8);

  // Get max sort_order
  const maxRow = await env.DB.prepare('SELECT MAX(sort_order) as m FROM spots').first();
  const sortOrder = (maxRow?.m ?? -1) + 1;

  const webcamsJson = JSON.stringify(webcams);

  await env.DB.prepare(
    'INSERT INTO spots (id, name, lat, lon, webcams, sort_order) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id, name, lat, lon, webcamsJson, sortOrder).run();

  return Response.json({ id, name, lat, lon, webcams, sort_order: sortOrder }, { status: 201 });
}
