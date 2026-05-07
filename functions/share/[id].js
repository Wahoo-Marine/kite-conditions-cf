/**
 * GET /share/:id
 *
 * Share-link route that resolves by spot id or short slug and reuses
 * the main spot page implementation in share mode.
 */

function normalizeShortSlug(value) {
  if (!value) return null;
  const slug = String(value).trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return slug || null;
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

function fallbackNameMatch(results, slug) {
  return (results || []).find(r => {
    const full = normalizeShortSlug(r.name);
    if (!full) return false;
    const tokens = full.split('-').filter(Boolean);
    return slug === full || tokens.includes(slug);
  });
}

export async function onRequestGet(context) {
  const { env, request, params } = context;
  const url = new URL(request.url);

  const raw = String(params.id || '').trim();
  if (!raw) return new Response('Spot not found', { status: 404 });

  let spot = await env.DB.prepare('SELECT id FROM spots WHERE id = ? LIMIT 1').bind(raw).first();

  if (!spot) {
    const slug = normalizeShortSlug(raw);
    let hasSlug = await hasShortSlugColumn(env);
    if (!hasSlug) {
      await ensureShortSlugSchema(env);
      hasSlug = await hasShortSlugColumn(env);
    }

    if (hasSlug) {
      spot = await env.DB.prepare(
        `SELECT id
         FROM spots
         WHERE short_slug = ?
         ORDER BY CASE WHEN user_id IS NULL THEN 0 ELSE 1 END, rowid
         LIMIT 1`
      ).bind(slug).first();
    }

    if (!spot) {
      const { results } = await env.DB.prepare('SELECT id, name FROM spots WHERE user_id IS NULL ORDER BY sort_order, rowid').all();
      spot = fallbackNameMatch(results, slug) || null;
    }
  }

  if (!spot) return new Response('Spot not found', { status: 404 });

  url.pathname = '/spot.html';
  url.search = `id=${encodeURIComponent(spot.id)}&share=1`;
  return Response.redirect(url.toString(), 302);
}
