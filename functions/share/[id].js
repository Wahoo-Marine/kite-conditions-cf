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

function fallbackNameMatch(results, slug) {
  return (results || []).find(r => {
    const full = normalizeShortSlug(r.name);
    if (!full) return false;
    const tokens = full.split('-').filter(Boolean);
    return slug === full || tokens.includes(slug);
  });
}

export async function onRequestGet(context) {
  const { request, params } = context;
  const url = new URL(request.url);

  const raw = String(params.id || '').trim();
  if (!raw) return new Response('Spot not found', { status: 404 });

  // Fast path: existing spot ids are 8-char hex strings
  if (/^[a-f0-9]{8}$/i.test(raw)) {
    url.pathname = '/spot.html';
    url.search = `id=${encodeURIComponent(raw)}&share=1`;
    return Response.redirect(url.toString(), 302);
  }

  const slug = normalizeShortSlug(raw);
  const spotsResp = await fetch(`${url.origin}/api/spots?source=defaults`, { headers: { 'Accept': 'application/json' } });
  if (!spotsResp.ok) return new Response('Spot not found', { status: 404 });

  const results = await spotsResp.json();
  let spot = (results || []).find(s => normalizeShortSlug(s.short_slug) === slug) || null;
  if (!spot) spot = fallbackNameMatch(results, slug) || null;

  if (!spot) return new Response('Spot not found', { status: 404 });

  url.pathname = '/spot.html';
  url.search = `id=${encodeURIComponent(spot.id)}&share=1`;
  return Response.redirect(url.toString(), 302);
}
