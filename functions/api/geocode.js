/**
 * GET /api/geocode?q=Cape+Hatteras
 * Proxies Open-Meteo's free geocoding API.
 */

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();

  if (!q) return Response.json({ error: 'Query required' }, { status: 400 });

  try {
    const params = new URLSearchParams({
      name: q,
      count: 5,
      language: 'en',
      format: 'json',
    });
    const resp = await fetch(`https://geocoding-api.open-meteo.com/v1/search?${params}`);
    const data = await resp.json();

    const results = (data.results || []).map(r => {
      let label = r.name || '';
      const parts = [r.admin1, r.country].filter(Boolean);
      if (parts.length) label += ', ' + parts.join(', ');
      return { name: label, lat: Math.round(r.latitude * 10000) / 10000, lon: Math.round(r.longitude * 10000) / 10000 };
    });

    return Response.json(results);
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
