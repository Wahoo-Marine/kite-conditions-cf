/**
 * /api/preferences — Get or update user preferences
 * GET  /api/preferences          — get all preferences
 * POST /api/preferences          — update preferences (body: {key, value})
 */

export async function onRequestGet(context) {
  const { env } = context;
  const { results } = await env.DB.prepare('SELECT key, value FROM preferences').all();
  const prefs = {};
  for (const r of results) prefs[r.key] = r.value;
  return Response.json(prefs);
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const body = await request.json();
  const key = (body.key || '').trim();
  const value = String(body.value || '');

  if (!key) return Response.json({ error: 'Key required' }, { status: 400 });

  await env.DB.prepare(
    "INSERT OR REPLACE INTO preferences (key, value, updated_at) VALUES (?, ?, datetime('now'))"
  ).bind(key, value).run();

  return Response.json({ key, value });
}
