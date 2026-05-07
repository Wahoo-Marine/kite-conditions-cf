/**
 * Global middleware for clean public short URLs:
 *   /turks -> /spot.html?id=<spotId>&share=1
 */

const RESERVED = new Set([
  'api', 'share', 'settings', 'cam',
  'spot.html', 'index.html', 'styles.css', 'spot.js', 'favicon.ico',
]);

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
    const first = full ? full.split('-')[0] : null;
    return slug === full || slug === first;
  });
}

export async function onRequest(context) {
  const { env, request } = context;

  if (request.method !== 'GET') return context.next();

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/+|\/+$/g, '');

  // Only handle clean single-segment paths like /turks
  if (!path || path.includes('/')) return context.next();

  const slug = decodeURIComponent(path).toLowerCase();
  if (!slug || RESERVED.has(slug) || slug.includes('.')) return context.next();

  try {
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

    // Fallback for pre-migration rows: match normalized default spot names
    const { results } = await env.DB.prepare('SELECT id, name FROM spots WHERE user_id IS NULL ORDER BY sort_order, rowid').all();
    const match = fallbackNameMatch(results, slug);
    if (match) {
      url.pathname = '/spot.html';
      url.search = `id=${encodeURIComponent(match.id)}&share=1`;
      return Response.redirect(url.toString(), 302);
    }
  } catch {
    // On any error, do not block normal site routing
  }

  return context.next();
}
