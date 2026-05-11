/**
 * /api/preferences — Global preferences (admin-only writes)
 * GET  /api/preferences          — get all preferences (public read)
 * POST /api/preferences          — update a preference (admin only)
 *   body: {key, value}           key must be in ALLOWED_KEYS
 */
import { isAdmin } from '../lib/auth.js';

const ALLOWED_KEYS = new Set(['default_days', 'default_offset']);
const MAX_VALUE_LEN = 256;

export async function onRequestGet(context) {
  const { env } = context;
  try {
    const { results } = await env.DB.prepare('SELECT key, value FROM preferences').all();
    const prefs = {};
    for (const r of results) prefs[r.key] = r.value;
    return Response.json(prefs);
  } catch (e) {
    return Response.json({ error: 'Failed to load preferences' }, { status: 500 });
  }
}

export async function onRequestPost(context) {
  const { env, request } = context;

  if (!(await isAdmin(request, env))) {
    return Response.json({ error: 'Admin required' }, { status: 403 });
  }

  const body = await request.json();
  const key = (body.key || '').trim();
  const value = String(body.value ?? '');

  if (!ALLOWED_KEYS.has(key)) {
    return Response.json({ error: 'Unknown preference key' }, { status: 400 });
  }
  if (value.length > MAX_VALUE_LEN) {
    return Response.json({ error: `Value exceeds ${MAX_VALUE_LEN} chars` }, { status: 400 });
  }

  await env.DB.prepare(
    "INSERT OR REPLACE INTO preferences (key, value, updated_at) VALUES (?, ?, datetime('now'))"
  ).bind(key, value).run();

  return Response.json({ key, value });
}
