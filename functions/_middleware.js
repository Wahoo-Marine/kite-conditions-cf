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

function fallbackNameMatch(results, slug) {
  return (results || []).find(r => {
    const full = normalizeShortSlug(r.name);
    if (!full) return false;
    const tokens = full.split('-').filter(Boolean);
    return slug === full || tokens.includes(slug);
  });
}

export async function onRequest(context) {
  const { request } = context;

  if (request.method !== 'GET') return context.next();

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/+|\/+$/g, '');

  // Only handle clean single-segment paths like /turks
  if (!path || path.includes('/')) return context.next();

  const slug = decodeURIComponent(path).toLowerCase();
  if (!slug || RESERVED.has(slug) || slug.includes('.')) return context.next();

  try {
    const spotsResp = await fetch(`${url.origin}/api/spots?source=defaults`, { headers: { 'Accept': 'application/json' } });
    if (!spotsResp.ok) return new Response('Not found', { status: 404 });
    const results = await spotsResp.json();

    let match = (results || []).find(s => normalizeShortSlug(s.short_slug) === slug);
    if (!match) match = fallbackNameMatch(results, slug);
    if (match) {
      url.pathname = '/spot.html';
      url.search = `id=${encodeURIComponent(match.id)}&share=1`;
      return Response.redirect(url.toString(), 302);
    }
  } catch {
    return new Response('Not found', { status: 404 });
  }

  return new Response('Not found', { status: 404 });
}
