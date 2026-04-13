/**
 * /api/spots/:id — Update or delete a spot
 * PUT    /api/spots/:id — update a spot
 * DELETE /api/spots/:id — delete a spot
 */

export async function onRequestPut(context) {
  const { env, request, params } = context;
  const spotId = params.id;
  const body = await request.json();

  const spot = await env.DB.prepare('SELECT * FROM spots WHERE id = ?').bind(spotId).first();
  if (!spot) return Response.json({ error: 'Spot not found' }, { status: 404 });

  const name = (body.name || '').trim() || spot.name;
  const lat = body.lat != null ? parseFloat(body.lat) : spot.lat;
  const lon = body.lon != null ? parseFloat(body.lon) : spot.lon;
  const webcams = body.webcams != null ? JSON.stringify(body.webcams) : spot.webcams;
  const weatherStation = body.weather_station !== undefined ? (body.weather_station || null) : spot.weather_station;

  if (isNaN(lat) || isNaN(lon)) return Response.json({ error: 'Invalid lat/lon' }, { status: 400 });

  await env.DB.prepare(
    'UPDATE spots SET name = ?, lat = ?, lon = ?, webcams = ?, weather_station = ? WHERE id = ?'
  ).bind(name, lat, lon, webcams, weatherStation, spotId).run();

  return Response.json({ id: spotId, name, lat, lon, webcams: JSON.parse(webcams), weather_station: weatherStation });
}

export async function onRequestDelete(context) {
  const { env, params } = context;
  await env.DB.prepare('DELETE FROM spots WHERE id = ?').bind(params.id).run();
  return Response.json({ ok: true });
}
