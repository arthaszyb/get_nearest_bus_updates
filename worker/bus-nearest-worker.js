const STOPS_CACHE_KEY = 'bus_stops_cache';
const STOPS_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // bus stop coordinates rarely change

// LTA crowding codes: SEA = seats available, SDA = standing available, LSD = limited standing
const LOAD_LEVELS = { SEA: 'seats', SDA: 'standing', LSD: 'full' };
const LOAD_DOTS = { seats: '🟢', standing: '🟡', full: '🔴' };
const LOAD_LABELS = { seats: 'Seats available', standing: 'Standing room', full: 'Limited standing' };

// Loads the full bus stop list, using KV cache when available so we don't
// re-fetch ~5000 stops from LTA on every single request.
async function getAllStops(env, headers, forceRefresh) {
  const hasKV = !!env.BUS_STOPS_KV;

  if (hasKV && !forceRefresh) {
    const cached = await env.BUS_STOPS_KV.get(STOPS_CACHE_KEY, 'json');
    if (cached) return cached;
  }

  // LTA BusStops API returns max 500 records per call, paginated via $skip.
  // Fetch all pages in parallel (fast, one round trip).
  const skips = [0, 500, 1000, 1500, 2000, 2500, 3000, 3500, 4000, 4500, 5000, 5500];
  const pages = await Promise.all(
    skips.map((skip) =>
      fetch(`https://datamall2.mytransport.sg/ltaodataservice/BusStops?$skip=${skip}`, { headers })
        .then((r) => r.json())
        .catch(() => ({ value: [] }))
    )
  );
  const allStops = pages.flatMap((p) => p.value || []);

  if (hasKV && allStops.length > 0) {
    await env.BUS_STOPS_KV.put(STOPS_CACHE_KEY, JSON.stringify(allStops), {
      expirationTtl: STOPS_CACHE_TTL_SECONDS,
    });
  }

  return allStops;
}

function dist(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// LTA lists services in string order (154, 180, 49, 98M...); sort them the way
// people read them instead: 49, 98, 98M, 154, 180.
function compareServiceNo(a, b) {
  const [, numA, suffixA] = a.match(/^(\d*)(.*)$/);
  const [, numB, suffixB] = b.match(/^(\d*)(.*)$/);
  return (Number(numA) || 0) - (Number(numB) || 0) || suffixA.localeCompare(suffixB);
}

// Turns one stop + its raw BusArrival response into the shape every output format renders from.
function toStopModel(stop, arrival, now) {
  const services = (arrival?.Services || [])
    .map((svc) => ({
      no: svc.ServiceNo,
      buses: [svc.NextBus, svc.NextBus2, svc.NextBus3]
        .filter((b) => b?.EstimatedArrival)
        .map((b) => ({
          mins: Math.max(0, Math.round((new Date(b.EstimatedArrival) - now) / 60000)),
          load: LOAD_LEVELS[b.Load] || null,
          // Monitored = 0 means LTA is estimating from the timetable, not live GPS
          live: String(b.Monitored) !== '0',
        })),
    }))
    .sort((a, b) => compareServiceNo(a.no, b.no));

  return {
    code: stop.BusStopCode,
    name: stop.Description,
    road: stop.RoadName,
    distance: Math.round(stop.d),
    services,
  };
}

function renderText(stops) {
  const lines = [];
  for (const stop of stops) {
    lines.push(`🚏 ${stop.name} · ${stop.code} · ${stop.distance}m`);
    if (stop.services.length === 0) lines.push('No arrival info');
    for (const svc of stop.services) {
      const times = svc.buses.map((b) => `${LOAD_DOTS[b.load] || ''}${b.mins === 0 ? 'Now' : b.mins}`);
      const unit = svc.buses.at(-1)?.mins > 0 ? ' min' : '';
      lines.push(`${svc.no}   ${times.join(' · ') || '–'}${unit}`);
    }
    lines.push('');
  }
  lines.push('🟢 Seats  🟡 Standing  🔴 Full');
  return lines.join('\n');
}

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function renderBusCell(bus, isNext) {
  if (!bus) return '<span class="t"></span>';
  const cls = ['t', isNext ? 'next' : '', bus.mins === 0 ? 'now' : '', bus.live ? '' : 'sched'].filter(Boolean).join(' ');
  const dot = bus.load
    ? `<i class="dot ${bus.load}" title="${LOAD_LABELS[bus.load]}" aria-label="${LOAD_LABELS[bus.load]}"></i>`
    : '<i class="dot"></i>';
  const time = bus.mins === 0 ? '<b>Now</b>' : `<b>${bus.mins}</b><small>min</small>`;
  return `<span class="${cls}">${dot}${time}</span>`;
}

function renderHtml(stops, now) {
  const updated = new Date(now).toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Singapore',
    hour: '2-digit',
    minute: '2-digit',
  });

  const cards = stops
    .map((stop) => {
      const rows = stop.services.length
        ? stop.services
            .map(
              (svc) =>
                `<div class="row"><span class="svc">${escapeHtml(svc.no)}</span>` +
                [0, 1, 2].map((i) => renderBusCell(svc.buses[i], i === 0)).join('') +
                '</div>'
            )
            .join('')
        : '<div class="row empty">No arrival info</div>';
      const meta = [stop.code, stop.road, `${stop.distance}m away`].filter(Boolean).map(escapeHtml).join(' · ');
      return `<section class="card">
  <div class="stop"><h2>${escapeHtml(stop.name)}</h2><p>${meta}</p></div>
  ${rows}
</section>`;
    })
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta http-equiv="refresh" content="30">
<title>Nearby buses</title>
<style>
  :root {
    --bg: #f2f2f7; --card: #fff; --text: #1c1c1e; --muted: #8e8e93; --line: #e5e5ea;
    --badge-bg: #1c1c1e; --badge-fg: #fff; --accent: #007aff;
    --seats: #34c759; --standing: #ff9f0a; --full: #ff3b30;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #000; --card: #1c1c1e; --text: #f2f2f7; --muted: #8e8e93; --line: #2c2c2e;
      --badge-bg: #f2f2f7; --badge-fg: #000; --accent: #0a84ff;
      --seats: #30d158; --standing: #ffd60a; --full: #ff453a;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 16px 16px calc(16px + env(safe-area-inset-bottom));
    background: var(--bg); color: var(--text);
    font: 16px/1.3 -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    -webkit-text-size-adjust: 100%;
  }
  header { display: flex; justify-content: space-between; align-items: baseline; margin: 4px 4px 12px; }
  h1 { font-size: 28px; margin: 0; }
  header a { color: var(--muted); font-size: 13px; text-decoration: none; }
  .card { background: var(--card); border-radius: 14px; margin-bottom: 14px; overflow: hidden; }
  .stop { padding: 12px 16px 10px; }
  .stop h2 { font-size: 17px; margin: 0; }
  .stop p { margin: 2px 0 0; color: var(--muted); font-size: 13px; }
  .row {
    display: grid; grid-template-columns: 64px repeat(3, 1fr); align-items: center;
    padding: 9px 16px; border-top: 1px solid var(--line); font-variant-numeric: tabular-nums;
  }
  .row.empty { display: block; color: var(--muted); }
  .svc {
    justify-self: start; min-width: 48px; padding: 3px 8px; border-radius: 8px;
    background: var(--badge-bg); color: var(--badge-fg); font-weight: 700; text-align: center;
  }
  .t { display: flex; align-items: center; gap: 5px; color: var(--muted); }
  .t b { font-weight: 500; }
  .t small { font-size: 11px; }
  .t.next { color: var(--text); }
  .t.next b { font-size: 20px; font-weight: 700; }
  .t.now b { color: var(--accent); }
  .t.sched { opacity: 0.5; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--line); }
  .dot.seats { background: var(--seats); }
  .dot.standing { background: var(--standing); }
  .dot.full { background: var(--full); }
  footer { display: flex; flex-wrap: wrap; gap: 6px 14px; color: var(--muted); font-size: 12px; margin: 4px 4px 0; }
  footer span { display: inline-flex; align-items: center; gap: 5px; }
</style>
</head>
<body>
<header><h1>Nearby buses</h1><a href="">Updated ${updated} ↻</a></header>
${cards}
<footer>
  <span><i class="dot seats"></i>Seats</span>
  <span><i class="dot standing"></i>Standing</span>
  <span><i class="dot full"></i>Full</span>
  <span style="opacity:.5">Faded = scheduled, not live</span>
</footer>
</body>
</html>`;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Simple shared-secret gate: only requests with the correct token are served.
    // Set ACCESS_TOKEN as a Secret in Worker Settings > Variables and Secrets.
    if (env.ACCESS_TOKEN && url.searchParams.get('token') !== env.ACCESS_TOKEN) {
      return new Response('Unauthorized', { status: 401 });
    }

    const lat = parseFloat(url.searchParams.get('lat'));
    const lon = parseFloat(url.searchParams.get('lon'));
    if (isNaN(lat) || isNaN(lon)) {
      return new Response('Missing lat/lon', { status: 400 });
    }

    const ACCOUNT_KEY = env.LTA_API_KEY; // set this in Worker Settings > Variables
    const headers = { AccountKey: ACCOUNT_KEY, accept: 'application/json' };

    const allStops = await getAllStops(env, headers, url.searchParams.get('refresh') === '1');

    if (allStops.length === 0) {
      return new Response('Could not load bus stop list — check LTA_API_KEY', { status: 502 });
    }

    // Nearest 4 stops (better coverage of both directions of a road / an intersection)
    const nearest = allStops
      .map((s) => ({ ...s, d: dist(lat, lon, s.Latitude, s.Longitude) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 4);

    const arrivals = await Promise.all(
      nearest.map((s) =>
        fetch(`https://datamall2.mytransport.sg/ltaodataservice/v3/BusArrival?BusStopCode=${s.BusStopCode}`, {
          headers,
        })
          .then((r) => r.json())
          .catch(() => null)
      )
    );

    const now = Date.now();
    const stops = nearest.map((stop, i) => toStopModel(stop, arrivals[i], now));

    switch (url.searchParams.get('format')) {
      case 'html':
        return new Response(renderHtml(stops, now), {
          headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
        });
      case 'json':
        return Response.json({ updatedAt: new Date(now).toISOString(), stops });
      default:
        return new Response(renderText(stops), {
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
    }
  },
};
