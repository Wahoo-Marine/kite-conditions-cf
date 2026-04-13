/**
 * GET /api/twitch-hls/:channel
 * Returns the Twitch HLS playlist URL for a live channel.
 * Fetches a playback access token via Twitch GQL, then resolves the usher URL.
 */

const TWITCH_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';
const GQL_URL = 'https://gql.twitch.tv/gql';
const USHER_URL = 'https://usher.twitchapps.com/api/channel/hls';

export async function onRequestGet(context) {
  const { params } = context;
  const channel = params.channel.toLowerCase();

  try {
    // Step 1: Get playback access token via GQL
    const gqlResp = await fetch(GQL_URL, {
      method: 'POST',
      headers: {
        'Client-ID': TWITCH_CLIENT_ID,
        'Content-Type': 'application/json',
      },
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
      return Response.json({ error: 'No token returned — channel may be offline' }, { status: 404 });
    }

    // Step 2: Build the usher HLS URL
    const params2 = new URLSearchParams({
      sig: token.signature,
      token: token.value,
      allow_source: 'true',
      allow_spectre: 'true',
      fast_bread: 'true',
      p: String(Math.floor(Math.random() * 999999)),
      player: 'twitchweb',
      type: 'any',
    });
    const hlsUrl = `${USHER_URL}/${channel}.m3u8?${params2.toString()}`;

    // Step 3: Verify the stream is actually live by fetching the playlist
    const m3u8Resp = await fetch(hlsUrl, {
      signal: AbortSignal.timeout(8000),
    });

    if (!m3u8Resp.ok) {
      return Response.json({ error: 'Stream offline or unavailable', status: m3u8Resp.status }, { status: 404 });
    }

    const m3u8Text = await m3u8Resp.text();

    // Extract the best quality stream URL from the master playlist
    const lines = m3u8Text.split('\n');
    let bestUrl = null;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('#EXT-X-STREAM-INF')) {
        // Prefer 720p60 or 480p; first entry is usually best quality
        bestUrl = lines[i + 1]?.trim();
        break; // take first (best quality)
      }
    }

    if (!bestUrl) {
      return Response.json({ error: 'Could not parse stream playlist' }, { status: 500 });
    }

    return Response.json({ hls_url: bestUrl, channel }, {
      headers: {
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      },
    });

  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
