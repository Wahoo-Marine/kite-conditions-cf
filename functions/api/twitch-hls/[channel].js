/**
 * GET /api/twitch-hls/:channel
 *
 * Fetches the Twitch master HLS playlist server-side (bypassing CORS/DNS
 * restrictions) and returns it with all quality-level URLs rewritten to go
 * through our /api/twitch-proxy endpoint.  The browser only ever talks to
 * our own origin — no direct requests to usher.twitchapps.com or Twitch CDN.
 */

const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const GQL_URL = 'https://gql.twitch.tv/gql';
const USHER_URL = 'https://usher.twitchapps.com/api/channel/hls';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
};

export async function onRequestGet(context) {
  const { params, request } = context;
  const channel = params.channel.toLowerCase();
  const origin = new URL(request.url).origin; // e.g. https://kite.wahoomarine.com

  try {
    // ── Step 1: get playback access token ────────────────────────────────────
    const gqlResp = await fetch(GQL_URL, {
      method: 'POST',
      headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: `{ streamPlaybackAccessToken(channelName: "${channel}", params: { platform: "web", playerBackend: "mediaplayer", playerType: "site" }) { value signature } }`,
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!gqlResp.ok) {
      return Response.json({ error: `Twitch GQL error: ${gqlResp.status}` }, { status: 502 });
    }

    const gqlData = await gqlResp.json();
    const token = gqlData?.data?.streamPlaybackAccessToken;
    if (!token?.value || !token?.signature) {
      return Response.json({ error: 'Channel offline or no token' }, { status: 404 });
    }

    // ── Step 2: fetch master playlist from usher (server-side, no CORS issue) ─
    const usherParams = new URLSearchParams({
      sig: token.signature,
      token: token.value,
      allow_source: 'true',
      allow_spectre: 'true',
      fast_bread: 'true',
      p: String(Math.floor(Math.random() * 999999)),
      player: 'twitchweb',
      type: 'any',
    });
    const masterUrl = `${USHER_URL}/${channel}.m3u8?${usherParams.toString()}`;

    const masterResp = await fetch(masterUrl, { signal: AbortSignal.timeout(8000) });
    if (!masterResp.ok) {
      return Response.json({ error: `Stream offline (usher ${masterResp.status})` }, { status: 404 });
    }

    const masterText = await masterResp.text();

    // ── Step 3: rewrite quality-level playlist URLs to go through our proxy ──
    // Each non-comment, non-empty line in the master playlist is a URL like:
    //   https://video-weaver.xxx.hls.twitchsvc.net/v1/playlist/xxx.m3u8
    // We base64-encode it and route through /api/twitch-proxy?u=<encoded>
    const rewritten = masterText.split('\n').map(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line; // keep tags as-is
      // Rewrite absolute URLs only
      if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
        const encoded = btoa(trimmed).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
        return `${origin}/api/twitch-proxy?u=${encoded}`;
      }
      return line;
    }).join('\n');

    return new Response(rewritten, {
      headers: {
        ...CORS_HEADERS,
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Cache-Control': 'no-cache, no-store',
      },
    });

  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}

export async function onRequestOptions() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
