import pages from '../dist/pages-bundle.js';
import { pollStation } from '../functions/lib/wind.js';

async function pollAllStations(env) {
  const { results } = await env.DB.prepare(
    "SELECT DISTINCT weather_station FROM spots WHERE weather_station IS NOT NULL AND weather_station != ''"
  ).all();

  await Promise.allSettled(
    (results || []).map(row => pollStation(row.weather_station, env))
  );
}

export default {
  async fetch(request, env, ctx) {
    return pages.fetch(request, env, ctx);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(pollAllStations(env));
  },
};
