import { APP_ICON_180, APP_ICON_512 } from './app-icons.js';
import { MRT_STATIONS } from './mrt-stations.js';

const STOPS_CACHE_KEY = 'bus_stops_cache';
const STOPS_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60; // bus stop coordinates rarely change

// LTA crowding codes: SEA = seats available, SDA = standing available, LSD = limited standing
const LOAD_LEVELS = { SEA: 'seats', SDA: 'standing', LSD: 'full' };
const LOAD_DOTS = { seats: '🟢', standing: '🟡', full: '🔴' };
const LOAD_LABELS = { seats: 'Seats available', standing: 'Standing room', full: 'Limited standing' };

const DAY_MS = 24 * 60 * 60 * 1000;

// What a newly issued customer token gets by default. Every value can be overridden per token
// when issuing it. days: null = never expires; dailyLimit: null = unlimited.
// dailyLimit counts every request — the HTML view's 30s auto-refresh included.
const PLANS = {
  free: { days: 30, dailyLimit: 4 },
  trial: { days: 7, dailyLimit: 100 },
  monthly: { days: 31, dailyLimit: 300 },
  yearly: { days: 366, dailyLimit: 300 },
  lifetime: { days: null, dailyLimit: 300 },
};
const EXPIRY_WARNING_DAYS = 3;
// Built-in free tier: requests without a token get this many a day, counted per device. iOS gives
// Shortcuts no stable device ID, so the "device" is a hash of the details the Shortcut sends
// (name, model, OS version, screen) — a soft limit, which is fine at this cost.
const ANONYMOUS_DAILY_LIMIT = 4;
const MAX_DEVICE_LENGTH = 300;
// Subscription tokens stay valid this long past the paid period, to cover Stripe's renewal lag and retries.
const SUBSCRIPTION_GRACE_DAYS = 2;
const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

// Website: landing page, pricing and free sign-up, served at / when there's no lat/lon or token.
const PRODUCT_NAME = 'BusNearby';
const CURRENCY = 'S$';
// Launch prices show until this moment; afterwards the page switches to the regular prices and links.
const PROMO_ENDS_AT = Date.parse('2026-11-30T23:59:59+08:00');
// Prices here are for display only — customers are charged whatever their Stripe Payment Link is set to.
// `link` names the env var holding the Payment Link; `${link}_PROMO` holds the launch-price one.
const PAID_PLANS = [
  { plan: 'monthly', label: 'Monthly', per: 'month', price: 2.9, promoPrice: 1.9, link: 'PAYMENT_LINK_MONTHLY' },
  { plan: 'yearly', label: 'Yearly', per: 'year', price: 29.9, promoPrice: 18.9, link: 'PAYMENT_LINK_YEARLY' },
];
const FREE_SIGNUPS_PER_NETWORK_PER_DAY = 3;
const LEGAL_UPDATED = '7 Oct 2026';

const TEXT_HEADERS = { 'content-type': 'text/plain; charset=utf-8' };
const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };

const LTA_BASE = 'https://datamall2.mytransport.sg/ltaodataservice';
const LTA_PAGE_SIZE = 500;
// At most this many LTA calls in flight at once; LTA throttles bigger bursts.
const LTA_CONCURRENCY = 4;
const NEAREST_STOPS = 3;

// GETs an LTA endpoint, retrying failed calls (network errors, non-2xx such as throttling, or a
// response `isValid` rejects) with a short backoff. Returns the JSON body, or null after 3 attempts.
async function fetchLta(path, headers, isValid) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
    try {
      const res = await fetch(`${LTA_BASE}/${path}`, { headers });
      const body = res.ok ? await res.json() : null;
      if (body && isValid(body)) return body;
    } catch {
      // network error: retry
    }
  }
  return null;
}

// One page of an LTA dataset, or null if it couldn't be loaded.
async function fetchLtaPage(dataset, skip, headers) {
  const body = await fetchLta(`${dataset}?$skip=${skip}`, headers, (b) => Array.isArray(b.value));
  return body?.value ?? null;
}

// Pages through an LTA dataset from `skip`, LTA_CONCURRENCY pages at a time, until a short page
// (the end), a page that fails, or `maxPages`. Returns the records of the pages loaded in order,
// where to resume, whether the end was reached, and whether a page failed.
async function fetchLtaPages(dataset, headers, { skip = 0, maxPages = Infinity } = {}) {
  const records = [];
  let pages = 0;
  while (pages < maxPages) {
    const count = Math.min(LTA_CONCURRENCY, maxPages - pages);
    const batch = await Promise.all(
      Array.from({ length: count }, (_, i) => fetchLtaPage(dataset, skip + i * LTA_PAGE_SIZE, headers))
    );
    for (const page of batch) {
      if (!page) return { records, nextSkip: skip, done: false, failed: true };
      records.push(...page);
      skip += LTA_PAGE_SIZE;
      pages++;
      if (page.length < LTA_PAGE_SIZE) return { records, nextSkip: skip, done: true, failed: false };
    }
  }
  return { records, nextSkip: skip, done: false, failed: false };
}

// Loads the full bus stop list, using KV cache when available so we don't
// re-fetch ~5000 stops from LTA on every single request.
async function getAllStops(env, headers, forceRefresh) {
  const hasKV = !!env.BUS_STOPS_KV;

  if (hasKV && !forceRefresh) {
    const cached = await env.BUS_STOPS_KV.get(STOPS_CACHE_KEY, 'json');
    if (cached) return cached;
  }

  const { records, done } = await fetchLtaPages('BusStops', headers);

  // A list with a page missing would leave whole areas without stops for a week, so only a
  // complete list is cached; an incomplete one still serves this request.
  if (hasKV && done && records.length > 0) {
    await env.BUS_STOPS_KV.put(STOPS_CACHE_KEY, JSON.stringify(records), {
      expirationTtl: STOPS_CACHE_TTL_SECONDS,
    });
  }

  return records;
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
// Where a service is heading and the next MRT stations it calls at on the way.
function destinationOf(svc, stopCode, routes, stopsByCode) {
  const destCode = [svc.NextBus, svc.NextBus2, svc.NextBus3].find((b) => b?.DestinationCode)?.DestinationCode;
  if (!destCode || !stopsByCode) return { destination: null, nextStations: [] };
  const destStop = stopsByCode.get(destCode);
  return {
    destination: { code: destCode, name: destStop?.Description ?? destCode },
    nextStations: nextStations(svc.ServiceNo, stopCode, destCode, routes?.routes, stopsByCode),
  };
}

function compareServiceNo(a, b) {
  const [, numA, suffixA] = a.match(/^(\d*)(.*)$/);
  const [, numB, suffixB] = b.match(/^(\d*)(.*)$/);
  return (Number(numA) || 0) - (Number(numB) || 0) || suffixA.localeCompare(suffixB);
}

// Turns one stop + its raw BusArrival response into the shape every output format renders from.
// `routes` and `stopsByCode` (code → stop) let it name destinations and the MRT stations ahead.
function toStopModel(stop, arrival, now, { routes, stopsByCode } = {}) {
  const services = (arrival?.Services || [])
    .map((svc) => ({
      no: svc.ServiceNo,
      ...destinationOf(svc, stop.BusStopCode, routes, stopsByCode),
      buses: [svc.NextBus, svc.NextBus2]
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

// ---------------------------------------------------------------------------
// Destinations and the MRT stations a bus calls at next
// ---------------------------------------------------------------------------

// Official line colours, by station-code prefix.
const LINE_COLOURS = {
  NS: '#d42e12', EW: '#009645', CG: '#009645', NE: '#9900aa', CC: '#fa9e0d', CE: '#fa9e0d',
  DT: '#005ec4', TE: '#9d5b25', BP: '#748477', SW: '#748477', SE: '#748477', PW: '#748477', PE: '#748477', STC: '#748477',
};
// For plain text, where colour has to come from an emoji.
const LINE_SQUARES = { NS: '🟥', EW: '🟩', CG: '🟩', NE: '🟪', CC: '🟧', CE: '🟧', DT: '🟦', TE: '🟫' };
const linePrefix = (code) => code.replace(/\d+$/, '');

// A bus stop counts as calling at a station when it's within 150 m of one of the station's exits,
// or within 250 m when the stop is named after a station ("… Stn"). Checked against all 5,210
// stops: catches 86% of "Stn" stops and stops like "Prudential Twr" by Raffles Place.
const STATION_RADIUS_M = 150;
const NAMED_STATION_RADIUS_M = 250;
// Exits bucketed into ~330 m grid cells, so a lookup only checks the exits in the 3×3 cells around a stop.
const GRID_DEG = 0.003;
const cellKey = (lat, lon) => `${Math.floor(lat / GRID_DEG)},${Math.floor(lon / GRID_DEG)}`;
const EXIT_GRID = new Map();
for (const [name, codes, exits] of MRT_STATIONS) {
  for (const [lat, lon] of exits) {
    const key = cellKey(lat, lon);
    if (!EXIT_GRID.has(key)) EXIT_GRID.set(key, []);
    EXIT_GRID.get(key).push({ lat, lon, station: { name, codes } });
  }
}

// The station a bus stop serves, or null.
function stationAt(stop) {
  if (!stop) return null;
  const row = Math.floor(stop.Latitude / GRID_DEG);
  const col = Math.floor(stop.Longitude / GRID_DEG);
  let best = null;
  for (let r = row - 1; r <= row + 1; r++) {
    for (let c = col - 1; c <= col + 1; c++) {
      for (const exit of EXIT_GRID.get(`${r},${c}`) || []) {
        const m = dist(stop.Latitude, stop.Longitude, exit.lat, exit.lon);
        if (!best || m < best.m) best = { m, station: exit.station };
      }
    }
  }
  const radius = /\bStn\b/.test(stop.Description) ? NAMED_STATION_RADIUS_M : STATION_RADIUS_M;
  return best && best.m <= radius ? best.station : null;
}

// The next `count` distinct stations a service calls at after this stop, heading for `destCode`.
// `routes` maps "service|direction" to its stop codes in order (see refreshRoutesStep).
function nextStations(no, stopCode, destCode, routes, stopsByCode, count = 2) {
  let sequence = null;
  for (const direction of ['1', '2']) {
    const codes = routes?.[`${no}|${direction}`]?.split(',');
    if (!codes?.includes(stopCode)) continue;
    sequence = codes;
    if (codes.at(-1) === destCode) break; // the direction actually heading to this destination
  }
  if (!sequence) return [];

  const here = stationAt(stopsByCode.get(stopCode))?.name;
  const found = [];
  for (const code of sequence.slice(sequence.indexOf(stopCode) + 1)) {
    const station = stationAt(stopsByCode.get(code));
    if (station && station.name !== here && !found.some((s) => s.name === station.name)) found.push(station);
    if (found.length === count || code === destCode) break;
  }
  return found;
}

// Which stops each service calls at, in order, from LTA's BusRoutes (~26,000 rows, ~53 pages).
// Too big to load during a request, so it's built in the background a few pages at a time — by
// the cron trigger and by requests that find it missing — and swapped in once complete.
const ROUTES_CACHE_KEY = 'bus_route_stops';
const ROUTES_JOB_KEY = 'bus_route_stops_job';
const ROUTES_LOCK_KEY = 'bus_route_stops_lock';
const ROUTES_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
// Pages per background step. With retries this stays under the Workers free plan's 50 subrequests.
const ROUTES_PAGES_PER_STEP = 12;
// At most one background step a minute (KV's minimum expiry), to go easy on LTA.
const ROUTES_LOCK_SECONDS = 60;

// { updatedAt, routes: { "180|1": "28009,28011,…" } }, or null until it has been built.
async function getRoutes(env) {
  return env.BUS_STOPS_KV ? env.BUS_STOPS_KV.get(ROUTES_CACHE_KEY, 'json') : null;
}

// Advances the background build of the routes table by one step, if it's missing or stale and
// no step ran in the last minute. Idempotent: if two ever overlap they only repeat work.
async function refreshRoutesStep(env, now, current) {
  const kv = env.BUS_STOPS_KV;
  if (!kv || !env.LTA_API_KEY) return;
  if (current === undefined) current = await getRoutes(env);
  if (current && now - current.updatedAt < ROUTES_MAX_AGE_MS) return;
  if (await kv.get(ROUTES_LOCK_KEY)) return;
  await kv.put(ROUTES_LOCK_KEY, String(now), { expirationTtl: ROUTES_LOCK_SECONDS });

  const job = (await kv.get(ROUTES_JOB_KEY, 'json')) || { nextSkip: 0, stops: {} };
  const headers = { AccountKey: env.LTA_API_KEY, accept: 'application/json' };
  const { records, nextSkip, done } = await fetchLtaPages('BusRoutes', headers, {
    skip: job.nextSkip,
    maxPages: ROUTES_PAGES_PER_STEP,
  });
  for (const { ServiceNo: no, Direction: direction, StopSequence: seq, BusStopCode: code } of records) {
    (job.stops[`${no}|${direction}`] ||= []).push([seq, code]);
  }

  if (done) {
    const routes = Object.fromEntries(
      Object.entries(job.stops).map(([key, stops]) => [
        key,
        stops
          .sort((a, b) => a[0] - b[0])
          .map(([, code]) => code)
          .join(','),
      ])
    );
    await kv.put(ROUTES_CACHE_KEY, JSON.stringify({ updatedAt: now, routes }));
    await kv.delete(ROUTES_JOB_KEY);
  } else {
    await kv.put(ROUTES_JOB_KEY, JSON.stringify({ nextSkip, stops: job.stops }));
  }
  // The lock is left to expire, so this runs at most once a minute however busy the Worker is.
}

// ---------------------------------------------------------------------------
// Access tokens
// ---------------------------------------------------------------------------

const sgtDay = (ms) => new Date(ms + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
const formatDate = (ms) =>
  new Date(ms).toLocaleDateString('en-GB', { timeZone: 'Asia/Singapore', day: 'numeric', month: 'short', year: 'numeric' });
const isoOrNull = (ms) => (ms == null ? null : new Date(ms).toISOString());

const toHex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

async function sha256(text) {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))));
}

async function hmacSha256(key, message) {
  const encoder = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey('raw', encoder.encode(key), { name: 'HMAC', hash: 'SHA-256' }, false, [
    'sign',
  ]);
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message)));
}

// Compares hashes rather than the raw strings so the comparison time doesn't leak the secret.
async function secretsMatch(a, b) {
  return (await sha256(a)) === (await sha256(b));
}

// 32 symbols, no 0/o/1/l, so tokens survive being read out or retyped.
const TOKEN_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
const encodeBytes = (bytes) => Array.from(bytes, (b) => TOKEN_ALPHABET[b & 31]).join('');
const randomString = (length) => encodeBytes(crypto.getRandomValues(new Uint8Array(length)));
const newToken = () => `sgb_${randomString(32)}`; // 160 bits of randomness

const bearer = (request) => request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') || '';

// Counts this request against the token and returns its row, in one round trip.
// A token issued with startOnFirstUse gets its expiry fixed here, the first time it's used.
// Rejected requests (expired, revoked, over the limit) are counted too.
function recordUse(db, tokenHash, now) {
  return db
    .prepare(
      `UPDATE tokens SET
         first_used_at = COALESCE(first_used_at, ?2),
         expires_at = CASE WHEN pending_days IS NOT NULL THEN ?2 + pending_days * ${DAY_MS} ELSE expires_at END,
         pending_days = NULL,
         usage_count = CASE WHEN usage_day = ?3 THEN usage_count + 1 ELSE 1 END,
         usage_day = ?3,
         total_count = total_count + 1,
         last_used_at = ?2
       WHERE token_hash = ?1
       RETURNING *`
    )
    .bind(tokenHash, now, sgtDay(now))
    .first();
}

// Returns { owner: true } for the deployer's own ACCESS_TOKEN, { pass } for a customer token,
// or { error } when the request should be turned away.
async function authorize(request, url, env, now) {
  const token = url.searchParams.get('token') || bearer(request);

  if (env.ACCESS_TOKEN && token && (await secretsMatch(token, env.ACCESS_TOKEN))) return { owner: true };
  if (!env.DB) {
    // No customer tokens configured: only the owner token gates access (or nothing, if unset).
    return env.ACCESS_TOKEN ? { error: { status: 401, message: 'Unauthorized' } } : { owner: true };
  }
  if (!token) {
    const device = url.searchParams.get('device')?.trim();
    if (!device) return { error: { status: 401, message: 'Missing access token.' } };
    if (device.length > MAX_DEVICE_LENGTH) return { error: { status: 400, message: 'Invalid device.' } };
    return authorizeAnonymous(env, device, now);
  }

  const pass = await recordUse(env.DB, await sha256(token), now);
  if (!pass) {
    return { error: { status: 401, message: 'Invalid access token. Check the token you pasted.' } };
  }
  if (pass.status !== 'active') {
    return { error: { status: 403, message: 'This access token has been disabled.' } };
  }
  if (pass.expires_at !== null && now >= pass.expires_at) {
    return { error: { status: 402, message: `Your pass expired on ${formatDate(pass.expires_at)}.`, renew: 'Renew' } };
  }
  if (pass.daily_limit !== null && pass.usage_count > pass.daily_limit) {
    return {
      error: {
        status: 429,
        message: `Daily limit of ${pass.daily_limit} requests reached. It resets at midnight (SGT).`,
        renew: pass.plan === 'free' ? 'Upgrade' : undefined,
      },
    };
  }
  return { pass };
}

// Counts a token-less request against its device's daily free allowance. Returns a pass-shaped
// object so the renderers treat it like a free pass.
async function authorizeAnonymous(env, device, now) {
  // Salted so the stored key can't be matched against guessed device names.
  const deviceKey = await sha256(`device:${device}:${env.ADMIN_SECRET ?? ''}`);
  const { usage_count: used } = await env.DB.prepare(
    `INSERT INTO anonymous_usage (device_key, usage_day, usage_count, first_seen_at, last_used_at)
     VALUES (?1, ?2, 1, ?3, ?3)
     ON CONFLICT (device_key) DO UPDATE SET
       usage_count = CASE WHEN usage_day = ?2 THEN usage_count + 1 ELSE 1 END,
       usage_day = ?2,
       last_used_at = ?3
     RETURNING usage_count`
  )
    .bind(deviceKey, sgtDay(now), now)
    .first();
  if (used > ANONYMOUS_DAILY_LIMIT) {
    return {
      error: {
        status: 429,
        message: `You've used today's ${ANONYMOUS_DAILY_LIMIT} free checks. They reset at midnight (SGT).`,
        renew: 'Upgrade',
      },
    };
  }
  return { pass: { plan: 'free', expires_at: null, daily_limit: ANONYMOUS_DAILY_LIMIT, usage_count: used } };
}

function expiryWarning(pass, now) {
  if (pass?.expires_at == null || pass.expires_at - now > EXPIRY_WARNING_DAYS * DAY_MS) return null;
  return `Your pass expires on ${formatDate(pass.expires_at)}.`;
}

// What the admin API shows for a token. The token itself is never stored, so it can't be shown
// again — only at issue time and on rotate.
function describeToken(row, now) {
  let state = row.status;
  if (state === 'active' && row.pending_days !== null) state = 'unused';
  else if (state === 'active' && row.expires_at !== null && now >= row.expires_at) state = 'expired';

  return {
    id: row.id,
    plan: row.plan,
    state, // active | unused (expiry starts on first use) | expired | revoked
    createdAt: isoOrNull(row.created_at),
    firstUsedAt: isoOrNull(row.first_used_at),
    expiresAt: isoOrNull(row.expires_at),
    pendingDays: row.pending_days,
    dailyLimit: row.daily_limit,
    usedToday: row.usage_day === sgtDay(now) ? row.usage_count : 0,
    totalRequests: row.total_count,
    lastUsedAt: isoOrNull(row.last_used_at),
    customer: row.customer,
    note: row.note,
    stripeCheckoutSession: row.stripe_checkout_session,
    stripeSubscription: row.stripe_subscription,
  };
}

const isPositiveInt = (v) => Number.isInteger(v) && v > 0;
const isPlan = (name) => typeof name === 'string' && Object.hasOwn(PLANS, name);
const json = (data, status = 200) => Response.json(data, { status });

// A plan's defaults with any per-token overrides applied, or { error }.
function planSettings(plan, { days, dailyLimit }) {
  if (!isPlan(plan)) return { error: `plan must be one of: ${Object.keys(PLANS).join(', ')}` };
  const settings = {
    plan,
    days: days !== undefined ? days : PLANS[plan].days,
    dailyLimit: dailyLimit !== undefined ? dailyLimit : PLANS[plan].dailyLimit,
  };
  if (settings.days !== null && !isPositiveInt(settings.days)) return { error: 'days must be a positive integer or null' };
  if (settings.dailyLimit !== null && !isPositiveInt(settings.dailyLimit)) {
    return { error: 'dailyLimit must be a positive integer or null' };
  }
  return settings;
}

// Stores a new token and returns its row — or null when this Stripe Checkout session already has one,
// so a redelivered webhook can't issue twice.
function insertToken(
  db,
  now,
  { tokenHash, plan, days, dailyLimit, startOnFirstUse = false, customer = null, note = null,
    stripeCheckoutSession = null, stripeSubscription = null, signupKey = null }
) {
  const pending = days !== null && startOnFirstUse;
  return db
    .prepare(
      `INSERT INTO tokens (id, token_hash, plan, status, created_at, expires_at, pending_days, daily_limit,
                           customer, note, stripe_checkout_session, stripe_subscription, signup_key)
       VALUES (?1, ?2, ?3, 'active', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
       ON CONFLICT (stripe_checkout_session) DO NOTHING
       RETURNING *`
    )
    .bind(
      `tk_${randomString(8)}`,
      tokenHash,
      plan,
      now,
      days !== null && !pending ? now + days * DAY_MS : null,
      pending ? days : null,
      dailyLimit,
      customer,
      note,
      stripeCheckoutSession,
      stripeSubscription,
      signupKey
    )
    .first();
}

// /admin/tokens API for issuing and managing customer tokens.
// Authenticated with `Authorization: Bearer <ADMIN_SECRET>`; disabled entirely when ADMIN_SECRET is unset.
async function handleAdmin(request, url, env, now) {
  if (!env.ADMIN_SECRET) return new Response('Not found', { status: 404 });
  if (!(await secretsMatch(bearer(request), env.ADMIN_SECRET))) return json({ error: 'Unauthorized' }, 401);
  if (!env.DB) return json({ error: 'Bind a D1 database as DB to manage tokens (see README)' }, 501);

  const [, , resource, id, action] = url.pathname.split('/'); // /admin/tokens/:id/:action
  if (resource !== 'tokens') return json({ error: 'Not found' }, 404);
  const method = request.method;
  const body = ['POST', 'PATCH'].includes(method) ? await request.json().catch(() => ({})) : {};
  const db = env.DB;

  // Issue: { plan, days?, dailyLimit?, startOnFirstUse?, customer?, note? }
  if (!id && method === 'POST') {
    const settings = planSettings(body.plan, body);
    if (settings.error) return json({ error: settings.error }, 400);
    const token = newToken();
    const row = await insertToken(db, now, {
      ...settings,
      tokenHash: await sha256(token),
      startOnFirstUse: body.startOnFirstUse === true,
      customer: body.customer ?? null,
      note: body.note ?? null,
    });
    return json({ token, ...describeToken(row, now) }, 201);
  }

  // List: ?customer=…&limit=…
  if (!id && method === 'GET') {
    const limit = Math.min(Number(url.searchParams.get('limit')) || 100, 500);
    const customer = url.searchParams.get('customer');
    const { results } = customer
      ? await db.prepare('SELECT * FROM tokens WHERE customer = ?1 ORDER BY created_at DESC LIMIT ?2').bind(customer, limit).all()
      : await db.prepare('SELECT * FROM tokens ORDER BY created_at DESC LIMIT ?1').bind(limit).all();
    return json({ tokens: results.map((row) => describeToken(row, now)) });
  }

  let row = null;

  if (id && !action && method === 'GET') {
    row = await db.prepare('SELECT * FROM tokens WHERE id = ?1').bind(id).first();
  }

  // Change settings: { status?: 'active' | 'revoked', expiresAt?: ISO date | null, dailyLimit?, plan?, customer?, note? }
  if (id && !action && method === 'PATCH') {
    const sets = [];
    const values = [];
    const set = (column, value) => {
      values.push(value);
      sets.push(`${column} = ?${values.length + 1}`);
    };
    if (body.status !== undefined) {
      if (!['active', 'revoked'].includes(body.status)) return json({ error: "status must be 'active' or 'revoked'" }, 400);
      set('status', body.status);
    }
    if (body.expiresAt !== undefined) {
      const expiresAt = body.expiresAt === null ? null : Date.parse(body.expiresAt);
      if (Number.isNaN(expiresAt)) return json({ error: 'expiresAt must be an ISO date or null' }, 400);
      set('expires_at', expiresAt);
      set('pending_days', null);
    }
    if (body.dailyLimit !== undefined) {
      if (body.dailyLimit !== null && !isPositiveInt(body.dailyLimit)) {
        return json({ error: 'dailyLimit must be a positive integer or null' }, 400);
      }
      set('daily_limit', body.dailyLimit);
    }
    if (body.plan !== undefined) {
      if (!isPlan(body.plan)) return json({ error: `plan must be one of: ${Object.keys(PLANS).join(', ')}` }, 400);
      set('plan', body.plan);
    }
    if (body.customer !== undefined) set('customer', body.customer);
    if (body.note !== undefined) set('note', body.note);
    if (sets.length === 0) return json({ error: 'Nothing to update' }, 400);

    row = await db
      .prepare(`UPDATE tokens SET ${sets.join(', ')} WHERE id = ?1 RETURNING *`)
      .bind(id, ...values)
      .first();
  }

  // Renew: { days }. Adds to whichever is later — now or the current expiry — so renewing early
  // doesn't lose days and renewing late doesn't backdate. Customers keep the same token.
  if (id && action === 'extend' && method === 'POST') {
    if (!isPositiveInt(body.days)) return json({ error: 'days must be a positive integer' }, 400);
    row = await db
      .prepare(
        `UPDATE tokens SET
           pending_days = CASE WHEN pending_days IS NOT NULL THEN pending_days + ?2 END,
           expires_at = CASE WHEN pending_days IS NULL AND expires_at IS NOT NULL
                             THEN MAX(expires_at, ?3) + ?2 * ${DAY_MS} ELSE expires_at END
         WHERE id = ?1 RETURNING *`
      )
      .bind(id, body.days, now)
      .first();
  }

  // Replace a leaked or shared token: same id, plan, expiry and usage; the old token stops working.
  if (id && action === 'rotate' && method === 'POST') {
    const token = newToken();
    row = await db
      .prepare('UPDATE tokens SET token_hash = ?2 WHERE id = ?1 RETURNING *')
      .bind(id, await sha256(token))
      .first();
    if (row) return json({ token, ...describeToken(row, now) });
  }

  return row ? json(describeToken(row, now)) : json({ error: 'Not found' }, 404);
}

// ---------------------------------------------------------------------------
// Stripe: issue tokens on payment, follow subscription renewals and cancellations
// ---------------------------------------------------------------------------

// Stripe-Signature is "t=<unix seconds>,v1=<hex HMAC-SHA256 of `${t}.${body}`>", with one v1 per
// active signing secret while a secret is being rolled.
async function verifyStripeSignature(header, body, secret, now) {
  const pairs = (header || '').split(',').map((part) => part.split('='));
  const timestamp = Number(pairs.find(([key]) => key === 't')?.[1]);
  const signatures = pairs.filter(([key]) => key === 'v1').map(([, value]) => value);
  if (!timestamp || Math.abs(now / 1000 - timestamp) > STRIPE_SIGNATURE_TOLERANCE_SECONDS) return false;

  const expected = toHex(await hmacSha256(secret, `${timestamp}.${body}`));
  for (const signature of signatures) {
    if (await secretsMatch(signature, expected)) return true;
  }
  return false;
}

// A Checkout purchase's token is derived from its session id, so the webhook (which stores the hash)
// and the welcome page (which shows the token) arrive at the same token independently.
async function checkoutToken(env, sessionId) {
  return `sgb_${encodeBytes(await hmacSha256(env.STRIPE_WEBHOOK_SECRET, `checkout-token:${sessionId}`))}`;
}

const stripeId = (value) => (typeof value === 'string' ? value : value?.id) ?? null;

async function issueForCheckout(env, session, livemode, now) {
  // The plan comes from metadata on the Payment Link (Stripe copies it onto each Checkout session),
  // so the customer can't pick a different plan than the one they paid for.
  const metadata = session.metadata || {};
  const settings = planSettings(metadata.plan, {
    days: metadata.days !== undefined ? Number(metadata.days) : undefined,
    dailyLimit: metadata.daily_limit !== undefined ? Number(metadata.daily_limit) : undefined,
  });
  if (settings.error) {
    // Paid, but there's no telling what for. Fail loudly so it shows in Stripe's webhook log,
    // then issue this customer's token through the admin API.
    return new Response(`Checkout session ${session.id}: invalid metadata — ${settings.error}`, { status: 400 });
  }

  await insertToken(env.DB, now, {
    ...settings,
    tokenHash: await sha256(await checkoutToken(env, session.id)),
    customer: session.customer_details?.email ?? session.customer_email ?? stripeId(session.customer),
    note: livemode ? null : 'Stripe test mode',
    stripeCheckoutSession: session.id,
    stripeSubscription: stripeId(session.subscription),
  });
  return new Response('ok');
}

// Every handler is idempotent and order-independent: Stripe retries deliveries and doesn't
// guarantee event order.
async function handleStripeWebhook(request, env, now) {
  if (!env.STRIPE_WEBHOOK_SECRET) return new Response('Not found', { status: 404 });
  const body = await request.text();
  if (!(await verifyStripeSignature(request.headers.get('stripe-signature'), body, env.STRIPE_WEBHOOK_SECRET, now))) {
    return new Response('Invalid signature', { status: 400 });
  }
  if (!env.DB) return new Response('Bind a D1 database as DB (see README)', { status: 501 });

  const event = JSON.parse(body);
  const object = event.data.object;

  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      // Delayed payment methods complete as 'unpaid'; their token is issued on async_payment_succeeded.
      if (object.payment_status === 'unpaid') break;
      return issueForCheckout(env, object, event.livemode, now);

    case 'invoice.paid': {
      // A subscription period was paid for: keep its token valid until that period ends (plus grace).
      // API versions from 2025-03-31 moved the subscription id under `parent`.
      const subscription = stripeId(object.parent?.subscription_details?.subscription ?? object.subscription);
      const periodEnd = Math.max(0, ...(object.lines?.data || []).map((line) => line.period?.end || 0));
      if (subscription && periodEnd) {
        await env.DB.prepare('UPDATE tokens SET expires_at = MAX(COALESCE(expires_at, 0), ?2) WHERE stripe_subscription = ?1')
          .bind(subscription, periodEnd * 1000 + SUBSCRIPTION_GRACE_DAYS * DAY_MS)
          .run();
      }
      break;
    }

    case 'customer.subscription.deleted': {
      // Fires when the subscription actually ends — at period end, or at once if cancelled immediately.
      const endedAt = (object.ended_at || object.canceled_at) * 1000 || now;
      await env.DB.prepare('UPDATE tokens SET expires_at = MIN(COALESCE(expires_at, ?2), ?2) WHERE stripe_subscription = ?1')
        .bind(object.id, endedAt)
        .run();
      break;
    }
  }
  return new Response('ok');
}

// Where a Payment Link sends the customer after paying: /welcome?session_id={CHECKOUT_SESSION_ID}
async function handleWelcome(url, env, now) {
  const sessionId = url.searchParams.get('session_id') || '';
  if (!env.STRIPE_WEBHOOK_SECRET || !env.DB || !/^cs_(test|live)_\w+$/.test(sessionId)) {
    return new Response('Not found', { status: 404 });
  }
  const page = (content, refresh) =>
    new Response(htmlPage(`<header><h1>Your pass</h1></header>\n${content}`, { refresh }), { headers: HTML_HEADERS });

  const row = await env.DB.prepare('SELECT * FROM tokens WHERE stripe_checkout_session = ?1').bind(sessionId).first();
  if (!row) {
    // The customer usually lands here a moment before Stripe's webhook does.
    return page(
      `<div class="card pad"><p><b>Payment received — setting up your pass…</b></p>
<p class="muted">This page refreshes by itself. If it's still here after a minute, contact us with the email you paid with.</p></div>`,
      3
    );
  }

  const token = await checkoutToken(env, sessionId);
  if ((await sha256(token)) !== row.token_hash) {
    return page(
      // Rotated by the admin, or STRIPE_WEBHOOK_SECRET was rolled since the purchase.
      `<div class="card notice">This page can no longer show your token. If you've lost it, contact us (reference ${escapeHtml(row.id)}).</div>`
    );
  }

  return passPage(token, row, env, { revisitable: true });
}

// ---------------------------------------------------------------------------
// Output formats
// ---------------------------------------------------------------------------

function renderText(stops, warning, renewUrl) {
  const lines = [];
  if (warning) lines.push(`⚠️ ${warning}${renewUrl ? ` Renew: ${renewUrl}` : ''}`, '');
  for (const stop of stops) {
    lines.push(`🚏 ${stop.name} · ${stop.code} · ${stop.distance}m`);
    if (stop.services.length === 0) lines.push('No arrival info');
    for (const svc of stop.services) {
      const times = svc.buses.map((b) => `${LOAD_DOTS[b.load] || ''}${b.mins === 0 ? 'Now' : b.mins}`);
      const unit = svc.buses.at(-1)?.mins > 0 ? ' min' : '';
      const via = svc.nextStations?.length
        ? ` (${svc.nextStations.map((st) => `${LINE_SQUARES[linePrefix(st.codes[0])] || '⬜'}${st.name}`).join(', ')})`
        : '';
      const dest = svc.destination ? ` → ${svc.destination.name}${via}` : '';
      lines.push(`${svc.no}   ${times.join(' · ') || 'N/A'}${unit}${dest}`);
    }
    lines.push('');
  }
  lines.push('🟢 Seats  🟡 Standing  🔴 Full');
  return lines.join('\n');
}

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const renewLink = (renewUrl, label = 'Renew') => (renewUrl ? ` <a href="${escapeHtml(renewUrl)}">${label}</a>` : '');

function renderBusCell(bus, isNext) {
  if (!bus) return '<span class="t"></span>';
  const cls = ['t', isNext ? 'next' : '', bus.mins === 0 ? 'now' : '', bus.live ? '' : 'sched'].filter(Boolean).join(' ');
  const dot = bus.load
    ? `<i class="dot ${bus.load}" title="${LOAD_LABELS[bus.load]}" aria-label="${LOAD_LABELS[bus.load]}"></i>`
    : '<i class="dot"></i>';
  const time = bus.mins === 0 ? '<b>Now</b>' : `<b>${bus.mins}</b><small>min</small>`;
  return `<span class="${cls}">${dot}${time}</span>`;
}

function htmlPage(content, { refresh, title = 'Nearby buses', bodyClass, css = '', head = '' } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">\n` : ''}${head ? `${head}\n` : ''}<title>${escapeHtml(title)}</title>
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
  a { color: var(--accent); }
  header { display: flex; justify-content: space-between; align-items: baseline; margin: 4px 4px 12px; }
  h1 { font-size: 28px; margin: 0; }
  header a { color: var(--muted); font-size: 13px; text-decoration: none; }
  .card { background: var(--card); border-radius: 14px; margin-bottom: 14px; overflow: hidden; }
  .notice { padding: 12px 16px; border-left: 4px solid var(--standing); font-size: 15px; }
  .stop { padding: 12px 16px 10px; }
  .stop h2 { font-size: 17px; margin: 0; }
  .stop p { margin: 2px 0 0; color: var(--muted); font-size: 13px; }
  .row {
    display: grid; grid-template-columns: 54px 64px 62px minmax(0, 1fr); align-items: center; column-gap: 8px;
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
  .dest { display: flex; flex-direction: column; gap: 3px; min-width: 0; font-size: 13px; line-height: 1.25; }
  .dest b { font-weight: 600; overflow-wrap: anywhere; }
  .dest.solo { font-size: 16px; font-weight: 600; }
  .mrt { display: flex; align-items: center; gap: 4px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
  .ln { font-style: normal; font-weight: 700; font-size: 10px; color: #fff; border-radius: 4px; padding: 1px 4px; flex: none; }
  .dot { width: 8px; height: 8px; border-radius: 50%; flex: none; background: var(--line); }
  .dot.seats { background: var(--seats); }
  .dot.standing { background: var(--standing); }
  .dot.full { background: var(--full); }
  .pad { padding: 14px 16px; }
  .pad p { margin: 0 0 8px; }
  .pad h2 { font-size: 17px; margin: 0 0 8px; }
  .pad ol { margin: 0; padding-left: 20px; line-height: 1.5; }
  .muted { color: var(--muted); }
  .small { font-size: 12px; margin: 4px 4px 0; line-height: 1.5; }
  .token {
    font: 15px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; word-break: break-all; user-select: all;
    background: var(--bg); border-radius: 10px; padding: 12px; margin-bottom: 10px;
  }
  button, .btn {
    display: block; font: inherit; font-weight: 600; width: 100%; padding: 12px; border: 0; border-radius: 10px;
    background: var(--accent); color: #fff; text-align: center; text-decoration: none; cursor: pointer;
  }
  .btn.secondary { background: var(--card); color: var(--accent); box-shadow: inset 0 0 0 1.5px var(--accent); }
  footer { display: flex; flex-wrap: wrap; gap: 6px 14px; color: var(--muted); font-size: 12px; margin: 4px 4px 0; }
  footer span { display: inline-flex; align-items: center; gap: 5px; }
${css}</style>
</head>
<body${bodyClass ? ` class="${bodyClass}"` : ''}>
${content}
</body>
</html>`;
}

function renderDestination(svc) {
  if (!svc.destination) return '<span class="dest"></span>';
  const name = escapeHtml(svc.destination.name);
  if (!svc.nextStations?.length) return `<span class="dest solo">${name}</span>`;
  const stations = svc.nextStations
    .map(
      (st) =>
        `<span class="mrt">${st.codes
          .map((code) => `<i class="ln" style="background:${LINE_COLOURS[linePrefix(code)] || '#748477'}">${escapeHtml(code)}</i>`)
          .join('')}${escapeHtml(st.name)}</span>`
    )
    .join('');
  return `<span class="dest"><b>${name}</b>${stations}</span>`;
}

function renderStopCard(stop) {
  const rows = stop.services.length
    ? stop.services
        .map(
          (svc) =>
            `<div class="row"><span class="svc">${escapeHtml(svc.no)}</span>` +
            (svc.buses.length
              ? [0, 1].map((i) => renderBusCell(svc.buses[i], i === 0)).join('')
              : '<span class="t next">N/A</span><span class="t"></span>') +
            renderDestination(svc) +
            '</div>'
        )
        .join('')
    : '<div class="row empty">No arrival info</div>';
  const meta = [stop.code, stop.road, `${stop.distance}m away`].filter(Boolean).map(escapeHtml).join(' · ');
  return `<section class="card">
  <div class="stop"><h2>${escapeHtml(stop.name)}</h2><p>${meta}</p></div>
  ${rows}
</section>`;
}

function renderHtml(stops, now, { pass, warning, renewUrl }) {
  const updated = new Date(now).toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Singapore',
    hour: '2-digit',
    minute: '2-digit',
  });
  const cards = stops.map(renderStopCard).join('\n');
  // Each refresh is a request, so don't auto-refresh a pass with only a few a day (the free one).
  const autoRefresh = !pass || pass.daily_limit === null || pass.daily_limit >= 100;

  const notice = warning ? `<div class="card notice">⚠️ ${escapeHtml(warning)}${renewLink(renewUrl)}</div>\n` : '';
  const validity = pass?.expires_at ? `<span>Pass valid until ${formatDate(pass.expires_at)}</span>` : '';

  return htmlPage(
    `<header><h1>Nearby buses</h1><a href="">Updated ${updated} ↻</a></header>
${notice}${cards}
<footer>
  <span><i class="dot seats"></i>Seats</span>
  <span><i class="dot standing"></i>Standing</span>
  <span><i class="dot full"></i>Full</span>
  <span style="opacity:.5">Faded = scheduled, not live</span>
  ${validity}
</footer>`,
    { refresh: autoRefresh ? 30 : undefined }
  );
}

function renderError({ status, message, renew }, format, renewUrl) {
  const url = renew ? renewUrl : undefined;
  switch (format) {
    case 'html':
      return new Response(
        htmlPage(`<header><h1>Nearby buses</h1></header>
<div class="card notice">${escapeHtml(message)}${renewLink(url, renew)}</div>`),
        { status, headers: HTML_HEADERS }
      );
    case 'json':
      return Response.json({ error: message, renewUrl: url }, { status });
    default:
      return new Response(url ? `${message}\n${renew}: ${url}` : message, { status, headers: TEXT_HEADERS });
  }
}

// ---------------------------------------------------------------------------
// Website: landing page with pricing, free passes, token page, legal pages
// ---------------------------------------------------------------------------

const money = (amount) => `${CURRENCY}${amount.toFixed(2)}`;
const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// Website look: Apple-style — solid deep-blue and light-grey sections, frosted-glass nav and cards,
// big tight headlines, pill buttons. Only website pages get this; the arrivals page keeps its app look.
const SITE_CSS = `
  body.site-page { padding: 0; background: var(--s-light); color: var(--s-ink); font-size: 17px; line-height: 1.47; }
  .site-page {
    --s-navy: #0b1d3f; --s-navy-2: #10295a; --s-light: #f5f5f7; --s-white: #fff; --s-ink: #1d1d1f; --s-sub: #6e6e73;
    --s-blue: #0071e3; --s-blue-on-dark: #2997ff;
  }
  @media (prefers-color-scheme: dark) {
    .site-page { --s-light: #000; --s-white: #161617; --s-ink: #f5f5f7; --s-sub: #a1a1a6; }
  }
  .site-page a { color: var(--s-blue); }
  .wrap { max-width: 1040px; margin: 0 auto; padding: 0 22px; }
  .glass {
    background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.16);
    -webkit-backdrop-filter: saturate(180%) blur(20px); backdrop-filter: saturate(180%) blur(20px);
  }
  .nav {
    position: sticky; top: 0; z-index: 10; background: rgba(11,29,63,.72); border-bottom: 1px solid rgba(255,255,255,.08);
    -webkit-backdrop-filter: saturate(180%) blur(20px); backdrop-filter: saturate(180%) blur(20px);
  }
  .nav .wrap { display: flex; align-items: center; gap: 22px; height: 52px; }
  .nav .logo { color: #fff; font-weight: 700; font-size: 19px; letter-spacing: -.01em; text-decoration: none; margin-right: auto; }
  .nav .logo span { color: var(--s-blue-on-dark); }
  .nav a.link { color: rgba(255,255,255,.8); font-size: 13px; text-decoration: none; }
  .nav a.link:hover { color: #fff; }
  @media (max-width: 520px) { .nav a.link.optional { display: none; } }
  .pill {
    display: inline-block; white-space: nowrap; border-radius: 980px; padding: 11px 22px; font-size: 17px; font-weight: 500; line-height: 1.2;
    background: var(--s-blue); color: #fff !important; text-decoration: none; border: 0; cursor: pointer; font-family: inherit;
  }
  .pill:hover { filter: brightness(1.08); }
  .pill.small { padding: 6px 14px; font-size: 13px; }
  .pill.ghost { background: transparent; color: var(--s-blue-on-dark) !important; box-shadow: inset 0 0 0 1.5px var(--s-blue-on-dark); }
  .pill[disabled] { opacity: .45; cursor: default; }
  .dark { background: var(--s-navy); color: #f5f5f7; }
  .dark a { color: var(--s-blue-on-dark); }
  .band { padding: 96px 0; }
  .eyebrow { font-size: 19px; font-weight: 600; color: var(--s-blue-on-dark); margin: 0 0 10px; }
  .headline { font-size: clamp(44px, 8vw, 88px); line-height: 1.04; letter-spacing: -.035em; font-weight: 700; margin: 0 0 22px; }
  .title { font-size: clamp(36px, 5.5vw, 56px); line-height: 1.07; letter-spacing: -.028em; font-weight: 700; margin: 0 0 14px; }
  .lede { font-size: clamp(19px, 2.4vw, 24px); line-height: 1.38; color: rgba(245,245,247,.72); max-width: 640px; margin: 0 0 32px; }
  .light .lede { color: var(--s-sub); }
  .center { text-align: center; }
  .center .lede, .lede.center { margin-left: auto; margin-right: auto; }
  .ctas { display: flex; gap: 14px; flex-wrap: wrap; justify-content: center; }
  .hero { padding: 88px 0 96px; }
  .phone {
    width: min(360px, 88vw); margin: 64px auto 0; border-radius: 48px; padding: 14px;
    background: rgba(255,255,255,.1); border: 1px solid rgba(255,255,255,.22);
    -webkit-backdrop-filter: blur(24px); backdrop-filter: blur(24px); box-shadow: 0 40px 100px rgba(0,0,0,.45);
  }
  .screen { background: #f2f2f7; color: #1c1c1e; border-radius: 36px; padding: 18px 12px 12px; text-align: left; font-size: 16px; line-height: 1.3; }
  .screen .card { background: #fff; }
  .screen .stop h2 { color: #1c1c1e; }
  .screen .t.next { color: #1c1c1e; }
  .screen-title { font-size: 26px; font-weight: 700; margin: 4px 6px 12px; }
  .grid { display: grid; gap: 20px; grid-template-columns: repeat(auto-fit, minmax(230px, 1fr)); }
  .tile { background: var(--s-white); border-radius: 22px; padding: 30px 26px; box-shadow: 0 2px 20px rgba(0,0,0,.04); }
  .tile .icon { font-size: 34px; line-height: 1; margin-bottom: 18px; }
  .tile h3 { font-size: 21px; letter-spacing: -.01em; margin: 0 0 8px; }
  .tile p { margin: 0; color: var(--s-sub); }
  .steps3 { display: grid; gap: 20px; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); counter-reset: step; }
  .steps3 > div { background: var(--s-white); border-radius: 22px; padding: 30px 26px; }
  .steps3 > div::before {
    counter-increment: step; content: counter(step); display: block; font-size: 48px; font-weight: 700;
    letter-spacing: -.03em; color: var(--s-blue); margin-bottom: 8px;
  }
  .steps3 h3 { font-size: 21px; margin: 0 0 6px; }
  .steps3 p { margin: 0; color: var(--s-sub); }
  .offer { display: inline-block; border-radius: 980px; padding: 8px 18px; font-size: 15px; margin: 0 0 36px; color: #f5f5f7; }
  .plans { display: grid; gap: 20px; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); text-align: left; }
  .plan { border-radius: 26px; padding: 30px 26px; display: flex; flex-direction: column; gap: 4px; color: #f5f5f7; }
  .plan.best { background: rgba(41,151,255,.14); border-color: rgba(41,151,255,.6); }
  .plan h3 { font-size: 21px; margin: 0 0 8px; display: flex; align-items: center; gap: 8px; }
  .plan .tag { background: var(--s-blue-on-dark); color: #00122e; font-size: 12px; font-weight: 700; padding: 3px 9px; border-radius: 980px; }
  .plan .was { color: rgba(245,245,247,.5); text-decoration: line-through; font-size: 17px; min-height: 24px; }
  .plan .price { font-size: 48px; font-weight: 700; letter-spacing: -.03em; line-height: 1.05; }
  .plan .price small { font-size: 17px; font-weight: 500; color: rgba(245,245,247,.6); letter-spacing: 0; }
  .plan ul { list-style: none; padding: 0; margin: 18px 0 24px; flex: 1; color: rgba(245,245,247,.78); }
  .plan li { padding: 7px 0; border-top: 1px solid rgba(255,255,255,.1); }
  .plan li::before { content: "✓"; color: var(--s-blue-on-dark); margin-right: 10px; font-weight: 700; }
  .plan .pill { text-align: center; }
  .plan .note { font-size: 13px; color: rgba(245,245,247,.55); margin: 12px 0 0; }
  .fine { font-size: 13px; color: rgba(245,245,247,.55); margin: 28px 0 0; }
  .doc { max-width: 720px; margin: 0 auto; padding: 56px 22px 72px; }
  .doc .title { margin-bottom: 18px; }
  .doc h2 { font-size: 24px; letter-spacing: -.015em; margin: 36px 0 10px; }
  .doc .panel { background: var(--s-white); border-radius: 22px; padding: 26px; margin: 24px 0; }
  .doc ul { padding-left: 22px; }
  .doc li { margin: 6px 0; }
  .site-page .site-footer { background: var(--s-light); border-top: 1px solid rgba(128,128,128,.2); color: var(--s-sub); font-size: 12px; line-height: 1.6; padding: 22px 0 40px; margin: 0; display: block; }
  .site-page .site-footer nav { display: flex; flex-wrap: wrap; gap: 4px 20px; margin-bottom: 10px; }
  .site-page .site-footer a { color: var(--s-ink); text-decoration: none; }
`;

const navBar = (env) => `<nav class="nav"><div class="wrap">
  <a class="logo" href="/">${PRODUCT_NAME.replace(/^([A-Z][a-z]+)(.+)$/, '$1<span>$2</span>')}</a>
  <a class="link optional" href="/#features">Features</a>
  <a class="link" href="/#pricing">Pricing</a>
  <a class="link optional" href="/install">Install</a>
  <a class="pill small" href="${escapeHtml(env.SHORTCUT_URL || '/install')}">Try it free</a>
</div></nav>`;

// A website page: glass nav, the content, footer. `bare` content brings its own full-width sections;
// otherwise it's set as a document on the light background.
const sitePage = (env, now, content, title, { status = 200, bare = false } = {}) =>
  new Response(
    htmlPage(`${navBar(env)}\n${bare ? content : `<main class="doc">\n${content}\n</main>`}\n${siteFooter(env, now)}`, {
      title,
      bodyClass: 'site-page',
      css: SITE_CSS,
    }),
    { status, headers: HTML_HEADERS }
  );

function siteFooter(env, now) {
  const links = [
    env.MANAGE_URL && `<a href="${escapeHtml(env.MANAGE_URL)}">Manage subscription</a>`,
    '<a href="/install">Install guide</a>',
    '<a href="/privacy">Privacy</a>',
    '<a href="/terms">Terms</a>',
    env.SUPPORT_EMAIL && `<a href="mailto:${escapeHtml(env.SUPPORT_EMAIL)}">Contact</a>`,
  ].filter(Boolean);
  // The Singapore Open Data Licence asks for this notice wherever LTA data is used.
  return `<footer class="site-footer"><div class="wrap">
  <nav>${links.join('')}</nav>
  Contains information from LTA DataMall accessed on ${formatDate(now)} from the Land Transport Authority, and MRT/LRT
  station data from LTA via data.gov.sg, which is made
  available under the terms of the <a href="https://data.gov.sg/open-data-licence">Singapore Open Data Licence version 1.0</a>.
  Not affiliated with LTA.
</div></footer>`;
}

// The page that hands a customer their token, after paying or signing up for a free pass.
function passPage(token, row, env, { revisitable }) {
  const validity = row.stripe_subscription
    ? `Renews automatically${row.expires_at ? ` · paid until ${formatDate(row.expires_at)}` : ''}`
    : row.expires_at
      ? `Valid until ${formatDate(row.expires_at)}`
      : 'Never expires';
  const limit = row.daily_limit === null ? '' : ` · ${row.daily_limit} checks a day`;
  // With the Shortcut's link, one tap copies the token and opens the Shortcut, ready to paste.
  const copy = "navigator.clipboard.writeText(document.getElementById('token').textContent)";
  const button = env.SHORTCUT_URL
    ? `<button type="button" onclick="${copy}.finally(() => { location.href = ${escapeHtml(JSON.stringify(env.SHORTCUT_URL))}; })">Copy token &amp; open the Shortcut</button>`
    : `<button type="button" onclick="${copy}.then(() => { this.textContent = 'Copied ✓'; })">Copy token</button>`;
  const steps = env.SHORTCUT_URL
    ? `<li>Tap the button above — it copies your token and opens the Shortcut.</li>
    <li>Tap <b>Add Shortcut</b> (or <b>Replace</b> if you already have it) and paste the token when it asks.</li>`
    : `<li>Copy the token above.</li>
    <li>Paste it into the Shortcut where it asks for your access token.</li>`;
  const keep = revisitable
    ? 'Keep this page private: anyone with its link can see your token. You can come back to it if you lose the token.'
    : '<b>Save your token now</b> — for your security it can’t be shown again.';
  const upgrade = row.plan === 'free' ? ' · <a href="/#pricing">Upgrade</a>' : '';

  return new Response(
    htmlPage(
      `<header><h1>Your pass</h1></header>
<div class="card pad">
  <p class="muted">Your access token</p>
  <div class="token" id="token">${escapeHtml(token)}</div>
  ${button}
</div>
<div class="card pad">
  <h2>Set up on your iPhone</h2>
  <ol>
    ${steps}
    <li>Tap the Shortcut whenever you want to see the buses near you. <a href="/install">Install guide</a></li>
  </ol>
</div>
<p class="muted small">${escapeHtml(capitalize(row.plan))} pass · ${validity}${limit} · ref ${escapeHtml(row.id)}${upgrade}<br>${keep}</p>`,
      { title: `Your ${PRODUCT_NAME} pass` }
    ),
    { headers: HTML_HEADERS }
  );
}

async function handleFreeSignup(request, env, now) {
  if (!env.DB) return new Response('Not found', { status: 404 });
  // Free passes are capped per network per day. The key is a one-way hash that changes daily,
  // so it can limit sign-ups without the IP address being stored or followed over time.
  const ip = request.headers.get('cf-connecting-ip') || 'unknown';
  const signupKey = await sha256(`free-signup:${sgtDay(now)}:${ip}:${env.ADMIN_SECRET ?? ''}`);
  const { n } = await env.DB.prepare('SELECT COUNT(*) AS n FROM tokens WHERE signup_key = ?1').bind(signupKey).first();
  if (n >= FREE_SIGNUPS_PER_NETWORK_PER_DAY) {
    return sitePage(
      env,
      now,
      `<h1 class="title">You don't need a pass.</h1>
<p>Free is built in: add the Shortcut and you get ${ANONYMOUS_DAILY_LIMIT} checks a day, no token required.</p>
<p><a class="pill" href="${escapeHtml(env.SHORTCUT_URL || '/install')}">Add ${PRODUCT_NAME} to iPhone</a></p>`,
      PRODUCT_NAME,
      { status: 429 }
    );
  }
  const token = newToken();
  const row = await insertToken(env.DB, now, {
    ...planSettings('free', {}),
    tokenHash: await sha256(token),
    signupKey,
  });
  return passPage(token, row, env, { revisitable: false });
}

// What the landing page's demo shows — a typical lunchtime at Lakeside.
const SAMPLE_STOPS = (() => {
  const st = (name, codes) => ({ name, codes });
  const svc = (no, buses, destination, nextStations = []) => ({
    no,
    buses: buses.map(([mins, load, live = true]) => ({ mins, load, live })),
    destination: { name: destination },
    nextStations,
  });
  return [
    {
      code: '28091', name: 'Lakeside Stn', road: 'Boon Lay Way', distance: 90,
      services: [
        svc('49', [[3, 'seats'], [12, 'seats']], 'Jurong East Int', [st('Chinese Garden', ['EW25']), st('Jurong East', ['NS1', 'EW24'])]),
        svc('180', [[0, 'full'], [6, 'standing']], 'Boon Lay Int', [st('Boon Lay', ['EW27'])]),
        svc('240', [[5, 'seats'], [13, 'seats']], 'Boon Lay Int'),
      ],
    },
    {
      code: '28099', name: 'Opp Lakeside Stn', road: 'Boon Lay Way', distance: 186,
      services: [
        svc('98', [[2, 'standing'], [9, 'seats']], 'Jurong East Int', [st('Jurong East', ['NS1', 'EW24'])]),
        svc('154', [[7, 'seats'], [15, 'seats', false]], 'Boon Lay Int'),
      ],
    },
  ];
})();

function renderLanding(env, now) {
  const promo = now <= PROMO_ENDS_AT;
  const monthly = PAID_PLANS.find((p) => p.plan === 'monthly');
  const priceOf = (p) => (promo ? p.promoPrice : p.price);
  const install = escapeHtml(env.SHORTCUT_URL || '/install');

  const paidCards = PAID_PLANS.map((p) => {
    const link = (promo && env[`${p.link}_PROMO`]) || env[p.link];
    const savings = p.per === 'year' && monthly ? Math.round((1 - priceOf(p) / (priceOf(monthly) * 12)) * 100) : 0;
    return `<div class="plan glass${p.per === 'year' ? ' best' : ''}">
  <h3>${escapeHtml(p.label)}${savings > 0 ? ` <span class="tag">Save ${savings}%</span>` : ''}</h3>
  <div class="was">${promo ? money(p.price) : ''}</div>
  <div class="price">${money(priceOf(p))} <small>/ ${p.per}</small></div>
  <ul><li>Up to ${PLANS[p.plan].dailyLimit} checks a day</li><li>Live arrivals and crowding</li><li>Cancel any time</li></ul>
  ${link ? `<a class="pill" href="${escapeHtml(link)}">Subscribe</a>` : '<button class="pill" type="button" disabled>Coming soon</button>'}
</div>`;
  }).join('\n');

  const offer = promo
    ? `<div class="offer glass"><b>Launch offer</b> — subscribe by ${formatDate(PROMO_ENDS_AT)} and keep the launch price for as long as you stay subscribed.</div>`
    : '';

  return sitePage(
    env,
    now,
    `<section class="dark hero center">
  <div class="wrap">
    <p class="eyebrow">Live bus arrivals · Singapore</p>
    <h1 class="headline">Which bus is coming?<br>One tap.</h1>
    <p class="lede">${PRODUCT_NAME} finds the stops nearest you — both sides of the road — and shows live arrival times and how full each bus is. No app. No stop codes.</p>
    <div class="ctas"><a class="pill" href="${install}">Try it free</a><a class="pill ghost" href="#pricing">See pricing</a></div>
    <div class="phone" aria-label="Example of what you see">
      <div class="screen">
        <div class="screen-title">Nearby buses</div>
        ${SAMPLE_STOPS.map(renderStopCard).join('\n')}
      </div>
    </div>
  </div>
</section>

<section class="light band" id="features">
  <div class="wrap">
    <h2 class="title center">Built for the bus stop.</h2>
    <p class="lede center light">Everything you need in the ten seconds before you decide to run.</p>
    <div class="grid">
      <div class="tile"><div class="icon">📍</div><h3>Both sides of the road</h3><p>The three closest stops, so the one across the street is covered too.</p></div>
      <div class="tile"><div class="icon">🟢</div><h3>Know if there's a seat</h3><p>Every bus shows whether it has seats, standing room, or is packed.</p></div>
      <div class="tile"><div class="icon">⚡</div><h3>Nothing to search</h3><p>It works out where you are. No stop codes, no maps, no menus.</p></div>
      <div class="tile"><div class="icon">🔒</div><h3>No account, no tracking</h3><p>Your location is used for the lookup and never stored.</p></div>
    </div>
  </div>
</section>

<section class="light band" style="padding-top:0">
  <div class="wrap">
    <h2 class="title center">Ready in a minute.</h2>
    <p class="lede center light">No sign-up. No app store. It's a Shortcut.</p>
    <div class="steps3">
      <div><h3>Add the Shortcut</h3><p>Tap <a href="${install}">Try it free</a> on your iPhone, then Add Shortcut. That's the whole setup.</p></div>
      <div><h3>Tap it</h3><p>From your Home Screen, a widget, Siri or the Action button. ${ANONYMOUS_DAILY_LIMIT} checks a day are free.</p></div>
      <div><h3>Need more?</h3><p>Subscribe below and paste your token into the Shortcut. Done.</p></div>
    </div>
  </div>
</section>

<section class="dark band center" id="pricing">
  <div class="wrap">
    <h2 class="title">Simple pricing.</h2>
    <p class="lede">Free every day. Upgrade when four checks aren't enough.</p>
    ${offer}
    <div class="plans">
      <div class="plan glass">
        <h3>Free</h3>
        <div class="was"></div>
        <div class="price">${CURRENCY}0</div>
        <ul><li>${ANONYMOUS_DAILY_LIMIT} checks a day</li><li>Built in — no sign-up, no token</li><li>Just add the Shortcut and tap</li></ul>
        <a class="pill ghost" href="${install}">Get free pass</a>
        <p class="note">Free is on by default — you don't need a pass to use it.</p>
      </div>
      ${paidCards}
    </div>
    <p class="fine">Prices in SGD. Subscriptions renew automatically until cancelled. Runs as an Apple Shortcut on iPhone, or as a <a href="/app">Home Screen web app</a>.</p>
  </div>
</section>`,
    `${PRODUCT_NAME} — live bus arrivals near you, in one tap`,
    { bare: true }
  );
}

function renderInstall(env, now) {
  const add = env.SHORTCUT_URL
    ? `<a class="pill" href="${escapeHtml(env.SHORTCUT_URL)}">Add ${PRODUCT_NAME} to iPhone</a>`
    : '<button class="pill" type="button" disabled>Coming soon</button>';
  return sitePage(
    env,
    now,
    `<article class="legal">
  <h1 class="title">Install ${PRODUCT_NAME}</h1>
  <p>${PRODUCT_NAME} runs as an Apple Shortcut on your iPhone. Setup takes under a minute and needs no account.</p>
  <p style="margin:24px 0 8px">${add}</p>

  <h2>1. Add the Shortcut</h2>
  <p>On your iPhone, tap the button above. The Shortcuts app opens; tap <b>Add Shortcut</b>.</p>

  <h2>2. Access token: leave it empty, or paste yours</h2>
  <p>It asks for an access token. <b>Leave it empty to use the free plan</b> — ${ANONYMOUS_DAILY_LIMIT} checks a day, nothing to sign up for. If you've subscribed, paste the token from the page you saw after paying.</p>

  <h2>3. Run it once and allow access</h2>
  <p>Tap the Shortcut. The first time, iOS asks to use your location and to connect to ${PRODUCT_NAME}'s server — tap <b>Allow</b> (or <b>Always Allow</b>) for both. After that it opens straight to the buses near you.</p>

  <h2>4. Keep it one tap away</h2>
  <ul>
    <li><b>Home Screen:</b> in Shortcuts, touch and hold ${PRODUCT_NAME} › Share › Add to Home Screen.</li>
    <li><b>Widget:</b> add a Shortcuts widget to your Home Screen or Lock Screen and pick ${PRODUCT_NAME}.</li>
    <li><b>Action button</b> (iPhone 15 Pro and later): Settings › Action Button › Shortcut › ${PRODUCT_NAME}.</li>
    <li><b>Siri:</b> say "Hey Siri, ${PRODUCT_NAME}".</li>
  </ul>

  <h2>No Shortcuts? Use the web app</h2>
  <p>Open <a href="/app">${PRODUCT_NAME} web app</a> in Safari, tap <b>Share</b> › <b>Add to Home Screen</b>, and allow location when asked. It opens full screen like an app. Subscribers tap <b>Token</b> in the app and paste their token.</p>

  <h2>Upgrading later</h2>
  <p>Pick a plan on the <a href="/#pricing">pricing page</a>. After paying, tap <b>Copy token &amp; open the Shortcut</b>, choose <b>Replace</b>, and paste the token when asked.</p>

  <h2>If something's off</h2>
  <ul>
    <li><b>"You've used today's ${ANONYMOUS_DAILY_LIMIT} free checks"</b> — the free plan resets at midnight, or <a href="/#pricing">upgrade</a>.</li>
    <li><b>It can't find your location</b> — Settings › Privacy &amp; Security › Location Services › Shortcuts › While Using the App.</li>
    <li><b>"Invalid access token"</b> — re-add the Shortcut from the button above and paste the token again, or leave it empty for the free plan.</li>
    <li><b>The link opens a web page instead of the Shortcuts app</b> — open it on your iPhone, in Safari.</li>
  </ul>
</article>`,
    `Install — ${PRODUCT_NAME}`
  );
}

function renderPrivacy(env, now) {
  const contact = env.SUPPORT_EMAIL ? `<a href="mailto:${escapeHtml(env.SUPPORT_EMAIL)}">${escapeHtml(env.SUPPORT_EMAIL)}</a>` : 'us';
  return sitePage(
    env,
    now,
    `<article class="legal">
  <h1 class="title">Privacy policy</h1>
  <p class="muted">Last updated ${LEGAL_UPDATED}</p>
  <p>${PRODUCT_NAME} shows live bus arrivals near you. We collect as little as we can to do that, and we don't sell or share your data for advertising.</p>

  <h2>What we collect and why</h2>
  <ul>
    <li><b>Your location, at the moment you check.</b> Used to find the nearest bus stops, then discarded. It is not saved by the service. Only bus stop codes are sent on to the Land Transport Authority.</li>
    <li><b>Your email address and Stripe customer and subscription IDs</b>, if you buy a plan. Used to run your subscription, renew or end your pass, and answer support requests.</li>
    <li><b>Usage counts for your pass</b> — how many checks today and in total, and when it was last used. Used to apply the daily limit and to stop passes being shared.</li>
    <li><b>A one-way code derived from your device's details</b> (its name, model, iOS version and screen size), if you use the free tier without a token. The Shortcut sends these details; we keep only the code and a count of today's checks, to apply the free daily limit. The details themselves aren't stored.</li>
    <li><b>A one-way, daily-changing code derived from your network address</b>, if you get a free pass. Used only to limit how many free passes one network can create in a day; it can't be turned back into your address.</li>
  </ul>
  <p>Payment card details go directly to Stripe and never reach us.</p>

  <h2>Who processes it</h2>
  <ul>
    <li><b>Cloudflare</b> hosts the service and its database.</li>
    <li><b>Stripe</b> handles payments and subscriptions.</li>
    <li><b>Land Transport Authority (LTA DataMall)</b> provides arrival times. It receives bus stop codes, not your location.</li>
  </ul>

  <h2>How long we keep it</h2>
  <p>Pass records, including your email, are kept while your pass is active and for up to 12 months after it ends, for support and accounting. Ask us and we'll delete them sooner, unless the law requires us to keep them.</p>

  <h2>Your rights</h2>
  <p>Under Singapore's Personal Data Protection Act you can ask to see, correct or delete the personal data we hold about you, or withdraw your consent. Contact ${contact}.</p>
</article>`,
    `Privacy — ${PRODUCT_NAME}`
  );
}

function renderTerms(env, now) {
  const contact = env.SUPPORT_EMAIL ? `<a href="mailto:${escapeHtml(env.SUPPORT_EMAIL)}">${escapeHtml(env.SUPPORT_EMAIL)}</a>` : 'us';
  return sitePage(
    env,
    now,
    `<article class="legal">
  <h1 class="title">Terms of use</h1>
  <p class="muted">Last updated ${LEGAL_UPDATED}</p>

  <h2>The service</h2>
  <p>${PRODUCT_NAME} shows estimated bus arrival times from LTA DataMall. Estimates come from LTA and can be late, missing or wrong — please allow a margin. We aim to keep the service running but can't guarantee it will always be available or accurate.</p>

  <h2>Your pass</h2>
  <ul>
    <li>A pass is for one person. Don't share or publish your token; passes that are shared may be limited or disabled.</li>
    <li>Each pass has a daily limit on checks, shown on the pricing page.</li>
    <li>We may disable a pass that is used to overload or misuse the service.</li>
  </ul>

  <h2>Payments and cancellation</h2>
  <ul>
    <li>Paid plans are subscriptions billed in advance by Stripe and renew automatically until cancelled.</li>
    <li>You can cancel any time; your pass keeps working until the end of the period you've paid for.</li>
    <li>Payments aren't refunded for partly used periods, except where the law requires it.</li>
    <li>If we change prices, we'll tell existing subscribers before the change applies to them.</li>
  </ul>

  <h2>Liability</h2>
  <p>To the extent the law allows, the service is provided as is, and our total liability to you is limited to what you paid us in the 12 months before a claim.</p>

  <h2>Contact and law</h2>
  <p>Questions: ${contact}. These terms are governed by the laws of Singapore.</p>
</article>`,
    `Terms — ${PRODUCT_NAME}`
  );
}

// ---------------------------------------------------------------------------
// Home Screen web app (/app): full screen, no browser bars. Uses the browser's location, keeps a
// random device ID and the optional token in localStorage, and shows the same arrivals page by
// fetching ?format=html and swapping in its cards.
// ---------------------------------------------------------------------------

const APP_CSS = `
  body { padding-top: calc(16px + env(safe-area-inset-top)); min-height: 100vh; }
  header { gap: 12px; }
  header h1 { white-space: nowrap; }
  header .tools { display: flex; gap: 14px; align-items: baseline; flex: none; }
  header button { all: unset; color: var(--muted); font-size: 13px; cursor: pointer; }
  #status { text-align: center; color: var(--muted); padding: 40px 16px; }
  #content.loading { opacity: .55; transition: opacity .2s; }
  .hint { padding: 12px 16px; font-size: 14px; line-height: 1.4; }
  dialog { border: 0; border-radius: 16px; padding: 18px; width: min(92vw, 420px); background: var(--card); color: var(--text); }
  dialog::backdrop { background: rgba(0, 0, 0, .4); }
  dialog h2 { font-size: 19px; margin: 0 0 6px; }
  dialog p { margin: 0 0 12px; font-size: 14px; color: var(--muted); line-height: 1.4; }
  dialog input {
    width: 100%; font: 16px ui-monospace, SFMono-Regular, Menlo, monospace; padding: 11px 12px; margin-bottom: 12px;
    border: 1px solid var(--line); border-radius: 10px; background: var(--bg); color: var(--text);
  }
  dialog .btns { display: grid; gap: 8px; }
  dialog .btn.secondary { box-shadow: none; }
`;

const APP_SCRIPT = `
(() => {
  const store = {
    get: (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
    set: (k, v) => { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch {} },
  };
  let device = store.get('busnearby.device');
  if (!device) { device = 'app:' + crypto.randomUUID(); store.set('busnearby.device', device); }

  const $ = (id) => document.getElementById(id);
  const content = $('content'), status = $('status'), updated = $('updated');
  const standalone = navigator.standalone || matchMedia('(display-mode: standalone)').matches;
  if (!standalone) $('install').hidden = false;

  let timer, lastLoad = 0, busy = false;
  const say = (msg) => { status.textContent = msg; status.hidden = !msg; };

  function locate() {
    return new Promise((resolve, reject) =>
      navigator.geolocation
        ? navigator.geolocation.getCurrentPosition(resolve, reject, { enableHighAccuracy: true, timeout: 15000, maximumAge: 15000 })
        : reject({ code: 0 })
    );
  }

  async function load() {
    if (busy) return;
    busy = true; clearTimeout(timer);
    content.classList.add('loading');
    if (!content.childElementCount) say('Finding buses near you…');
    try {
      const pos = await locate();
      const q = new URLSearchParams({ lat: pos.coords.latitude.toFixed(6), lon: pos.coords.longitude.toFixed(6), format: 'html', device });
      const token = store.get('busnearby.token');
      if (token) q.set('token', token);
      const res = await fetch('/?' + q, { cache: 'no-store' });
      const doc = new DOMParser().parseFromString(await res.text(), 'text/html');
      doc.querySelector('header')?.remove();
      content.replaceChildren(...doc.body.children);
      say('');
      lastLoad = Date.now();
      updated.textContent = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }) + ' ↻';
      // The server decides whether this pass auto-refreshes (paid passes do, the free one doesn't).
      const refresh = parseInt(doc.querySelector('meta[http-equiv="refresh"]')?.content, 10);
      if (refresh > 0) timer = setTimeout(() => document.hidden || load(), refresh * 1000);
    } catch (err) {
      say(err && err.code === 1
        ? 'Location is off for ${PRODUCT_NAME}. Allow it in Settings › Privacy & Security › Location Services › Safari Websites, then tap ↻.'
        : err && 'code' in err ? 'Couldn\\'t get your location. Tap ↻ to try again.' : 'Couldn\\'t reach ${PRODUCT_NAME}. Check your connection and tap ↻.');
    } finally {
      busy = false;
      content.classList.remove('loading');
    }
  }

  updated.onclick = load;
  // Reopening the app should show fresh times, without spending a check on a quick app switch.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - lastLoad > 60000) load(); });

  const dlg = $('settings'), input = $('token');
  $('open-settings').onclick = () => { input.value = store.get('busnearby.token'); dlg.showModal(); };
  $('save').onclick = () => { store.set('busnearby.token', input.value.trim()); dlg.close(); load(); };
  $('clear').onclick = () => { store.set('busnearby.token', ''); dlg.close(); load(); };
  $('cancel').onclick = () => dlg.close();

  load();
})();
`;

function renderApp() {
  const head = `<link rel="manifest" href="/app.webmanifest">
<link rel="apple-touch-icon" href="/app-icon-180.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="${PRODUCT_NAME}">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="theme-color" content="#f2f2f7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">`;
  return new Response(
    htmlPage(
      `<header><h1>Nearby buses</h1><div class="tools"><button id="updated" type="button">↻</button><button id="open-settings" type="button" aria-label="Settings">Token</button></div></header>
<div id="install" class="card notice hint" hidden>Add ${PRODUCT_NAME} to your Home Screen for a full-screen app: tap <b>Share</b> › <b>Add to Home Screen</b>.</div>
<p id="status">Finding buses near you…</p>
<main id="content"></main>
<dialog id="settings">
  <h2>Access token</h2>
  <p>Leave empty for the free plan (${ANONYMOUS_DAILY_LIMIT} checks a day). Subscribed? Paste the token from the page you saw after paying. <a href="/#pricing">See plans</a></p>
  <input id="token" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Paste token">
  <div class="btns"><button id="save" type="button">Save</button><button id="clear" class="btn secondary" type="button">Use free plan</button><button id="cancel" class="btn secondary" type="button">Cancel</button></div>
</dialog>
<script>${APP_SCRIPT}</script>`,
      { title: PRODUCT_NAME, css: APP_CSS, head }
    ),
    { headers: HTML_HEADERS }
  );
}

function appManifest() {
  return Response.json(
    {
      id: '/app',
      name: PRODUCT_NAME,
      short_name: PRODUCT_NAME,
      description: 'Live bus arrivals at the stops nearest you, in Singapore.',
      start_url: '/app',
      scope: '/app',
      display: 'standalone',
      background_color: '#f2f2f7',
      theme_color: '#f2f2f7',
      icons: [
        { src: '/app-icon-180.png', sizes: '180x180', type: 'image/png' },
        { src: '/app-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      ],
    },
    { headers: { 'content-type': 'application/manifest+json', 'cache-control': 'public, max-age=86400' } }
  );
}

const appIcon = (b64) =>
  new Response(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)), {
    headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=604800' },
  });

export default {
  // Cron trigger (wrangler.toml): keeps building / refreshing the routes table in the background.
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(refreshRoutesStep(env, Date.now()));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const now = Date.now();

    if (url.pathname.startsWith('/admin/')) return handleAdmin(request, url, env, now);
    if (url.pathname === '/stripe/webhook' && request.method === 'POST') return handleStripeWebhook(request, env, now);
    if (url.pathname === '/welcome') return handleWelcome(url, env, now);
    if (url.pathname === '/free' && request.method === 'POST') return handleFreeSignup(request, env, now);
    // The website is only for deployments that sell passes (DB bound); otherwise / stays a plain API.
    if (env.DB && request.method === 'GET') {
      const isApiCall = url.searchParams.has('lat') || url.searchParams.has('token') || request.headers.has('authorization');
      if (url.pathname === '/' && !isApiCall) return renderLanding(env, now);
      if (url.pathname === '/privacy') return renderPrivacy(env, now);
      if (url.pathname === '/terms') return renderTerms(env, now);
      if (url.pathname === '/install') return renderInstall(env, now);
      if (url.pathname === '/app') return renderApp();
      if (url.pathname === '/app.webmanifest') return appManifest();
      if (url.pathname === '/app-icon-180.png') return appIcon(APP_ICON_180);
      if (url.pathname === '/app-icon-512.png') return appIcon(APP_ICON_512);
    }

    const format = url.searchParams.get('format');
    // Where expired and free passes are sent to renew or upgrade: your own link, or the pricing section.
    const renewUrl = env.RENEW_URL || `${url.origin}/#pricing`;
    const access = await authorize(request, url, env, now);
    if (access.error) return renderError(access.error, format, renewUrl);

    const lat = parseFloat(url.searchParams.get('lat'));
    const lon = parseFloat(url.searchParams.get('lon'));
    if (isNaN(lat) || isNaN(lon)) {
      return new Response('Missing lat/lon', { status: 400 });
    }

    const ACCOUNT_KEY = env.LTA_API_KEY; // set this in Worker Settings > Variables
    const headers = { AccountKey: ACCOUNT_KEY, accept: 'application/json' };

    // Only the owner can force a full re-fetch of the stop list — it's 12 LTA calls and a KV write.
    const forceRefresh = access.owner === true && url.searchParams.get('refresh') === '1';
    const allStops = await getAllStops(env, headers, forceRefresh);

    if (allStops.length === 0) {
      return new Response('Could not load bus stop list — check LTA_API_KEY', { status: 502 });
    }

    // Nearest few stops (covers both directions of a road / an intersection)
    const nearest = allStops
      .map((s) => ({ ...s, d: dist(lat, lon, s.Latitude, s.Longitude) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, NEAREST_STOPS);

    const routesPromise = getRoutes(env);
    const arrivals = await Promise.all(
      nearest.map((s) =>
        fetchLta(`v3/BusArrival?BusStopCode=${s.BusStopCode}`, headers, (b) => Array.isArray(b.Services))
      )
    );

    const routes = await routesPromise;
    ctx?.waitUntil(refreshRoutesStep(env, now, routes));
    const stopsByCode = new Map(allStops.map((s) => [s.BusStopCode, s]));
    const stops = nearest.map((stop, i) => toStopModel(stop, arrivals[i], now, { routes, stopsByCode }));
    const pass = access.pass;
    const warning = expiryWarning(pass, now);

    switch (format) {
      case 'html':
        return new Response(renderHtml(stops, now, { pass, warning, renewUrl: warning && renewUrl }), {
          headers: HTML_HEADERS,
        });
      case 'json':
        return Response.json({
          updatedAt: new Date(now).toISOString(),
          pass: pass && {
            plan: pass.plan,
            expiresAt: isoOrNull(pass.expires_at),
            dailyLimit: pass.daily_limit,
            usedToday: pass.usage_count,
          },
          stops,
        });
      default:
        return new Response(renderText(stops, warning, warning && renewUrl), { headers: TEXT_HEADERS });
    }
  },
};
