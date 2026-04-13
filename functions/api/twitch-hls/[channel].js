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

    // Step 2: Build the usher master playlist URL and return it directly.
    // Do NOT pre-fetch or resolve to a quality-level URL — the signed token
    // has a short TTL and the client needs the master playlist so HLS.js /
    // Safari can keep fetching fresh segments continuously.
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
    const hlsUrl = `${USHER_URL}/${channel}.m3u8?${usherParams.toString()}`;

    return Response.json({ hls_url: hlsUrl, channel }, {
      headers: {
        'Cache-Control': 'no-cache',
        'Access-Control-Allow-Origin': '*',
      },
    });

  } catch (err) {
    return Response.json({ error: err.message }, { status: 500 });
  }
}
