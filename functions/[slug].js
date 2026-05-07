function normalizeShortSlug(value) {
  if (!value) return null;
  const slug = String(value).trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return slug || null;
}

function fallbackNameMatch(results, slug) {
  return (results || []).find(r => {
    const full = normalizeShortSlug(r.name);
    if (!full) return false;
    const tokens = full.split('-').filter(Boolean);
    return slug === full || tokens.includes(slug);
  });
}

const RESERVED = new Set(['api', 'share']);

async function handleRequest(context) {
  const { request, params, env, next } = context;
  const url = new URL(request.url);

  const raw = String(params.slug || '').trim();
  if (!raw) return next();

  if (RESERVED.has(raw.toLowerCase()) || raw.includes('.')) {
    return next();
  }

  if (/^[a-f0-9]{8}$/i.test(raw)) {
    url.pathname = '/spot.html';
    url.search = `id=${encodeURIComponent(raw)}&share=1`;
    return Response.redirect(url.toString(), 302);
  }

  const slug = normalizeShortSlug(raw);
  if (!slug) return next();

  let spot = null;

  try {
    const byShortSlug = await env.DB.prepare(
      'SELECT id, name, short_slug FROM spots WHERE user_id IS NULL AND short_slug IS NOT NULL'
    ).all();

    spot = (byShortSlug?.results || []).find(s => normalizeShortSlug(s.short_slug) === slug) || null;

    if (!spot) {
      const defaults = await env.DB.prepare(
        'SELECT id, name, short_slug FROM spots WHERE user_id IS NULL ORDER BY sort_order, rowid'
      ).all();
      spot = fallbackNameMatch(defaults?.results || [], slug) || null;
    }
  } catch {
    return next();
  }

  if (!spot) return next();

  url.pathname = '/spot.html';
  url.search = `id=${encodeURIComponent(spot.id)}&share=1`;
  return Response.redirect(url.toString(), 302);
}

export async function onRequestGet(context) {
  return handleRequest(context);
}

export async function onRequestHead(context) {
  return handleRequest(context);
}
