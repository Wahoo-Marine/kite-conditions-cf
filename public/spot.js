const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

const params = new URLSearchParams(location.search);
const spotId = params.get('id');
const isShareView = params.get('share') === '1';
if (!spotId) { location.href = '/'; }

let currentDays = parseInt(localStorage.getItem('kite_days') || '7');
let currentOffset = parseInt(localStorage.getItem('kite_offset') || '0');
let webcamTimers = [];

document.addEventListener('DOMContentLoaded', () => {
  if (isShareView) document.body.classList.add('share-mode');
  initRangePicker();
  loadSpot();
});

function initRangePicker() {
  $$('.range-btn').forEach(btn => {
    const d = parseInt(btn.dataset.days);
    btn.classList.toggle('active', d === currentDays);
    btn.addEventListener('click', () => {
      currentDays = d;
      localStorage.setItem('kite_days', d);
      $$('.range-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      loadSpot();
    });
  });
  const sel = $('#offset-sel');
  sel.value = currentOffset;
  sel.addEventListener('change', () => {
    currentOffset = parseInt(sel.value);
    localStorage.setItem('kite_offset', currentOffset);
    loadSpot();
  });
}

async function loadSpot() {
  showLoading(true);
  try {
    const res = await fetch(`/api/spot/${spotId}?offset=${currentOffset}&days=${currentDays}`);
    if (!res.ok) throw new Error('Spot not found');
    const data = await res.json();
    renderSpot(data);
  } catch (err) {
    console.error(err);
    $('#spot-hero').innerHTML = `<p style="color:var(--text-muted);">Error: ${err.message}</p>`;
  } finally {
    showLoading(false);
  }
}

function renderSpot(data) {
  const { spot, current } = data;
  const days = spot.days || [];
  const webcams = spot.webcams || [];
  hasWeatherStation = !!spot.weather_station;
  document.title = `🪁 ${spot.name} — Kite Conditions`;

  // Hero
  let heroHTML = `<div class="spot-name">${esc(spot.name)}</div>`;
  heroHTML += `<div class="spot-meta">${spot.lat.toFixed(4)}°N, ${spot.lon.toFixed(4)}°W</div>`;

  if (current) {
    const curRatingLabel = { 'send-it': 'SEND IT', maybe: 'MAYBE', nope: 'NOPE', unknown: '?' }[current.rating] || '?';
    const curRatingEmoji = { 'send-it': '🟢', maybe: '🟡', nope: '🔴', unknown: '⚪' }[current.rating] || '⚪';

    heroHTML += '<div class="current-conditions">';
    heroHTML += '<div class="current-wind">';
    heroHTML += `<div class="wind-value" style="color:${windColor(current.wind)}">${Math.round(current.wind)}</div>`;
    heroHTML += '<div class="wind-unit">mph</div>';
    heroHTML += `<div class="wind-dir">${current.dir || ''}</div>`;
    heroHTML += '</div>';
    heroHTML += '<div class="current-details">';
    heroHTML += detailItem('Gusts', `${Math.round(current.gust)} mph`);
    heroHTML += detailItem('Temp', `${Math.round(current.temp)}°F`);
    heroHTML += detailItem('Weather', `${current.sky_icon || ''} ${current.sky || ''}`);
    heroHTML += detailItem('Rating', `${curRatingEmoji} ${curRatingLabel}`);
    heroHTML += '</div>';
    heroHTML += '</div>';
    const rc = ratingClass(current.rating);
    heroHTML += `<div class="current-rating ${rc}" style="margin-top:0.8rem;">${curRatingEmoji} ${curRatingLabel}</div>`;
  } else {
    heroHTML += '<div class="no-current">Current conditions not available</div>';
  }

  $('#spot-hero').innerHTML = heroHTML;

  // Webcams
  webcamTimers.forEach(t => clearInterval(t));
  webcamTimers = [];
  const wcSection = $('#webcams-section');

  if (webcams && webcams.length > 0) {
    wcSection.style.display = 'block';
    let wcHTML = '<div class="webcams-header">📹 Live Webcams</div>';
    wcHTML += '<div class="webcams-grid">';
    webcams.forEach((cam, idx) => {
      if (cam.twitch) {
        // Twitch: official iframe embed player
        const twitchParent = window.location.hostname;
        wcHTML += `<div class="webcam-card">
          <div class="webcam-iframe-wrap">
            <iframe
              src="https://player.twitch.tv/?channel=${encodeURIComponent(cam.twitch)}&parent=${twitchParent}&autoplay=true&muted=true"
              allowfullscreen
              allow="autoplay; encrypted-media"
              style="border:0;width:100%;height:100%;"
            ></iframe>
          </div>
          <div class="webcam-footer">
            <span class="webcam-label">${esc(cam.label)}</span>
            <span class="live-badge"><span class="live-dot"></span> LIVE</span>
          </div>
        </div>`;
      } else if (cam.youtube) {
        // YouTube live stream embed
        wcHTML += `<div class="webcam-card">
          <div class="webcam-iframe-wrap">
            <iframe
              src="https://www.youtube.com/embed/${encodeURIComponent(cam.youtube)}?autoplay=1&mute=1&rel=0&modestbranding=1"
              allowfullscreen
              allow="autoplay; encrypted-media"
              style="border:0;"
            ></iframe>
          </div>
          <div class="webcam-footer">
            <span class="webcam-label">${esc(cam.label)}</span>
            <span class="live-badge"><span class="live-dot"></span> LIVE</span>
          </div>
        </div>`;
      } else if (cam.hazcam) {
        // Hazcams image snapshot (auto-refreshing weather cams)
        const imgSrc = `https://data.hazcams.com/thumbnails/${encodeURIComponent(cam.hazcam)}/large.webp?ts=${Date.now()}`;
        wcHTML += `<div class="webcam-card">
          <a class="webcam-img-wrap" href="https://hazcams.com/station/${encodeURIComponent(cam.hazcam)}" target="_blank" rel="noopener" title="View live stream">
            <img id="wc-img-${idx}" src="${imgSrc}" alt="${esc(cam.label)}" loading="lazy">
          </a>
          <div class="webcam-footer">
            <span class="webcam-label">${esc(cam.label)}</span>
            <span class="live-badge"><span class="live-dot"></span> LIVE</span>
          </div>
        </div>`;
      } else if (cam.oid) {
        // Ozolio HLS live video player with poster fallback
        const posterSrc = `https://relay.ozolio.com/pub.api?cmd=poster&oid=${encodeURIComponent(cam.oid)}&ts=${Date.now()}`;
        const camViewerUrl = `/cam?oid=${encodeURIComponent(cam.oid)}&label=${encodeURIComponent(cam.label)}`;
        wcHTML += `<div class="webcam-card">
          <div class="webcam-iframe-wrap" style="position:relative;background:#000;">
            <video id="wc-video-${idx}" class="webcam-hls-video"
              poster="${posterSrc}"
              autoplay muted playsinline
              style="width:100%;height:100%;object-fit:cover;cursor:pointer;"
              onclick="window.open('${camViewerUrl}','_blank')"
              title="Click for fullscreen"
            ></video>
            <div id="wc-loading-${idx}" style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#fff;font-size:.7rem;opacity:.7;pointer-events:none;">Loading live video…</div>
          </div>
          <div class="webcam-footer">
            <span class="webcam-label">${esc(cam.label)}</span>
            <span class="live-badge"><span class="live-dot"></span> LIVE</span>
          </div>
        </div>`;
      }
    });
    wcHTML += '</div>';
    wcSection.innerHTML = wcHTML;

    // Initialize HLS live video for Ozolio webcams
    const ozolioCams = webcams.filter(c => c.oid);
    if (ozolioCams.length > 0) {
      ozolioCams.forEach((cam, i) => {
        const idx = webcams.indexOf(cam);
        initOzolioHLS(cam.oid, idx);
      });
    }
    // Auto-refresh Hazcam thumbnails every 60s
    const hazcamCams = webcams.filter(c => c.hazcam);
    if (hazcamCams.length > 0) {
      const hzTimer = setInterval(() => {
        webcams.forEach((cam, idx) => {
          if (!cam.hazcam) return;
          const img = document.getElementById(`wc-img-${idx}`);
          if (img) img.src = `https://data.hazcams.com/thumbnails/${encodeURIComponent(cam.hazcam)}/large.webp?ts=${Date.now()}`;
        });
      }, 60000);
      webcamTimers.push(hzTimer);
    }
  } else {
    wcSection.style.display = 'none';
  }

  // Day Tabs + Panels
  if (!days || days.length === 0) {
    $('#day-tabs').innerHTML = '';
    $('#day-panels').innerHTML = '<div style="text-align:center;padding:2rem;color:var(--text-muted);">No forecast data available.</div>';
    return;
  }

  const dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
  let tabsHTML = '';
  let panelsHTML = '';

  days.forEach((d, i) => {
    const dt = new Date(d.date + 'T12:00:00');
    const dayName = dayNames[dt.getDay()];
    const mon = dt.getMonth() + 1;
    const dd = dt.getDate();
    const rc = ratingClass(d.rating);
    const active = i === 0 ? 'active' : '';

    tabsHTML += `<button class="day-tab ${active}" data-idx="${i}">
      <div>${dayName} ${mon}/${dd}</div>
      <div class="tab-rating" style="color:var(--${rc === 'send-it' ? 'send-it' : rc === 'maybe' ? 'maybe' : 'nope'})">${d.rating_emoji || ''} ${d.avg_wind != null ? Math.round(d.avg_wind) : '?'} mph</div>
    </button>`;

    panelsHTML += `<div class="day-panel ${active}" data-idx="${i}">`;

    // Summary
    const midIcon = d.hours && d.hours.length > 0 ? (d.hours[Math.floor(d.hours.length/2)]?.sky_icon || '') : '';
    const midSky = d.hours && d.hours.length > 0 ? (d.hours[Math.floor(d.hours.length/2)]?.sky || '') : '';
    panelsHTML += '<div class="day-summary">';
    panelsHTML += summaryItem('Avg Wind', `${Math.round(d.avg_wind)} mph`);
    panelsHTML += summaryItem('Max Gust', `${Math.round(d.max_gust)} mph`);
    panelsHTML += summaryItem('Temp', `${d.hi != null ? d.hi : '?'}° / ${d.lo != null ? d.lo : '?'}°`);
    panelsHTML += summaryItem('Weather', `${midIcon} ${midSky}`);
    panelsHTML += `<div class="stat"><div class="stat-label">Rating</div><div class="rating-badge ${rc}">${d.rating_emoji || ''} ${d.rating_label || ''}</div></div>`;
    panelsHTML += '</div>';

    // Tide Chart
    if (d.tide && d.tide.hourly && d.tide.hourly.length > 0) {
      panelsHTML += '<div class="tide-chart-section">';
      panelsHTML += '<div class="tide-chart-header">🌊 Tides</div>';
      panelsHTML += `<canvas class="tide-canvas" id="tide-canvas-${i}" height="120"></canvas>`;
      panelsHTML += '<div class="tide-extremes">';
      (d.tide.extremes || []).forEach(e => {
        const cls = e.type === 'H' ? 'tide-high' : 'tide-low';
        const label = e.type === 'H' ? '▲ High' : '▼ Low';
        panelsHTML += `<span class="tide-extreme ${cls}">${label} ${e.time} (${e.level}m)</span>`;
      });
      panelsHTML += '</div>';
      panelsHTML += '</div>';
    }

    // Hourly Table
    panelsHTML += '<div style="overflow-x:auto;">';
    panelsHTML += '<table class="hourly-table"><thead><tr>';
    panelsHTML += '<th>Time</th><th>Wind</th><th>Gusts</th><th>Dir</th><th class="hide-mobile">Temp</th><th class="hide-mobile">Weather</th><th>Rating</th>';
    panelsHTML += '</tr></thead><tbody>';

    if (d.hours && d.hours.length > 0) {
      d.hours.forEach(hr => {
        const hrc = ratingClass(hr.rating);
        const rowClass = hr.rating === 'send-it' ? 'send-it-row' : (hr.rating === 'nope' ? 'nope-row' : '');
        const gustCls = gustColorClass(hr.gust);
        const hrRatingLabel = { 'send-it': 'SEND IT', maybe: 'MAYBE', nope: 'NOPE', unknown: '?' }[hr.rating] || '?';
        const hrRatingEmoji = { 'send-it': '🟢', maybe: '🟡', nope: '🔴', unknown: '⚪' }[hr.rating] || '⚪';

        panelsHTML += `<tr class="${rowClass}">`;
        panelsHTML += `<td>${hr.time || ''}</td>`;
        panelsHTML += `<td class="wind-cell" style="color:${windColor(hr.wind)}">${Math.round(hr.wind)} mph</td>`;
        panelsHTML += `<td class="gc-gust ${gustCls}">${Math.round(hr.gust)} mph</td>`;
        panelsHTML += `<td>${hr.dir || ''}</td>`;
        panelsHTML += `<td class="hide-mobile">${Math.round(hr.temp)}°F</td>`;
        panelsHTML += `<td class="hide-mobile">${hr.sky_icon || ''} ${hr.sky || ''}</td>`;
        panelsHTML += `<td class="rating-cell ${hrc}">${hrRatingEmoji} ${hrRatingLabel}</td>`;
        panelsHTML += '</tr>';
      });
    } else {
      panelsHTML += '<tr><td colspan="7" style="text-align:center;color:var(--text-muted);">No hourly data</td></tr>';
    }

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
      document.querySelector(`.day-panel[data-idx="${idx}"]`).classList.add('active');
      // Re-render tide chart for this day now that it's visible
      const d = days[parseInt(idx)];
      if (d && d.tide && d.tide.hourly && d.tide.hourly.length > 0) {
        renderTideChart(parseInt(idx), d.tide, d.date, days, spot.timezone);
      }
    });
  });

  // Render tide charts for each day that has tide data
  days.forEach((d, i) => {
    if (d.tide && d.tide.hourly && d.tide.hourly.length > 0) {
      renderTideChart(i, d.tide, d.date, days, spot.timezone);
    }
  });

  // Redraw tide charts on resize
  window.addEventListener('resize', () => {
    days.forEach((d, i) => {
      if (d.tide && d.tide.hourly && d.tide.hourly.length > 0) {
        renderTideChart(i, d.tide, d.date, days, spot.timezone);
      }
    });
  });

  // Init live wind station if available
  initWindStation();
}

// ── Helpers ───────────────────────────
function detailItem(label, value) {
  return `<div class="detail-item"><div class="detail-label">${label}</div><div class="detail-value">${value}</div></div>`;
}
function summaryItem(label, value) {
  return `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value">${value}</div></div>`;
}
function ratingClass(r) { return r === 'send-it' ? 'send-it' : (r === 'maybe' ? 'maybe' : 'nope'); }
function gustColorClass(g) { return g < 25 ? 'gust-low' : (g < 35 ? 'gust-med' : 'gust-high'); }
function windColor(w) { return w >= 15 ? 'var(--send-it)' : (w >= 12 ? 'var(--maybe)' : 'var(--text-muted)'); }
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// Fetch Twitch HLS URL from our proxy Worker and play with native <video>
async function initTwitchHLS(channel, idx) {
  const video = document.getElementById(`wc-video-${idx}`);
  const loadingEl = document.getElementById(`wc-loading-${idx}`);
  if (!video) return;

  try {
    if (loadingEl) loadingEl.textContent = 'Connecting to stream…';

    const hlsUrl = `/api/twitch-hls/${encodeURIComponent(channel)}`;

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS (Safari / iOS) — plays directly
      video.src = hlsUrl;
      video.play().catch(() => {});
      if (loadingEl) loadingEl.style.display = 'none';
    } else if (typeof Hls !== 'undefined' && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: false, // keep on main thread so cookies/credentials are always included
        lowLatencyMode: true,
        maxBufferLength: 10,
        maxMaxBufferLength: 30,
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 5,
        liveDurationInfinity: true,
      });
      hls.loadSource(hlsUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
        if (loadingEl) loadingEl.style.display = 'none';
      });
      hls.on(Hls.Events.ERROR, async (event, data) => {
        // Show non-fatal errors in the loading indicator for diagnosis
        if (!data.fatal) {
          console.warn('HLS non-fatal:', data.type, data.details, data.response?.code);
          return;
        }
        console.error('HLS fatal:', data.type, data.details, data.response?.code, data.response?.url);
        hls.destroy();

        // Surface the error visibly for diagnosis
        const errMsg = `${data.type} / ${data.details}` + (data.response?.code ? ` (HTTP ${data.response.code})` : '');

        // Check whether Access is blocking us (session expired)
        try {
          const probe = await fetch(hlsUrl, { redirect: 'manual' });
          if (probe.type === 'opaqueredirect' || probe.status === 0) {
            twitchAuthExpired(channel, idx);
            return;
          }
        } catch (e) { /* fall through */ }

        twitchFallback(channel, idx, true, errMsg);
      });
      video._hls = hls;
    } else {
      throw new Error('HLS not supported in this browser');
    }
  } catch (err) {
    console.warn('Twitch HLS failed for', channel, err.message);
    twitchFallback(channel, idx, true, err.message);
  }
}

// Show session-expired overlay with a re-login link
function twitchAuthExpired(channel, idx) {
  const video = document.getElementById(`wc-video-${idx}`);
  if (!video) return;
  const wrap = video.parentElement;
  if (!wrap) return;
  if (video._hls) video._hls.destroy();
  const thumbUrl = `https://static-cdn.jtvnw.net/previews-ttv/live_user_${encodeURIComponent(channel)}-440x248.jpg`;
  wrap.style.position = 'relative';
  wrap.innerHTML = `
    <img style="width:100%;height:100%;object-fit:cover;filter:brightness(0.4);" src="${thumbUrl}?ts=${Date.now()}">
    <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.75rem;color:#fff;text-align:center;padding:1rem;">
      <div style="font-size:1.5rem;">🔒</div>
      <div style="font-size:.85rem;font-weight:600;">Session expired</div>
      <a href="/" style="background:var(--accent);color:#fff;padding:.4rem 1rem;border-radius:8px;font-size:.8rem;text-decoration:none;">Re-login →</a>
    </div>`;
}

function twitchFallback(channel, idx, retry = false, errMsg = '') {
  // Fall back to auto-refreshing thumbnail
  const video = document.getElementById(`wc-video-${idx}`);
  if (!video) return;
  const wrap = video.parentElement;
  if (!wrap) return;
  const thumbUrl = `https://static-cdn.jtvnw.net/previews-ttv/live_user_${encodeURIComponent(channel)}-440x248.jpg`;

  // If stream was temporarily offline, add a retry button + schedule auto-retry
  const retryBtn = retry
    ? `<button onclick="location.reload()" style="margin-top:.5rem;background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.4);color:#fff;padding:.3rem .9rem;border-radius:6px;cursor:pointer;font-size:.75rem;">↺ Retry</button>`
    : '';

  const img = document.createElement('img');
  img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
  img.src = thumbUrl + '?ts=' + Date.now();
  const loading = document.getElementById(`wc-loading-${idx}`);
  if (loading) loading.style.display = 'none';
  if (video._hls) video._hls.destroy();

  if (retry) {
    // Show thumbnail + overlay with retry button
    wrap.style.position = 'relative';
    wrap.innerHTML = `
      <img style="width:100%;height:100%;object-fit:cover;filter:brightness(0.5);" src="${thumbUrl}?ts=${Date.now()}">
      <div style="position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:.5rem;color:#fff;text-align:center;padding:1rem;">
        <div style="font-size:.8rem;color:rgba(255,255,255,.8);">Stream offline or unavailable</div>
        ${errMsg ? `<div style="font-size:.65rem;color:rgba(255,255,255,.5);font-family:monospace;max-width:90%;word-break:break-all;">${errMsg}</div>` : ''}
        <button onclick="initTwitchHLS('${channel}', ${idx})" style="background:rgba(255,255,255,.15);border:1px solid rgba(255,255,255,.4);color:#fff;padding:.3rem .9rem;border-radius:6px;cursor:pointer;font-size:.75rem;">↺ Retry</button>
      </div>`;
    // Also auto-retry after 90s
    const t = setTimeout(() => initTwitchHLS(channel, idx), 90000);
    webcamTimers.push(t);
  } else {
    wrap.replaceChild(img, video);
    const t = setInterval(() => { img.src = thumbUrl + '?ts=' + Date.now(); }, 30000);
    webcamTimers.push(t);
  }
}

// ── Ozolio HLS Live Video ─────────────
async function initOzolioHLS(oid, idx) {
  const video = document.getElementById(`wc-video-${idx}`);
  const loadingEl = document.getElementById(`wc-loading-${idx}`);
  if (!video) return;

  try {
    // Step 1: Initialize Ozolio session
    const docUrl = `https://relay.ozolio.com/pub.cgi?cmd=iframe&oid=${oid}`;
    const initResp = await fetch(
      `https://relay.ozolio.com/ses.api?cmd=init&oid=${encodeURIComponent(oid)}&ver=5&channel=0&control=0&document=${encodeURIComponent(docUrl)}`
    );
    if (!initResp.ok) throw new Error('Session init failed: ' + initResp.status);
    const initData = await initResp.json();
    const sessionId = initData.session.id;

    // Step 2: Open session to get HLS stream URL
    const openResp = await fetch(
      `https://relay.ozolio.com/ses.api?cmd=open&oid=${encodeURIComponent(sessionId)}&output=1&format=M3U8&profile=base`
    );
    if (!openResp.ok) throw new Error('Session open failed: ' + openResp.status);
    const openData = await openResp.json();
    const hlsUrl = openData.output.source;

    if (!hlsUrl) throw new Error('No HLS source URL returned');

    // Step 3: Play the HLS stream
    if (loadingEl) loadingEl.textContent = 'Connecting…';

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Native HLS support (Safari / iOS)
      video.src = hlsUrl;
      video.play().catch(() => {});
      if (loadingEl) loadingEl.style.display = 'none';
    } else if (typeof Hls !== 'undefined' && Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        maxBufferLength: 10,
        maxMaxBufferLength: 30,
        liveSyncDurationCount: 2,
        liveMaxLatencyDurationCount: 5,
        liveDurationInfinity: true,
      });
      hls.loadSource(hlsUrl);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        video.play().catch(() => {});
        if (loadingEl) loadingEl.style.display = 'none';
      });
      hls.on(Hls.Events.ERROR, (event, data) => {
        if (data.fatal) {
          console.warn('HLS fatal error for', oid, data.type, data.details);
          hls.destroy();
          fallbackToPosterRefresh(oid, idx);
        }
      });
      // Store reference for cleanup
      video._hls = hls;
    } else {
      throw new Error('HLS not supported');
    }
  } catch (err) {
    console.warn('Ozolio HLS init failed for', oid, err.message);
    fallbackToPosterRefresh(oid, idx);
  }
}

function fallbackToPosterRefresh(oid, idx) {
  // Replace video with auto-refreshing poster image
  const video = document.getElementById(`wc-video-${idx}`);
  if (!video) return;
  const wrap = video.parentElement;
  if (!wrap) return;
  const camViewerUrl = `/cam?oid=${encodeURIComponent(oid)}&label=`;
  const img = document.createElement('img');
  img.id = `wc-img-${idx}`;
  img.style.cssText = 'width:100%;height:100%;object-fit:cover;';
  img.src = `https://relay.ozolio.com/pub.api?cmd=poster&oid=${encodeURIComponent(oid)}&ts=${Date.now()}`;
  // Remove loading text
  const loading = document.getElementById(`wc-loading-${idx}`);
  if (loading) loading.style.display = 'none';
  // Clean up video
  if (video._hls) video._hls.destroy();
  wrap.replaceChild(img, video);
  // Auto-refresh every 5s
  const t = setInterval(() => {
    const el = document.getElementById(`wc-img-${idx}`);
    if (el) el.src = `https://relay.ozolio.com/pub.api?cmd=poster&oid=${encodeURIComponent(oid)}&ts=${Date.now()}`;
  }, 5000);
  webcamTimers.push(t);
}
function showLoading(on) {
  $('#loading-overlay').classList.toggle('hidden', !on);
  $('#app').style.display = on ? 'none' : 'block';
}

// ── Tide Chart ────────────────────────
function renderTideChart(dayIdx, tide, dayDate, allDays = [], spotTimezone) {
  const canvas = document.getElementById(`tide-canvas-${dayIdx}`);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  // Walk up the DOM to find a visible ancestor with a real width.
  // getBoundingClientRect returns 0 when the element is inside a hidden tab panel.
  function getAvailableWidth(el) {
    let node = el;
    while (node) {
      const w = node.getBoundingClientRect().width;
      if (w > 0) return w;
      node = node.parentElement;
    }
    return el.closest('.day-panels-wrap')?.offsetWidth
      || document.querySelector('.spot-content')?.offsetWidth
      || document.documentElement.clientWidth
      || 360;
  }
  // Subtract the section padding (0.6rem each side ≈ 19px total)
  const W = Math.floor(getAvailableWidth(canvas.parentElement) - 19);
  const H = 120;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.scale(dpr, dpr);

  ctx.clearRect(0, 0, W, H);

  const hourly = tide.hourly || [];
  if (!hourly.length) return;

  function dateToDayIndex(dateStr) {
    const [year, month, day] = dateStr.split('-').map(Number);
    return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
  }

  function timeToMinutes(timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    return (h * 60) + m;
  }

  function toScalarMinutes(dateStr, timeStr) {
    return dateToDayIndex(dateStr) * 1440 + timeToMinutes(timeStr);
  }

  function formatHourLabelFromScalar(scalarMinutes) {
    const minuteOfDay = ((scalarMinutes % 1440) + 1440) % 1440;
    const hour24 = Math.floor(minuteOfDay / 60);
    const suffix = hour24 >= 12 ? 'p' : 'a';
    const hour12 = hour24 % 12 || 12;
    return `${hour12}${suffix}`;
  }

  function getSpotNow(timeZone) {
    if (!timeZone) {
      const now = new Date();
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, '0');
      const d = String(now.getDate()).padStart(2, '0');
      const hh = String(now.getHours()).padStart(2, '0');
      const mm = String(now.getMinutes()).padStart(2, '0');
      return { date: `${y}-${m}-${d}`, time: `${hh}:${mm}` };
    }

    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date());

    const pick = type => parts.find(p => p.type === type)?.value || '';
    return {
      date: `${pick('year')}-${pick('month')}-${pick('day')}`,
      time: `${pick('hour')}:${pick('minute')}`,
    };
  }

  const spotNow = getSpotNow(spotTimezone);
  const nowScalar = toScalarMinutes(spotNow.date, spotNow.time);
  const anchorScalar = dayDate === spotNow.date
    ? nowScalar
    : toScalarMinutes(dayDate, '12:00');
  const windowStartScalar = anchorScalar - (6 * 60);
  const windowEndScalar = anchorScalar + (18 * 60);
  const windowSpanScalar = windowEndScalar - windowStartScalar;

  const tideDays = (allDays && allDays.length > 0)
    ? allDays.filter(d => d.tide && d.tide.hourly && d.tide.hourly.length > 0)
    : [{ date: dayDate, tide }];

  let series = tideDays.flatMap(d =>
    d.tide.hourly.map(h => ({
      ts: toScalarMinutes(d.date, h.time),
      time: h.time,
      level: h.level,
      date: d.date,
    }))
  );

  series = series
    .filter(p => p.ts >= windowStartScalar && p.ts <= windowEndScalar)
    .sort((a, b) => a.ts - b.ts);

  if (series.length < 2) {
    series = hourly.map(h => ({
      ts: toScalarMinutes(dayDate, h.time),
      time: h.time,
      level: h.level,
      date: dayDate,
    }));
  }

  const extremes = tideDays.flatMap(d =>
    (d.tide.extremes || []).map(e => ({
      ...e,
      ts: toScalarMinutes(d.date, e.time),
      date: d.date,
    }))
  ).filter(e => e.ts >= windowStartScalar && e.ts <= windowEndScalar);

  const PAD_LEFT = 36;
  const PAD_RIGHT = 12;
  const PAD_TOP = 12;
  const PAD_BOTTOM = 22;
  const chartW = W - PAD_LEFT - PAD_RIGHT;
  const chartH = H - PAD_TOP - PAD_BOTTOM;

  const levels = series.map(h => h.level);
  const minLvl = Math.min(...levels) - 0.05;
  const maxLvl = Math.max(...levels) + 0.05;
  const range = maxLvl - minLvl || 0.1;

  function xPos(ts) {
    return PAD_LEFT + ((ts - windowStartScalar) / windowSpanScalar) * chartW;
  }
  function yPos(level) {
    return PAD_TOP + chartH - ((level - minLvl) / range) * chartH;
  }

  // Background
  ctx.fillStyle = 'rgba(26, 39, 51, 0.6)';
  ctx.fillRect(0, 0, W, H);

  // Grid lines
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  ctx.font = '9px -apple-system, sans-serif';
  ctx.fillStyle = '#8899a6';

  const step = range > 0.5 ? 0.2 : 0.1;
  const gridStart = Math.ceil(minLvl / step) * step;
  for (let v = gridStart; v <= maxLvl; v += step) {
    const y = yPos(v);
    ctx.beginPath();
    ctx.moveTo(PAD_LEFT, y);
    ctx.lineTo(W - PAD_RIGHT, y);
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText(v.toFixed(1) + 'm', PAD_LEFT - 4, y + 3);
  }

  // Zero line (mean sea level)
  if (minLvl <= 0 && maxLvl >= 0) {
    ctx.beginPath();
    ctx.moveTo(PAD_LEFT, yPos(0));
    ctx.lineTo(W - PAD_RIGHT, yPos(0));
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.25)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Tide curve — filled area
  const areaPath = new Path2D();
  areaPath.moveTo(xPos(series[0].ts), yPos(series[0].level));
  for (let i = 1; i < series.length; i++) {
    areaPath.lineTo(xPos(series[i].ts), yPos(series[i].level));
  }
  areaPath.lineTo(xPos(series[series.length - 1].ts), yPos(minLvl));
  areaPath.lineTo(xPos(series[0].ts), yPos(minLvl));
  areaPath.closePath();

  const grad = ctx.createLinearGradient(0, PAD_TOP, 0, PAD_TOP + chartH);
  grad.addColorStop(0, 'rgba(56, 189, 248, 0.25)');
  grad.addColorStop(1, 'rgba(56, 189, 248, 0.03)');
  ctx.fillStyle = grad;
  ctx.fill(areaPath);

  // Tide curve line
  ctx.beginPath();
  ctx.moveTo(xPos(series[0].ts), yPos(series[0].level));
  for (let i = 1; i < series.length; i++) {
    ctx.lineTo(xPos(series[i].ts), yPos(series[i].level));
  }
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Extreme markers
  extremes.forEach(e => {
    const x = xPos(e.ts);
    const y = yPos(e.level);
    const isHigh = e.type === 'H';

    // Dot
    ctx.beginPath();
    ctx.arc(x, y, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = isHigh ? '#22c55e' : '#ef4444';
    ctx.fill();

    // Label
    ctx.font = 'bold 9px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillStyle = isHigh ? '#22c55e' : '#ef4444';
    const labelY = isHigh ? y - 7 : y + 12;
    ctx.fillText(`${isHigh ? '▲' : '▼'} ${e.level}m`, x, labelY);
  });

  // Time labels on x-axis
  ctx.fillStyle = '#8899a6';
  ctx.font = '9px -apple-system, sans-serif';
  ctx.textAlign = 'center';
  for (let h = 0; h <= 24; h += 6) {
    const ts = windowStartScalar + (h * 60);
    const x = xPos(ts);
    ctx.fillText(formatHourLabelFromScalar(ts), x, H - 5);
    // Tick
    ctx.beginPath();
    ctx.moveTo(x, PAD_TOP + chartH);
    ctx.lineTo(x, PAD_TOP + chartH + 3);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  if (dayDate === spotNow.date && nowScalar >= windowStartScalar && nowScalar <= windowEndScalar) {
    const xNow = xPos(nowScalar);
    ctx.beginPath();
    ctx.moveTo(xNow, PAD_TOP);
    ctx.lineTo(xNow, PAD_TOP + chartH);
    ctx.strokeStyle = 'rgba(255,255,255,0.3)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

// ── Live Wind Station ─────────────────
let windRefreshTimer = null;
let hasWeatherStation = false;
let lastWindHistory = null;
let lastWindHours = 6;

function initWindStation() {
  if (!hasWeatherStation) return;
  const section = $('#wind-station-section');
  section.style.display = 'block';
  loadWindData();
  // Auto-refresh every 60s
  if (windRefreshTimer) clearInterval(windRefreshTimer);
  windRefreshTimer = setInterval(loadWindData, 60000);
  // Redraw chart on resize
  window.addEventListener('resize', () => {
    if (lastWindHistory) renderWindChart(lastWindHistory, lastWindHours);
  });
}

async function loadWindData() {
  try {
    const res = await fetch(`/api/wind/${spotId}`);
    if (!res.ok) throw new Error('No wind data');
    const data = await res.json();
    if (data.current && data.current.station_location) {
      document.querySelector('.wind-station-header').textContent = `🌬️ Live Wind — ${data.current.station_location}`;
    }
    renderWindLive(data.current);
    renderWindChart(data.history, data.history_hours);
    lastWindHistory = data.history;
    lastWindHours = data.history_hours;
  } catch (err) {
    console.warn('Wind data error:', err);
    $('#wind-live-panel').innerHTML = '<div class="wind-live-loading" style="color:var(--text-muted);">Wind data temporarily unavailable</div>';
  }
}

function renderWindLive(c) {
  if (!c) return;
  const panel = $('#wind-live-panel');

  const windCol = c.wind >= 15 ? 'var(--send-it)' : (c.wind >= 12 ? 'var(--maybe)' : 'var(--text-muted)');
  const gustCls = c.gust < 25 ? 'gust-low' : (c.gust < 35 ? 'gust-med' : 'gust-high');

  // Wind compass arrow rotation (0=N, 90=E, etc.)
  const arrowDeg = (c.wind_dir + 180) % 360; // arrow points direction wind is going TO

  const lastUpdated = c.last_received
    ? new Date(c.last_received).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : '';

  panel.innerHTML = `
    <div class="wl-grid">
      <div class="wl-wind-main">
        <div class="wl-compass">
          <svg viewBox="0 0 80 80" class="compass-svg">
            <circle cx="40" cy="40" r="36" fill="none" stroke="var(--border)" stroke-width="2"/>
            <text x="40" y="12" text-anchor="middle" fill="var(--text-muted)" font-size="8" font-weight="600">N</text>
            <text x="72" y="43" text-anchor="middle" fill="var(--text-muted)" font-size="8" font-weight="600">E</text>
            <text x="40" y="76" text-anchor="middle" fill="var(--text-muted)" font-size="8" font-weight="600">S</text>
            <text x="8" y="43" text-anchor="middle" fill="var(--text-muted)" font-size="8" font-weight="600">W</text>
            <g transform="rotate(${arrowDeg}, 40, 40)">
              <line x1="40" y1="58" x2="40" y2="18" stroke="${windCol}" stroke-width="2.5" stroke-linecap="round"/>
              <polygon points="40,16 35,26 45,26" fill="${windCol}"/>
            </g>
          </svg>
        </div>
        <div class="wl-wind-numbers">
          <div class="wl-wind-speed" style="color:${windCol}">${Math.round(c.wind)}</div>
          <div class="wl-wind-unit">${c.wind_units || 'mph'}</div>
          <div class="wl-wind-dir">${c.wind_dir_cardinal || '?'} (${Math.round(c.wind_dir)}°)</div>
        </div>
      </div>
      <div class="wl-details">
        <div class="wl-detail"><span class="wl-detail-label">Gusts</span><span class="wl-detail-value ${gustCls}">${Math.round(c.gust)} ${c.wind_units || 'mph'}</span></div>
        <div class="wl-detail"><span class="wl-detail-label">Temp</span><span class="wl-detail-value">${c.temp != null ? Math.round(c.temp) + '°F' : '—'}</span></div>
        <div class="wl-detail"><span class="wl-detail-label">Feels Like</span><span class="wl-detail-value">${c.feels_like != null ? Math.round(c.feels_like) + '°F' : '—'}</span></div>
        <div class="wl-detail"><span class="wl-detail-label">Humidity</span><span class="wl-detail-value">${c.humidity != null ? Math.round(c.humidity) + '%' : '—'}</span></div>
        <div class="wl-detail"><span class="wl-detail-label">Hi / Lo</span><span class="wl-detail-value">${c.hi_temp != null ? Math.round(c.hi_temp) : '?'}° / ${c.lo_temp != null ? Math.round(c.lo_temp) : '?'}°</span></div>
        <div class="wl-detail"><span class="wl-detail-label">Barometer</span><span class="wl-detail-value">${c.barometer || '—'} ${c.barometer_trend ? '(' + c.barometer_trend + ')' : ''}</span></div>
      </div>
    </div>
    ${lastUpdated ? '<div class="wl-updated">Updated ' + lastUpdated + '</div>' : ''}
  `;
}

function renderWindChart(history, hours) {
  const canvas = $('#wind-chart');
  const label = $('#wind-chart-label');
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;

  // Resize canvas for crisp rendering
  const rect = canvas.parentElement.getBoundingClientRect();
  const W = rect.width || 800;
  const H = 220;
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  ctx.scale(dpr, dpr);

  // Clear
  ctx.clearRect(0, 0, W, H);

  const toMs = ts => typeof ts === 'number' ? ts : new Date(ts).getTime();
  const series = (history || [])
    .map(h => ({ ...h, ts: toMs(h.ts) }))
    .filter(h => Number.isFinite(h.ts))
    .sort((a, b) => a.ts - b.ts);

  if (series.length < 2) {
    label.textContent = `Wind history building up — data appears as readings are collected over ${hours} hours`;
    ctx.fillStyle = 'rgba(255,255,255,0.1)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'var(--text-muted)';
    ctx.font = '13px -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Collecting wind data...', W / 2, H / 2);
    return;
  }

  const spanMs = series[series.length - 1].ts - series[0].ts;
  const spanMin = Math.round(spanMs / 60000);
  const spanLabel = spanMin < 90 ? spanMin + ' min' : Math.round(spanMin / 60 * 10) / 10 + ' hrs';
  label.textContent = `Last ${spanLabel} — Wind Speed (solid) & Gusts (dashed)`;

  const PAD_LEFT = 42;
  const PAD_RIGHT = 15;
  const PAD_TOP = 20;
  const PAD_BOTTOM = 35;
  const chartW = W - PAD_LEFT - PAD_RIGHT;
  const chartH = H - PAD_TOP - PAD_BOTTOM;

  // Data bounds
  const allVals = series.flatMap(h => [h.wind, h.gust]).filter(v => v != null);
  const minVal = 0;
  const maxVal = Math.max(Math.ceil(Math.max(...allVals) / 5) * 5, 20);

  const tMin = series[0].ts;
  const tMax = series[series.length - 1].ts;
  const tRange = tMax - tMin || 1;

  function xPos(ts) { return PAD_LEFT + ((ts - tMin) / tRange) * chartW; }
  function yPos(val) { return PAD_TOP + chartH - ((val - minVal) / (maxVal - minVal)) * chartH; }

  // Background
  ctx.fillStyle = 'rgba(26, 39, 51, 0.8)';
  ctx.fillRect(0, 0, W, H);

  // Grid lines + labels
  ctx.strokeStyle = 'rgba(255,255,255,0.06)';
  ctx.lineWidth = 1;
  ctx.font = '10px -apple-system, sans-serif';
  ctx.fillStyle = '#8899a6';

  const gridSteps = maxVal <= 30 ? 5 : 10;
  for (let v = minVal; v <= maxVal; v += gridSteps) {
    const y = yPos(v);
    ctx.beginPath();
    ctx.moveTo(PAD_LEFT, y);
    ctx.lineTo(W - PAD_RIGHT, y);
    ctx.stroke();
    ctx.textAlign = 'right';
    ctx.fillText(v + '', PAD_LEFT - 6, y + 3);
  }

  // Kite zone bands
  // 12-25 mph ideal zone
  const idealTop = yPos(25);
  const idealBot = yPos(12);
  ctx.fillStyle = 'rgba(34, 197, 94, 0.06)';
  ctx.fillRect(PAD_LEFT, idealTop, chartW, idealBot - idealTop);

  // Wind speed line (filled area)
  ctx.beginPath();
  ctx.moveTo(xPos(series[0].ts), yPos(series[0].wind));
  for (let i = 1; i < series.length; i++) {
    ctx.lineTo(xPos(series[i].ts), yPos(series[i].wind));
  }
  // Fill under
  const windPath = new Path2D();
  windPath.moveTo(xPos(series[0].ts), yPos(series[0].wind));
  for (let i = 1; i < series.length; i++) {
    windPath.lineTo(xPos(series[i].ts), yPos(series[i].wind));
  }
  windPath.lineTo(xPos(series[series.length - 1].ts), yPos(0));
  windPath.lineTo(xPos(series[0].ts), yPos(0));
  windPath.closePath();

  const gradient = ctx.createLinearGradient(0, PAD_TOP, 0, PAD_TOP + chartH);
  gradient.addColorStop(0, 'rgba(56, 189, 248, 0.25)');
  gradient.addColorStop(1, 'rgba(56, 189, 248, 0.02)');
  ctx.fillStyle = gradient;
  ctx.fill(windPath);

  // Wind speed line
  ctx.beginPath();
  ctx.moveTo(xPos(series[0].ts), yPos(series[0].wind));
  for (let i = 1; i < series.length; i++) {
    ctx.lineTo(xPos(series[i].ts), yPos(series[i].wind));
  }
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 2;
  ctx.stroke();

  // Gust line (dashed)
  ctx.beginPath();
  ctx.setLineDash([4, 4]);
  ctx.moveTo(xPos(series[0].ts), yPos(series[0].gust));
  for (let i = 1; i < series.length; i++) {
    ctx.lineTo(xPos(series[i].ts), yPos(series[i].gust));
  }
  ctx.strokeStyle = 'rgba(234, 179, 8, 0.6)';
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.setLineDash([]);

  // Time labels on x-axis
  ctx.fillStyle = '#8899a6';
  ctx.font = '10px -apple-system, sans-serif';
  ctx.textAlign = 'center';

  // Show ~6 time labels
  const labelCount = Math.min(6, series.length);
  const step = Math.max(1, Math.floor(series.length / labelCount));
  for (let i = 0; i < series.length; i += step) {
    const x = xPos(series[i].ts);
    const t = new Date(series[i].ts);
    const label = t.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    ctx.fillText(label, x, H - 8);

    // Tick mark
    ctx.beginPath();
    ctx.moveTo(x, PAD_TOP + chartH);
    ctx.lineTo(x, PAD_TOP + chartH + 4);
    ctx.strokeStyle = 'rgba(255,255,255,0.15)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Legend
  ctx.font = '11px -apple-system, sans-serif';
  const legendX = W - PAD_RIGHT - 130;
  const legendY = PAD_TOP + 8;

  ctx.beginPath();
  ctx.moveTo(legendX, legendY);
  ctx.lineTo(legendX + 20, legendY);
  ctx.strokeStyle = '#38bdf8';
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  ctx.stroke();
  ctx.fillStyle = '#38bdf8';
  ctx.textAlign = 'left';
  ctx.fillText('Wind', legendX + 25, legendY + 4);

  ctx.beginPath();
  ctx.moveTo(legendX, legendY + 16);
  ctx.lineTo(legendX + 20, legendY + 16);
  ctx.strokeStyle = 'rgba(234, 179, 8, 0.6)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([4, 4]);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = '#eab308';
  ctx.fillText('Gusts', legendX + 25, legendY + 20);

  // Ideal zone label
  ctx.fillStyle = 'rgba(34, 197, 94, 0.4)';
  ctx.font = '9px -apple-system, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText('Ideal 12-25 mph', PAD_LEFT + 4, idealTop + 12);

  // Latest value label
  const last = series[series.length - 1];
  const lx = xPos(last.ts);
  const ly = yPos(last.wind);

  // Current wind dot
  ctx.beginPath();
  ctx.arc(lx, ly, 4, 0, Math.PI * 2);
  ctx.fillStyle = '#38bdf8';
  ctx.fill();
  ctx.strokeStyle = '#0f1923';
  ctx.lineWidth = 1.5;
  ctx.stroke();
}
