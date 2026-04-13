/**
 * GET /api/forecast?offset=0&days=7
 * Returns the full dashboard forecast for all spots.
 */
import {
  fetchForecast, processForecast, ratingLabel, ratingEmoji,
  degreesToCompass,
} from '../lib/kite-logic.js';

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);

  const offset = Math.max(0, Math.min(parseInt(url.searchParams.get('offset') || '0') || 0, 15));
  const numDays = Math.max(1, Math.min(parseInt(url.searchParams.get('days') || '7') || 7, 16 - offset));

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const startDate = new Date(today);
  startDate.setDate(startDate.getDate() + offset);
  const endDate = new Date(startDate);
  endDate.setDate(endDate.getDate() + numDays - 1);

  const startStr = startDate.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);

  // Load spots from D1
  const { results: spots } = await env.DB.prepare(
    'SELECT id, name, lat, lon, webcams, sort_order FROM spots ORDER BY sort_order, rowid'
  ).all();

  const allSpots = [];
  const bestDays = [];
  const cacheAges = [];

  // Fetch all spots in parallel
  const fetches = spots.map(async (spot) => {
    try {
      const { data, cacheAge } = await fetchForecast(spot.lat, spot.lon, env.CACHE);
      cacheAges.push(cacheAge);
      const days = processForecast(data, startStr, endStr);
      const tz = data.timezone || 'UTC';

      // Collect best days
      for (const day of days) {
        if (day.rating === 'send-it' || day.rating === 'maybe') {
          bestDays.push({
            spot: spot.name,
            day_name: `${day.day_short} ${day.month_day}`,
            max_wind: day.max_wind,
            dom_dir: day.dom_dir,
            rating: day.rating,
            rating_label: day.rating_label,
            rating_emoji: day.rating_emoji,
          });
        }
      }

      const winds = days.filter(d => d.avg_wind != null).map(d => d.avg_wind);
      const overallAvgWind = winds.length > 0
        ? Math.round(winds.reduce((a, b) => a + b, 0) / winds.length)
        : 0;

      return {
        id: spot.id,
        name: spot.name,
        lat: spot.lat,
        lon: spot.lon,
        timezone: tz,
        days,
        overall_avg_wind: overallAvgWind,
      };
    } catch (e) {
      return {
        id: spot.id,
        name: spot.name,
        lat: spot.lat,
        lon: spot.lon,
        error: e.message,
        days: [],
        overall_avg_wind: 0,
      };
    }
  });

  const results = await Promise.all(fetches);

  // Sort by avg wind descending
  results.sort((a, b) => b.overall_avg_wind - a.overall_avg_wind);

  // Build days grid
  let dayDates = [];
  for (const s of results) {
    if (s.days && s.days.length > 0) {
      dayDates = s.days.map(d => d.date);
      break;
    }
  }

  const daysGrid = dayDates.map(dateStr => {
    const dt = new Date(dateStr + 'T00:00:00');
    const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

    const spotEntries = results.map(s => {
      const match = s.days?.find(d => d.date === dateStr);
      if (match) {
        return { id: s.id, name: s.name, ...match };
      }
      return {
        id: s.id, name: s.name,
        rating: 'unknown', rating_label: '?', rating_emoji: '⚪',
        max_wind: null, avg_wind: null, max_gust: null,
        gust_factor: null, gust_pct: null, avg_temp: null,
        dom_dir: '?', hi: null, lo: null,
        sunrise: '?', sunset: '?', hours: [],
      };
    });

    return {
      date: dateStr,
      day_short: dayNames[dt.getDay()],
      month_day: `${monthNames[dt.getMonth()]} ${String(dt.getDate()).padStart(2, '0')}`,
      spots: spotEntries,
    };
  });

  const maxCacheAge = cacheAges.length > 0 ? Math.max(...cacheAges) : 0;
  const allCached = cacheAges.length > 0 && cacheAges.every(a => a > 0);

  return Response.json({
    generated: new Date().toLocaleString('en-US', {
      weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
      hour: 'numeric', minute: '2-digit',
    }),
    spots: results,
    best_days: bestDays,
    days_grid: daysGrid,
    cache_age: Math.round(maxCacheAge),
    all_cached: allCached,
    num_days: numDays,
    start_offset: offset,
  });
}
