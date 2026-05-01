/**
 * GET /api/geocode?q=Lake+Allatoona
 * Proxies Nominatim (OpenStreetMap) geocoding — handles lakes, islands,
 * beaches, and obscure places that Open-Meteo misses.
 */

export async function onRequestGet(context) {
  const { request } = context;
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();

  if (!q) return Response.json({ error: 'Query required' }, { status: 400 });

  try {
    const params = new URLSearchParams({
      q,
      format: 'json',
      limit: 5,
      addressdetails: 1,
    });
    // Nominatim requires a descriptive User-Agent (ToS)
    const resp = await fetch(
      `https://nominatim.openstreetmap.org/search?${params}`,
      { headers: { 'User-Agent': 'KiteConditions/1.0 (kite.wahoomarine.com)' } }
    );
    const data = await resp.json();

    const results = (data || []).map(r => {
      // Build a human-readable label from the display_name parts
      const addr = r.address || {};
      const parts = [
        r.name || addr.leisure || addr.natural || addr.water || addr.amenity,
        addr.county || addr.city || addr.town || addr.village,
        addr.state,
        addr.country,
      ].filter(Boolean);
      // Deduplicate adjacent identical parts
      const label = parts.filter((p, i) => p !== parts[i - 1]).join(', ');
      return {
        name: label || r.display_name,
        lat: Math.round(parseFloat(r.lat) * 1000000) / 1000000,
        lon: Math.round(parseFloat(r.lon) * 1000000) / 1000000,
        type: r.type,
      };
    });

    return Response.json(results);
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500 });
  }
}
