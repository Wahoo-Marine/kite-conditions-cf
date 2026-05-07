/**
 * GET /*
 * Resolve one-segment short spot slugs (e.g. /turks) to share-mode spot page.
 * Falls through to normal Pages/static routing for everything else.
 */

const RESERVED = new Set(['api', 'share', 'settings', 'cam', 'spot.html', 'index.html', 'styles.css', 'spot.js', 'favicon.ico']);

function normalizeShortSlug(value) {
  if (!value) return null;
  const slug = String(value).trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return slug || null;
}

function fallbackResponse(context) {
  if (typeof context.next === 'function') return context.next();
  return new Response('Not found', { status: 404 });
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
    const first = full ? full.split('-')[0] : null;
    return slug === full || slug === first;
  });
}

export async function onRequest(context) {
  try {
    const { env, request } = context;
    if (request.method !== 'GET') return fallbackResponse(context);

    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/+|\/+$/g, '');
    if (!path || path.includes('/')) return fallbackResponse(context);

    const slug = decodeURIComponent(path).toLowerCase();
    if (!slug || RESERVED.has(slug) || slug.includes('.')) return fallbackResponse(context);

    let hasSlug = await hasShortSlugColumn(env);
    if (!hasSlug) {
      await ensureShortSlugSchema(env);
      hasSlug = await hasShortSlugColumn(env);
    }

    if (hasSlug) {
      const spot = await env.DB.prepare(
        `SELECT id
         FROM spots
         WHERE short_slug = ?
         ORDER BY CASE WHEN user_id IS NULL THEN 0 ELSE 1 END, rowid
         LIMIT 1`
      ).bind(slug).first();

      if (spot) {
        url.pathname = '/spot.html';
        url.search = `id=${encodeURIComponent(spot.id)}&share=1`;
        return Response.redirect(url.toString(), 302);
      }
    }

    const { results } = await env.DB.prepare('SELECT id, name FROM spots WHERE user_id IS NULL ORDER BY sort_order, rowid').all();
    const match = fallbackNameMatch(results, slug);
    if (!match) return fallbackResponse(context);

    url.pathname = '/spot.html';
    url.search = `id=${encodeURIComponent(match.id)}&share=1`;
    return Response.redirect(url.toString(), 302);
  } catch {
    return fallbackResponse(context);
  }
}
