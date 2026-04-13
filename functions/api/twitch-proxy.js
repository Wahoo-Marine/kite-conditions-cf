/**
 * GET /api/twitch-proxy?u=<base64url-encoded-twitch-url>
 *
 * Proxies Twitch HLS quality-level playlists and .ts video segments back to
 * the browser, adding CORS headers so HLS.js / Safari can fetch them.
 *
 * Quality playlists contain relative or absolute segment URLs — we rewrite
 * them to go through this same proxy so every request stays same-origin.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

function decodeU(u) {
  // Reverse URL-safe base64 (no padding)
  let b64 = u.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4) b64 += '=';
  return atob(b64);
}

function encodeU(url) {
  return btoa(url).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export async function onRequestGet(context) {
  const { request } = context;
  const reqUrl = new URL(request.url);
  const origin = reqUrl.origin;
  const u = reqUrl.searchParams.get('u');

  if (!u) {
    return new Response('Missing ?u= parameter', { status: 400 });
  }

  let targetUrl;
  try {
    targetUrl = decodeU(u);
  } catch {
    return new Response('Invalid ?u= encoding', { status: 400 });
  }

  // Only allow Twitch domains
  const allowed = /\.(twitchsvc\.net|twitch\.tv|twitchapps\.com|jtvnw\.net)(\/|$)/i;
  if (!allowed.test(new URL(targetUrl).hostname)) {
    return new Response('Forbidden', { status: 403 });
  }

  try {
    const upstream = await fetch(targetUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000),
    });

    if (!upstream.ok) {
      return new Response(`Upstream error: ${upstream.status}`, { status: upstream.status });
    }

    const contentType = upstream.headers.get('content-type') || '';

    // If it's an m3u8 playlist, rewrite segment / sub-playlist URLs
    if (contentType.includes('mpegurl') || targetUrl.includes('.m3u8')) {
      const text = await upstream.text();
      const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);

      const rewritten = text.split('\n').map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;

        // Resolve relative URLs against the playlist base
        let absUrl;
        if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
          absUrl = trimmed;
        } else {
          absUrl = baseUrl + trimmed;
        }

        return `${origin}/api/twitch-proxy?u=${encodeU(absUrl)}`;
      }).join('\n');

      return new Response(rewritten, {
        headers: {
          ...CORS_HEADERS,
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-cache, no-store',
        },
      });
    }

    // Binary segment (.ts / .aac etc.) — stream straight through
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        ...CORS_HEADERS,
        'Content-Type': contentType || 'video/mp2t',
        'Cache-Control': 'public, max-age=60',
      },
    });

  } catch (err) {
    return new Response(`Proxy error: ${err.message}`, { status: 502 });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
