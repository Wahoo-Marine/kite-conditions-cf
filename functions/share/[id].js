/**
 * GET /share/:id
 *
 * Public, shareable spot page — no login required.
 * Fetches spot + forecast data server-side from D1 and renders a complete
 * self-contained HTML page.  The browser makes no subsequent authenticated
 * API calls, so Cloudflare Access never blocks the experience.
 *
 * To enable public access, add a Bypass policy in Zero Trust → Access →
 * your application → Add a policy:
 *   Action: Bypass
 *   Rule:   Path matches  /share/*
 */
import {
  fetchForecast, processForecast, getCurrentConditions,
  fetchTides, processTides,
} from '../lib/kite-logic.js';

export async function onRequestGet(context) {
  const { env, params } = context;
  const spotId = params.id;

  // ── Load spot ────────────────────────────────────────────────────────────
  const spot = await env.DB.prepare(
    'SELECT id, name, lat, lon, webcams, weather_station FROM spots WHERE id = ?'
  ).bind(spotId).first();

  if (!spot) {
    return new Response('Spot not found', { status: 404 });
  }

  const webcams = JSON.parse(spot.webcams || '[]');

  // ── Fetch forecast + tides in parallel ───────────────────────────────────
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const endDate = new Date(today);
  endDate.setDate(endDate.getDate() + 6);
  const startStr = today.toISOString().slice(0, 10);
  const endStr = endDate.toISOString().slice(0, 10);

  let days = [], current = null, tz = '';

  // Fetch wind data directly from KV + WeatherLink (no HTTP round-trip through Access)
  const windPromise = spot.weather_station
    ? fetchWindDirect(spotId, spot.weather_station, env)
    : Promise.resolve(null);

  const [forecastResult, tidesResult] = await Promise.allSettled([
    fetchForecast(spot.lat, spot.lon, env.CACHE),
    fetchTides(spot.lat, spot.lon, env.CACHE),
  ]);

  if (forecastResult.status === 'fulfilled') {
    tz = forecastResult.value.data.timezone || 'UTC';
    days = processForecast(forecastResult.value.data, startStr, endStr);
    current = getCurrentConditions(forecastResult.value.data);
  }
  if (tidesResult.status === 'fulfilled') {
    const tides = processTides(tidesResult.value.data, startStr, endStr);
    const tideMap = {};
    tides.forEach(t => { tideMap[t.date] = t; });
    days.forEach(d => {
      const td = tideMap[d.date];
      d.tide = td ? { hourly: td.hourly, extremes: td.extremes } : null;
    });
  }

  const windData = await windPromise;
  const data = JSON.stringify({ spot: { ...spot, webcams, days, timezone: tz }, current });
  const windJson = JSON.stringify(windData);

  // ── Render HTML ──────────────────────────────────────────────────────────
  const html = buildHtml(spot.name, spot.id, !!spot.weather_station, webcams, data, windJson);
  return new Response(html, {
    headers: {
      'Content-Type': 'text/html; charset=UTF-8',
      'Cache-Control': 'no-cache',
    },
  });
}

function buildHtml(spotName, spotId, hasWeatherStation, webcams, dataJson, windJson) {
  const hasHls = webcams.some(c => c.oid);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>🪁 ${esc(spotName)} — Kite Conditions</title>
  <link rel="stylesheet" href="/styles.css">
  ${hasHls ? '<script src="https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js"><\/script>' : ''}
  <style>
    /* Override nav/header/footer for the share page */
    nav { display: none !important; }
    header .subtitle { display: none; }
    .back-link { display: none !important; }
    .range-picker { display: flex; }
    footer a { color: var(--accent); }
  </style>
</head>
<body>

<header>
  <h1>🪁 Kite Conditions</h1>
</header>

<div id="loading-overlay" class="hidden"></div>

<div class="container narrow" id="app">
  <!-- Hero -->
  <div class="spot-hero" id="spot-hero"></div>

  <!-- Webcams -->
  <div class="webcams-section" id="webcams-section" style="display:none;"></div>

  <!-- Live Wind Station -->
  ${hasWeatherStation ? `<div class="wind-station-section" id="wind-station-section">
    <div class="wind-station-header">🌬️ Live Wind — Weather Station</div>
    <div class="wind-station-content">
      <div class="wind-live-panel" id="wind-live-panel"><div class="wind-live-loading">Loading live wind data…</div></div>
      <div class="wind-chart-wrap">
        <canvas id="wind-chart" width="800" height="220"></canvas>
        <div class="wind-chart-label" id="wind-chart-label">Wind history loading…</div>
      </div>
    </div>
  </div>` : ''}

  <!-- Day Tabs + Panels -->
  <div class="day-tabs" id="day-tabs"></div>
  <div id="day-panels"></div>
</div>

<footer>
  Powered by <a href="https://open-meteo.com/" target="_blank">Open-Meteo</a> •
  Data refreshes every 15 min
</footer>

<script>
const __DATA__ = ${dataJson};
const __WIND__ = ${windJson};
const __SPOT_ID__ = '${spotId}';
const __HAS_WIND__ = ${hasWeatherStation};
const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);
let webcamTimers = [];
let lastWindHistory = null, lastWindHours = 6;

document.addEventListener('DOMContentLoaded', () => {
  renderSpot(__DATA__);
  if (__HAS_WIND__ && __WIND__) {
    renderWindLive(__WIND__.current);
    if (__WIND__.current && __WIND__.current.station_location) {
      const hdr = document.querySelector('.wind-station-header');
      if (hdr) hdr.textContent = '\u{1F32C}\uFE0F Live Wind \u2014 ' + __WIND__.current.station_location;
    }
    lastWindHistory = __WIND__.history;
    lastWindHours = __WIND__.history_hours;
    requestAnimationFrame(() => requestAnimationFrame(() => {
      if (lastWindHistory) renderWindChart(lastWindHistory, lastWindHours);
    }));
    window.addEventListener('resize', () => { if (lastWindHistory) renderWindChart(lastWindHistory, lastWindHours); });
  }
});

function renderSpot(data) {
  const { spot, current } = data;
  const days = spot.days || [];
  const webcams = spot.webcams || [];
  document.title = '🪁 ' + spot.name + ' — Kite Conditions';

  // ── Hero ──────────────────────────────────────────────────────────────────
  let heroHTML = '<div class="spot-name">' + esc(spot.name) + '</div>';
  heroHTML += '<div class="spot-meta">' + spot.lat.toFixed(4) + '°N, ' + Math.abs(spot.lon).toFixed(4) + '°W</div>';

  if (current) {
    const curRatingLabel = { 'send-it': 'SEND IT', maybe: 'MAYBE', nope: 'NOPE', unknown: '?' }[current.rating] || '?';
    const curRatingEmoji = { 'send-it': '🟢', maybe: '🟡', nope: '🔴', unknown: '⚪' }[current.rating] || '⚪';

    heroHTML += '<div class="current-conditions">';
    heroHTML += '<div class="current-wind">';
    heroHTML += '<div class="wind-value" style="color:' + windColor(current.wind) + '">' + Math.round(current.wind) + '</div>';
    heroHTML += '<div class="wind-unit">mph</div>';
    heroHTML += '<div class="wind-dir">' + (current.dir || '') + '</div>';
    heroHTML += '</div>';
    heroHTML += '<div class="current-details">';
    heroHTML += detailItem('Gusts', Math.round(current.gust) + ' mph');
    heroHTML += detailItem('Temp', Math.round(current.temp) + '°F');
    heroHTML += detailItem('Weather', (current.sky_icon || '') + ' ' + (current.sky || ''));
    heroHTML += detailItem('Rating', curRatingEmoji + ' ' + curRatingLabel);
    heroHTML += '</div>';
    heroHTML += '</div>';
    const rc = ratingClass(current.rating);
    heroHTML += '<div class="current-rating ' + rc + '" style="margin-top:0.8rem;">' + curRatingEmoji + ' ' + curRatingLabel + '</div>';
  }

  $('#spot-hero').innerHTML = heroHTML;

  // ── Webcams ───────────────────────────────────────────────────────────────
  const wcSection = $('#webcams-section');
  if (webcams.length > 0) {
    wcSection.style.display = 'block';
    let wcHTML = '<div class="webcams-header">📹 Live Webcams</div>';
    wcHTML += '<div class="webcams-grid">';
    webcams.forEach((cam, idx) => {
      if (cam.twitch) {
        const twitchParent = window.location.hostname;
        wcHTML += \`<div class="webcam-card">
          <div class="webcam-iframe-wrap">
            <iframe src="https://player.twitch.tv/?channel=\${encodeURIComponent(cam.twitch)}&parent=\${twitchParent}&autoplay=true&muted=true"
              allowfullscreen allow="autoplay; encrypted-media" style="border:0;width:100%;height:100%;"></iframe>
          </div>
          <div class="webcam-footer">
            <span class="webcam-label">\${esc(cam.label)}</span>
            <span class="live-badge"><span class="live-dot"></span> LIVE</span>
          </div>
        </div>\`;
      } else if (cam.youtube) {
        wcHTML += \`<div class="webcam-card">
          <div class="webcam-iframe-wrap">
            <iframe src="https://www.youtube.com/embed/\${encodeURIComponent(cam.youtube)}?autoplay=1&mute=1&rel=0&modestbranding=1"
              allowfullscreen allow="autoplay; encrypted-media" style="border:0;"></iframe>
          </div>
          <div class="webcam-footer">
            <span class="webcam-label">\${esc(cam.label)}</span>
            <span class="live-badge"><span class="live-dot"></span> LIVE</span>
          </div>
        </div>\`;
      } else if (cam.hazcam) {
        const imgSrc = \`https://data.hazcams.com/thumbnails/\${encodeURIComponent(cam.hazcam)}/large.webp?ts=\${Date.now()}\`;
        wcHTML += \`<div class="webcam-card">
          <a class="webcam-img-wrap" href="https://hazcams.com/station/\${encodeURIComponent(cam.hazcam)}" target="_blank" rel="noopener">
            <img id="wc-img-\${idx}" src="\${imgSrc}" alt="\${esc(cam.label)}" loading="lazy">
          </a>
          <div class="webcam-footer">
            <span class="webcam-label">\${esc(cam.label)}</span>
          </div>
        </div>\`;
        const t = setInterval(() => {
          const img = document.getElementById('wc-img-' + idx);
          if (img) img.src = \`https://data.hazcams.com/thumbnails/\${encodeURIComponent(cam.hazcam)}/large.webp?ts=\${Date.now()}\`;
        }, 60000);
        webcamTimers.push(t);
      } else if (cam.oid) {
        const posterUrl = \`https://relay.ozolio.com/pub.api?cmd=poster&oid=\${encodeURIComponent(cam.oid)}&ts=\${Date.now()}\`;
        wcHTML += \`<div class="webcam-card">
          <div class="webcam-iframe-wrap" style="position:relative;background:#000;">
            <video id="wc-video-\${idx}" poster="\${posterUrl}" autoplay muted playsinline
              style="width:100%;height:100%;object-fit:cover;"></video>
            <div id="wc-loading-\${idx}" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#fff;font-size:.7rem;opacity:.7;pointer-events:none;">Loading…</div>
          </div>
          <div class="webcam-footer">
            <span class="webcam-label">\${esc(cam.label)}</span>
            <span class="live-badge"><span class="live-dot"></span> LIVE</span>
          </div>
        </div>\`;
      } else if (cam.url) {
        wcHTML += \`<div class="webcam-card">
          <div class="webcam-iframe-wrap">
            <iframe src="\${cam.url}" allowfullscreen style="border:0;"></iframe>
          </div>
          <div class="webcam-footer"><span class="webcam-label">\${esc(cam.label)}</span></div>
        </div>\`;
      }
    });
    wcHTML += '</div>';
    wcSection.innerHTML = wcHTML;

    // Init Ozolio HLS after DOM is ready
    webcams.forEach((cam, idx) => {
      if (cam.oid) initOzolioHLS(cam.oid, idx);
    });
  }

  // ── Day tabs ──────────────────────────────────────────────────────────────
  if (!days.length) return;
  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  let tabsHTML = '', panelsHTML = '';

  days.forEach((d, i) => {
    const dt = new Date(d.date + 'T12:00:00');
    const dayName = dayNames[dt.getDay()];
    const mon = dt.getMonth() + 1;
    const dd = dt.getDate();
    const rc = ratingClass(d.rating);
    const active = i === 0 ? 'active' : '';

    tabsHTML += \`<button class="day-tab \${active}" data-idx="\${i}">
      <div>\${dayName} \${mon}/\${dd}</div>
      <div class="tab-rating" style="color:var(--\${rc === 'send-it' ? 'send-it' : rc === 'maybe' ? 'maybe' : 'nope'})">\${d.rating_emoji || ''} \${d.avg_wind != null ? Math.round(d.avg_wind) : '?'} mph</div>
    </button>\`;

    panelsHTML += \`<div class="day-panel \${active}" data-idx="\${i}">\`;

    // Summary
    panelsHTML += '<div class="day-summary">';
    panelsHTML += summaryItem('Avg Wind', Math.round(d.avg_wind) + ' mph');
    panelsHTML += summaryItem('Max Gust', Math.round(d.max_gust) + ' mph');
    panelsHTML += summaryItem('Temp', (d.hi != null ? d.hi : '?') + '° / ' + (d.lo != null ? d.lo : '?') + '°');
    const midIcon = d.hours && d.hours.length > 0 ? (d.hours[Math.floor(d.hours.length/2)]?.sky_icon || '') : '';
    const midSky  = d.hours && d.hours.length > 0 ? (d.hours[Math.floor(d.hours.length/2)]?.sky  || '') : '';
    panelsHTML += summaryItem('Weather', midIcon + ' ' + midSky);
    panelsHTML += \`<div class="stat"><div class="stat-label">Rating</div><div class="rating-badge \${rc}">\${d.rating_emoji || ''} \${d.rating_label || ''}</div></div>\`;
    panelsHTML += '</div>';

    // Tide chart
    if (d.tide && d.tide.hourly && d.tide.hourly.length > 0) {
      panelsHTML += \`<div class="tide-chart-section">
        <div class="tide-chart-header">🌊 Tides</div>
        <canvas class="tide-canvas" id="tide-canvas-\${i}" height="120"></canvas>
        <div class="tide-extremes">\`;
      (d.tide.extremes || []).forEach(e => {
        const cls = e.type === 'H' ? 'tide-high' : 'tide-low';
        const label = e.type === 'H' ? '▲ High' : '▼ Low';
        panelsHTML += \`<span class="tide-extreme \${cls}">\${label} \${e.time} (\${e.level}m)</span>\`;
      });
      panelsHTML += '</div></div>';
    }

    // Hourly table
    panelsHTML += '<div style="overflow-x:auto;"><table class="hourly-table"><thead><tr>';
    panelsHTML += '<th>Time</th><th>Wind</th><th>Gusts</th><th>Dir</th><th class="hide-mobile">Temp</th><th class="hide-mobile">Weather</th><th>Rating</th>';
    panelsHTML += '</tr></thead><tbody>';

    (d.hours || []).forEach(hr => {
      const hrc = ratingClass(hr.rating);
      const rowClass = hr.rating === 'send-it' ? 'send-it-row' : (hr.rating === 'nope' ? 'nope-row' : '');
      const gustCls = gustColorClass(hr.gust);
      const hrRatingLabel = { 'send-it': 'SEND IT', maybe: 'MAYBE', nope: 'NOPE', unknown: '?' }[hr.rating] || '?';
      const hrRatingEmoji = { 'send-it': '🟢', maybe: '🟡', nope: '🔴', unknown: '⚪' }[hr.rating] || '⚪';
      panelsHTML += \`<tr class="\${rowClass}">
        <td>\${hr.time || ''}</td>
        <td class="wind-cell" style="color:\${windColor(hr.wind)}">\${Math.round(hr.wind)} mph</td>
        <td class="gc-gust \${gustCls}">\${Math.round(hr.gust)} mph</td>
        <td>\${hr.dir || ''}</td>
        <td class="hide-mobile">\${Math.round(hr.temp)}°F</td>
        <td class="hide-mobile">\${hr.sky_icon || ''} \${hr.sky || ''}</td>
        <td class="rating-cell \${hrc}">\${hrRatingEmoji} \${hrRatingLabel}</td>
      </tr>\`;
    });

    panelsHTML += '</tbody></table></div></div>';
  });

  $('#day-tabs').innerHTML = tabsHTML;
  $('#day-panels').innerHTML = panelsHTML;

  // Tab switching
  $$('.day-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const idx = tab.dataset.idx;
      $$('.day-tab').forEach(t => t.classList.remove('active'));
      $$('.day-panel').forEach(p => p.classList.remove('active'));
      tab.classList.add('active');
      document.querySelector('.day-panel[data-idx="' + idx + '"]').classList.add('active');
      const d = days[parseInt(idx)];
      if (d && d.tide && d.tide.hourly && d.tide.hourly.length > 0) renderTideChart(parseInt(idx), d.tide);
    });
  });

  // Render tide charts
  days.forEach((d, i) => {
    if (d.tide && d.tide.hourly && d.tide.hourly.length > 0) renderTideChart(i, d.tide);
  });
  window.addEventListener('resize', () => {
    days.forEach((d, i) => {
      if (d.tide && d.tide.hourly && d.tide.hourly.length > 0) renderTideChart(i, d.tide);
    });
  });
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function detailItem(label, value) {
  return '<div class="detail-item"><div class="detail-label">' + label + '</div><div class="detail-value">' + value + '</div></div>';
}
function summaryItem(label, value) {
  return '<div class="stat"><div class="stat-label">' + label + '</div><div class="stat-value">' + value + '</div></div>';
}
function ratingClass(r) { return r === 'send-it' ? 'send-it' : (r === 'maybe' ? 'maybe' : 'nope'); }
function gustColorClass(g) { return g < 25 ? 'gust-low' : (g < 35 ? 'gust-med' : 'gust-high'); }
function windColor(w) { return w >= 15 ? 'var(--send-it)' : (w >= 12 ? 'var(--maybe)' : 'var(--text-muted)'); }
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ── Ozolio HLS ────────────────────────────────────────────────────────────────
async function initOzolioHLS(oid, idx) {
  const video = document.getElementById('wc-video-' + idx);
  const loadingEl = document.getElementById('wc-loading-' + idx);
  if (!video) return;
  try {
    if (loadingEl) loadingEl.textContent = 'Connecting…';
    const initResp = await fetch('https://relay.ozolio.com/ses.api?cmd=init&oid=' + encodeURIComponent(oid));
    if (!initResp.ok) throw new Error('Session init failed');
    const initData = await initResp.json();
    const sessionId = initData.session.id;
    const openResp = await fetch('https://relay.ozolio.com/ses.api?cmd=open&oid=' + encodeURIComponent(sessionId) + '&output=1&format=M3U8&profile=base');
    if (!openResp.ok) throw new Error('Session open failed');
    const openData = await openResp.json();
    const hlsUrl = openData.output.source;
    if (!hlsUrl) throw new Error('No HLS source');
    if (loadingEl) loadingEl.textContent = 'Connecting…';
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = hlsUrl;
      video.play().catch(() => {});
      if (loadingEl) loadingEl.style.display = 'none';
    } else if (typeof Hls !== 'undefined' && Hls.isSupported()) {
      const hls = new Hls({ enableWorker: true, lowLatencyMode: true, maxBufferLength: 10, liveSyncDurationCount: 2 });
      hls.loadSource(hlsUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}); if (loadingEl) loadingEl.style.display = 'none'; });
      hls.on(Hls.Events.ERROR, (event, data) => { if (data.fatal) { hls.destroy(); fallbackToPosterRefresh(oid, idx); } });
      video._hls = hls;
    }
  } catch (err) {
    fallbackToPosterRefresh(oid, idx);
  }
}

function fallbackToPosterRefresh(oid, idx) {
  const video = document.getElementById('wc-video-' + idx);
  if (!video) return;
  const wrap = video.parentElement;
  if (!wrap) return;
  if (video._hls) video._hls.destroy();
  const img = document.createElement('img');
  img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
  img.src = 'https://relay.ozolio.com/pub.api?cmd=poster&oid=' + encodeURIComponent(oid) + '&ts=' + Date.now();
  const loading = document.getElementById('wc-loading-' + idx);
  if (loading) loading.style.display = 'none';
  wrap.replaceChild(img, video);
  const t = setInterval(() => { img.src = 'https://relay.ozolio.com/pub.api?cmd=poster&oid=' + encodeURIComponent(oid) + '&ts=' + Date.now(); }, 5000);
  webcamTimers.push(t);
}

// ── Tide Chart ────────────────────────────────────────────────────────────────
function renderTideChart(dayIdx, tide) {
  const canvas = document.getElementById('tide-canvas-' + dayIdx);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  function getAvailableWidth(el) {
    let node = el;
    while (node) { const w = node.getBoundingClientRect().width; if (w > 0) return w; node = node.parentElement; }
    return document.documentElement.clientWidth || 360;
  }
  const W = Math.floor(getAvailableWidth(canvas.parentElement) - 19);
  const H = 120;
  canvas.width = W * dpr; canvas.height = H * dpr;
  canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, W, H);

  const hourly = tide.hourly, extremes = tide.extremes || [];
  const PAD_LEFT = 36, PAD_RIGHT = 12, PAD_TOP = 12, PAD_BOTTOM = 22;
  const chartW = W - PAD_LEFT - PAD_RIGHT, chartH = H - PAD_TOP - PAD_BOTTOM;
  const levels = hourly.map(h => h.level);
  const minLvl = Math.min(...levels) - 0.05, maxLvl = Math.max(...levels) + 0.05;
  const range = maxLvl - minLvl || 0.1;

  function timeToHours(t) { const [h, m] = t.split(':').map(Number); return h + m / 60; }
  function xPos(t) { return PAD_LEFT + (timeToHours(t) / 24) * chartW; }
  function yPos(l) { return PAD_TOP + chartH - ((l - minLvl) / range) * chartH; }

  ctx.fillStyle = 'rgba(26,39,51,0.6)'; ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(255,255,255,0.06)'; ctx.lineWidth = 1;
  ctx.font = '9px -apple-system,sans-serif'; ctx.fillStyle = '#8899a6';
  const step = range > 0.5 ? 0.2 : 0.1;
  for (let v = Math.ceil(minLvl / step) * step; v <= maxLvl; v += step) {
    const y = yPos(v);
    ctx.beginPath(); ctx.moveTo(PAD_LEFT, y); ctx.lineTo(W - PAD_RIGHT, y); ctx.stroke();
    ctx.textAlign = 'right'; ctx.fillText(v.toFixed(1) + 'm', PAD_LEFT - 4, y + 3);
  }

  const areaPath = new Path2D();
  areaPath.moveTo(xPos(hourly[0].time), yPos(hourly[0].level));
  for (let i = 1; i < hourly.length; i++) areaPath.lineTo(xPos(hourly[i].time), yPos(hourly[i].level));
  areaPath.lineTo(xPos(hourly[hourly.length-1].time), yPos(minLvl));
  areaPath.lineTo(xPos(hourly[0].time), yPos(minLvl));
  areaPath.closePath();
  const grad = ctx.createLinearGradient(0, PAD_TOP, 0, PAD_TOP + chartH);
  grad.addColorStop(0, 'rgba(56,189,248,0.25)'); grad.addColorStop(1, 'rgba(56,189,248,0.03)');
  ctx.fillStyle = grad; ctx.fill(areaPath);

  ctx.beginPath(); ctx.moveTo(xPos(hourly[0].time), yPos(hourly[0].level));
  for (let i = 1; i < hourly.length; i++) ctx.lineTo(xPos(hourly[i].time), yPos(hourly[i].level));
  ctx.strokeStyle = '#38bdf8'; ctx.lineWidth = 2; ctx.stroke();

  extremes.forEach(e => {
    const x = xPos(e.time), y = yPos(e.level), isHigh = e.type === 'H';
    ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = isHigh ? '#22c55e' : '#ef4444'; ctx.fill();
    ctx.font = 'bold 9px -apple-system,sans-serif'; ctx.textAlign = 'center';
    ctx.fillStyle = isHigh ? '#22c55e' : '#ef4444';
    ctx.fillText((isHigh ? '▲ ' : '▼ ') + e.level + 'm', x, isHigh ? y - 7 : y + 12);
  });

  ctx.fillStyle = '#8899a6'; ctx.font = '9px -apple-system,sans-serif'; ctx.textAlign = 'center';
  [0,6,12,18,24].forEach(h => {
    const x = PAD_LEFT + (h / 24) * chartW;
    const label = h === 0 ? '12a' : h === 6 ? '6a' : h === 12 ? '12p' : h === 18 ? '6p' : '12a';
    ctx.fillText(label, x, H - 5);
    ctx.beginPath(); ctx.moveTo(x, PAD_TOP + chartH); ctx.lineTo(x, PAD_TOP + chartH + 3);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 1; ctx.stroke();
  });
}

// ── Live Wind ─────────────────────────────────────────────────────────────────
async function loadWindData() {
  try {
    const res = await fetch('/share/wind/' + __SPOT_ID__);
    if (!res.ok) throw new Error('no data');
    const data = await res.json();
    if (data.current && data.current.station_location) {
      const hdr = document.querySelector('.wind-station-header');
      if (hdr) hdr.textContent = '\u{1F32C}\uFE0F Live Wind \u2014 ' + data.current.station_location;
    }
    renderWindLive(data.current);
    if (data.history) {
      lastWindHistory = data.history;
      lastWindHours = data.history_hours;
      requestAnimationFrame(() => requestAnimationFrame(() => renderWindChart(data.history, data.history_hours)));
    }
  } catch (e) {
    const p = $('#wind-live-panel');
    if (p) p.innerHTML = '<div class="wind-live-loading" style="color:var(--text-muted);">Wind data temporarily unavailable</div>';
  }
}
function renderWindData(data) {
  if (data.current && data.current.station_location) {
    const hdr = document.querySelector('.wind-station-header');
    if (hdr) hdr.textContent = '\u{1F32C}\uFE0F Live Wind \u2014 ' + data.current.station_location;
  }
  renderWindLive(data.current);
  if (data.history) { renderWindChart(data.history, data.history_hours); lastWindHistory = data.history; lastWindHours = data.history_hours; }
}
function renderWindLive(c) {
  if (!c) return;
  const panel = $('#wind-live-panel');
  if (!panel) return;
  const windCol = c.wind >= 15 ? 'var(--send-it)' : (c.wind >= 12 ? 'var(--maybe)' : 'var(--text-muted)');
  const gustCls = c.gust < 25 ? 'gust-low' : (c.gust < 35 ? 'gust-med' : 'gust-high');
  const arrowDeg = (c.wind_dir + 180) % 360;
  const lastUpdated = c.last_received ? new Date(c.last_received).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}) : '';
  panel.innerHTML = '<div class="wl-grid"><div class="wl-wind-main"><div class="wl-compass"><svg viewBox="0 0 80 80" class="compass-svg">'+
    '<circle cx="40" cy="40" r="36" fill="none" stroke="var(--border)" stroke-width="2"/>'+
    '<text x="40" y="12" text-anchor="middle" fill="var(--text-muted)" font-size="8" font-weight="600">N</text>'+
    '<text x="72" y="43" text-anchor="middle" fill="var(--text-muted)" font-size="8" font-weight="600">E</text>'+
    '<text x="40" y="76" text-anchor="middle" fill="var(--text-muted)" font-size="8" font-weight="600">S</text>'+
    '<text x="8" y="43" text-anchor="middle" fill="var(--text-muted)" font-size="8" font-weight="600">W</text>'+
    '<g transform="rotate('+arrowDeg+', 40, 40)">'+
    '<line x1="40" y1="58" x2="40" y2="18" stroke="'+windCol+'" stroke-width="2.5" stroke-linecap="round"/>'+
    '<polygon points="40,16 35,26 45,26" fill="'+windCol+'"/></g></svg></div>'+
    '<div class="wl-wind-numbers">'+
    '<div class="wl-wind-speed" style="color:'+windCol+'">'+Math.round(c.wind)+'</div>'+
    '<div class="wl-wind-unit">'+(c.wind_units||'mph')+'</div>'+
    '<div class="wl-wind-dir">'+(c.wind_dir_cardinal||'?')+' ('+Math.round(c.wind_dir)+'\u00B0)</div>'+
    '</div></div><div class="wl-details">'+
    '<div class="wl-detail"><span class="wl-detail-label">Gusts</span><span class="wl-detail-value '+gustCls+'">'+Math.round(c.gust)+' '+(c.wind_units||'mph')+'</span></div>'+
    '<div class="wl-detail"><span class="wl-detail-label">Temp</span><span class="wl-detail-value">'+(c.temp!=null?Math.round(c.temp)+'\u00B0F':'\u2014')+'</span></div>'+
    '<div class="wl-detail"><span class="wl-detail-label">Feels Like</span><span class="wl-detail-value">'+(c.feels_like!=null?Math.round(c.feels_like)+'\u00B0F':'\u2014')+'</span></div>'+
    '<div class="wl-detail"><span class="wl-detail-label">Humidity</span><span class="wl-detail-value">'+(c.humidity!=null?Math.round(c.humidity)+'%':'\u2014')+'</span></div>'+
    '<div class="wl-detail"><span class="wl-detail-label">Hi / Lo</span><span class="wl-detail-value">'+(c.hi_temp!=null?Math.round(c.hi_temp):'?')+'\u00B0 / '+(c.lo_temp!=null?Math.round(c.lo_temp):'?')+'\u00B0</span></div>'+
    '<div class="wl-detail"><span class="wl-detail-label">Barometer</span><span class="wl-detail-value">'+(c.barometer||'\u2014')+' '+(c.barometer_trend?'('+c.barometer_trend+')':'')+'</span></div>'+
    '</div></div>'+(lastUpdated?'<div class="wl-updated">Updated '+lastUpdated+'</div>':'');
}
function renderWindChart(history, hours) {
  const canvas = $('#wind-chart'), label = $('#wind-chart-label');
  if (!canvas) return;
  const ctx = canvas.getContext('2d'), dpr = window.devicePixelRatio || 1;
  // Walk up DOM to find a visible ancestor with real width
  let W = 0;
  let node = canvas.parentElement;
  while (node && !W) { W = node.getBoundingClientRect().width; node = node.parentElement; }
  W = Math.floor((W || 800));
  const H = 220;
  canvas.width = W*dpr; canvas.height = H*dpr; canvas.style.width=W+'px'; canvas.style.height=H+'px';
  ctx.save(); ctx.scale(dpr,dpr);
  ctx.clearRect(0,0,W,H);
  const PL=36, PR=12, PT=12, PB=22, cW=W-PL-PR, cH=H-PT-PB;
  // Normalise ts: may be ms number or ISO date string
  const toMs = ts => typeof ts === 'number' ? ts : new Date(ts).getTime();
  if (!history||history.length<2) { if(label) label.textContent='Wind history building up\u2026'; ctx.fillStyle='rgba(255,255,255,0.1)'; ctx.fillRect(0,0,W,H); ctx.restore(); return; }
  // Show actual span of data, not just the configured max window
  const spanMs = toMs(history[history.length-1].ts) - toMs(history[0].ts);
  const allV=history.flatMap(h=>[h.wind,h.gust]).filter(v=>v!=null&&!isNaN(v));
  if (!allV.length) return;
  const maxV=Math.max(Math.ceil(Math.max(...allV)/5)*5,20);
  const tMin=toMs(history[0].ts),tMax=toMs(history[history.length-1].ts),tR=tMax-tMin||1;
  const xP=ts=>PL+((toMs(ts)-tMin)/tR)*cW, yP=v=>PT+cH-(v/maxV)*cH;
  ctx.fillStyle='rgba(26,39,51,0.8)'; ctx.fillRect(0,0,W,H);
  ctx.strokeStyle='rgba(255,255,255,0.06)'; ctx.lineWidth=1; ctx.font='10px -apple-system,sans-serif'; ctx.fillStyle='#8899a6';
  const gs=maxV<=30?5:10;
  for(let v=0;v<=maxV;v+=gs){const y=yP(v);ctx.beginPath();ctx.moveTo(PL,y);ctx.lineTo(W-PR,y);ctx.stroke();ctx.textAlign='right';ctx.fillText(v+'',PL-6,y+3);}
  ctx.fillStyle='rgba(34,197,94,0.06)'; ctx.fillRect(PL,yP(25),cW,yP(12)-yP(25));
  const wp=new Path2D(); wp.moveTo(xP(history[0].ts),yP(history[0].wind));
  for(let i=1;i<history.length;i++) wp.lineTo(xP(history[i].ts),yP(history[i].wind));
  wp.lineTo(xP(history[history.length-1].ts),yP(0)); wp.lineTo(xP(history[0].ts),yP(0)); wp.closePath();
  const g=ctx.createLinearGradient(0,PT,0,PT+cH); g.addColorStop(0,'rgba(56,189,248,0.25)'); g.addColorStop(1,'rgba(56,189,248,0.02)');
  ctx.fillStyle=g; ctx.fill(wp);
  ctx.beginPath(); ctx.moveTo(xP(history[0].ts),yP(history[0].wind));
  for(let i=1;i<history.length;i++) ctx.lineTo(xP(history[i].ts),yP(history[i].wind));
  ctx.strokeStyle='#38bdf8'; ctx.lineWidth=2; ctx.setLineDash([]); ctx.stroke();
  ctx.beginPath(); ctx.setLineDash([4,4]); ctx.moveTo(xP(history[0].ts),yP(history[0].gust));
  for(let i=1;i<history.length;i++) ctx.lineTo(xP(history[i].ts),yP(history[i].gust));
  ctx.strokeStyle='rgba(234,179,8,0.6)'; ctx.lineWidth=1.5; ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle='#8899a6'; ctx.font='10px -apple-system,sans-serif'; ctx.textAlign='center';
  const st=Math.max(1,Math.floor(history.length/6));
  for(let i=0;i<history.length;i+=st){const x=xP(history[i].ts);const ms=toMs(history[i].ts);ctx.fillText(new Date(ms).toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}),x,H-8);ctx.beginPath();ctx.moveTo(x,PT+cH);ctx.lineTo(x,PT+cH+4);ctx.strokeStyle='rgba(255,255,255,0.15)';ctx.lineWidth=1;ctx.stroke();}
  const last=history[history.length-1]; ctx.beginPath(); ctx.arc(xP(last.ts),yP(last.wind),4,0,Math.PI*2); ctx.fillStyle='#38bdf8'; ctx.fill();
  ctx.restore();
  // Update label with actual span
  if (label) {
    const spanMin = Math.round(spanMs / 60000);
    const spanLabel = spanMin >= 90 ? 'Last ' + Math.round(spanMin/60) + ' hrs' : 'Last ' + spanMin + ' min';
    label.textContent = spanLabel;
  }
}
<\/script>
</body>
</html>`;
}

// Server-side HTML escaping (used in the spot name in <title>)
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Fetch wind data directly from KV/WeatherLink without going through the Access-protected API
async function fetchWindDirect(spotId, token, env) {
  const HISTORY_KEY = `wind-history:${spotId}`;
  const CURRENT_KEY = `wind-current:${spotId}`;
  const MIN_INTERVAL = 30; // seconds

  let current = null;
  let history = [];

  try {
    // Load history from KV
    const rawHistory = await env.CACHE.get(HISTORY_KEY, { type: 'json' });
    if (rawHistory && Array.isArray(rawHistory)) history = rawHistory;

    // Check cached current
    const cachedCurrent = await env.CACHE.get(CURRENT_KEY, { type: 'json' });
    const now = Math.floor(Date.now() / 1000);

    if (cachedCurrent && (now - cachedCurrent.ts) < MIN_INTERVAL) {
      current = cachedCurrent.data;
    } else if (token.startsWith('ndbc:')) {
      // NDBC buoy
      const stid = token.slice(5).toUpperCase();
      const resp = await fetch(`https://www.ndbc.noaa.gov/data/realtime2/${stid}.txt`, {
        signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'KiteConditions/1.0' },
      });
      if (resp.ok) {
        const lines = (await resp.text()).trim().split('\n').filter(l => !l.startsWith('#'));
        if (lines.length) {
          const p = lines[0].trim().split(/\s+/);
          const MPS = 2.23694;
          const wspd = parseFloat(p[6]), gst = parseFloat(p[7]), wdir = parseFloat(p[5]), atmp = parseFloat(p[13]);
          const readingTs = Date.UTC(...p.slice(0,5).map(Number).map((v,i) => i===1 ? v-1 : v));
          current = {
            wind: isNaN(wspd) ? 0 : Math.round(wspd * MPS * 10) / 10,
            gust: isNaN(gst) ? 0 : Math.round(gst * MPS * 10) / 10,
            wind_dir: isNaN(wdir) ? 0 : wdir,
            wind_dir_cardinal: degreesToCardinal(isNaN(wdir) ? 0 : wdir),
            temp: isNaN(atmp) ? null : Math.round(atmp * 9/5 + 32),
            wind_units: 'mph', last_received: new Date(readingTs).toISOString(),
          };
          await env.CACHE.put(CURRENT_KEY, JSON.stringify({ ts: now, data: current }), { expirationTtl: 120 });
        }
      }
    } else {
      // WeatherLink
      const resp = await fetch(`https://www.weatherlink.com/embeddablePage/getData/${token}`, {
        signal: AbortSignal.timeout(8000), headers: { 'User-Agent': 'KiteConditions/1.0' },
      });
      if (resp.ok) {
        const d = await resp.json();
        current = {
          wind: parseFloat(d.wind) || 0,
          gust: parseFloat(d.gust) || 0,
          wind_dir: d.windDirection || 0,
          wind_dir_cardinal: degreesToCardinal(d.windDirection || 0),
          temp: parseFloat(d.temperature) || null,
          feels_like: parseFloat(d.temperatureFeelLike) || null,
          humidity: parseFloat(d.humidity) || null,
          hi_temp: parseFloat(d.hiTemp) || null,
          lo_temp: parseFloat(d.loTemp) || null,
          barometer: d.barometer || null,
          barometer_trend: d.barometerTrend || null,
          wind_units: d.windUnits || 'mph',
          last_received: d.lastReceived || null,
          station_location: d.systemLocation || null,
        };
        await env.CACHE.put(CURRENT_KEY, JSON.stringify({ ts: now, data: current }), { expirationTtl: 120 });
        // Append to history
        const lastReading = history.length > 0 ? history[history.length - 1] : null;
        if (!lastReading || lastReading.ts !== current.last_received) {
          history.push({ ts: Date.now(), wind: current.wind, gust: current.gust, dir: current.wind_dir, temp: current.temp });
          const cutoff = Date.now() - 6 * 60 * 60 * 1000;
          history = history.filter(h => h.ts > cutoff);
          await env.CACHE.put(HISTORY_KEY, JSON.stringify(history), { expirationTtl: 86400 });
        }
      }
    }
  } catch (e) {
    // Fall back to cached current if available
    if (!current) {
      const c = await env.CACHE.get(CURRENT_KEY, { type: 'json' }).catch(() => null);
      if (c) current = c.data;
    }
  }

  if (!current) return null;
  return { current, history, history_hours: 6 };
}

function degreesToCardinal(deg) {
  const dirs = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
  return dirs[Math.round(((deg % 360) + 360) % 360 / 22.5) % 16];
}
