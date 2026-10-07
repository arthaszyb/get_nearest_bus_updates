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
  trial: { days: 7, dailyLimit: 100 },
  monthly: { days: 31, dailyLimit: 300 },
  yearly: { days: 366, dailyLimit: 300 },
  lifetime: { days: null, dailyLimit: 300 },
};
const EXPIRY_WARNING_DAYS = 3;
// Subscription tokens stay valid this long past the paid period, to cover Stripe's renewal lag and retries.
const SUBSCRIPTION_GRACE_DAYS = 2;
const STRIPE_SIGNATURE_TOLERANCE_SECONDS = 300;

const TEXT_HEADERS = { 'content-type': 'text/plain; charset=utf-8' };
const HTML_HEADERS = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };

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
  if (!token) return { error: { status: 401, message: 'Missing access token.' } };

  const pass = await recordUse(env.DB, await sha256(token), now);
  if (!pass) {
    return { error: { status: 401, message: 'Invalid access token. Check the token in your Shortcut.' } };
  }
  if (pass.status !== 'active') {
    return { error: { status: 403, message: 'This access token has been disabled.' } };
  }
  if (pass.expires_at !== null && now >= pass.expires_at) {
    return { error: { status: 402, message: `Your pass expired on ${formatDate(pass.expires_at)}.`, renew: true } };
  }
  if (pass.daily_limit !== null && pass.usage_count > pass.daily_limit) {
    return {
      error: { status: 429, message: `Daily limit of ${pass.daily_limit} requests reached. It resets at midnight (SGT).` },
    };
  }
  return { pass };
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
    stripeCheckoutSession = null, stripeSubscription = null }
) {
  const pending = days !== null && startOnFirstUse;
  return db
    .prepare(
      `INSERT INTO tokens (id, token_hash, plan, status, created_at, expires_at, pending_days, daily_limit,
                           customer, note, stripe_checkout_session, stripe_subscription)
       VALUES (?1, ?2, ?3, 'active', ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
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
      stripeSubscription
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
    new Response(htmlPage(`<header><h1>Bus pass</h1></header>\n${content}`, { refresh }), { headers: HTML_HEADERS });

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

  const validity = row.stripe_subscription
    ? `Renews automatically${row.expires_at ? ` · paid until ${formatDate(row.expires_at)}` : ''}`
    : row.expires_at
      ? `Valid until ${formatDate(row.expires_at)}`
      : 'Never expires';
  const shortcutStep = env.SHORTCUT_URL
    ? `<li><a href="${escapeHtml(env.SHORTCUT_URL)}">Add the Shortcut</a> and paste the token when it asks.</li>`
    : '<li>Paste it into the Shortcut where it asks for your access token.</li>';

  return page(`<div class="card pad">
  <p class="muted">Your access token</p>
  <div class="token" id="token">${escapeHtml(token)}</div>
  <button type="button" onclick="navigator.clipboard.writeText(document.getElementById('token').textContent).then(() => { this.textContent = 'Copied ✓'; })">Copy token</button>
</div>
<div class="card pad">
  <h2>Set up on your iPhone</h2>
  <ol>
    <li>Copy the token above.</li>
    ${shortcutStep}
    <li>Tap the Shortcut whenever you want to see the buses near you.</li>
  </ol>
</div>
<p class="muted small">${escapeHtml(row.plan)} pass · ${validity} · ref ${escapeHtml(row.id)}<br>
Keep this page private: anyone with its link can see your token. You can come back to it if you lose the token.</p>`);
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
      lines.push(`${svc.no}   ${times.join(' · ') || '–'}${unit}`);
    }
    lines.push('');
  }
  lines.push('🟢 Seats  🟡 Standing  🔴 Full');
  return lines.join('\n');
}

const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const renewLink = (renewUrl) => (renewUrl ? ` <a href="${escapeHtml(renewUrl)}">Renew</a>` : '');

function renderBusCell(bus, isNext) {
  if (!bus) return '<span class="t"></span>';
  const cls = ['t', isNext ? 'next' : '', bus.mins === 0 ? 'now' : '', bus.live ? '' : 'sched'].filter(Boolean).join(' ');
  const dot = bus.load
    ? `<i class="dot ${bus.load}" title="${LOAD_LABELS[bus.load]}" aria-label="${LOAD_LABELS[bus.load]}"></i>`
    : '<i class="dot"></i>';
  const time = bus.mins === 0 ? '<b>Now</b>' : `<b>${bus.mins}</b><small>min</small>`;
  return `<span class="${cls}">${dot}${time}</span>`;
}

function htmlPage(content, { refresh } = {}) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="referrer" content="no-referrer">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">\n` : ''}<title>Nearby buses</title>
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
  button {
    font: inherit; font-weight: 600; width: 100%; padding: 12px; border: 0; border-radius: 10px;
    background: var(--accent); color: #fff;
  }
  footer { display: flex; flex-wrap: wrap; gap: 6px 14px; color: var(--muted); font-size: 12px; margin: 4px 4px 0; }
  footer span { display: inline-flex; align-items: center; gap: 5px; }
</style>
</head>
<body>
${content}
</body>
</html>`;
}

function renderHtml(stops, now, { pass, warning, renewUrl }) {
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
    { refresh: 30 }
  );
}

function renderError({ status, message, renew }, format, env) {
  const renewUrl = renew ? env.RENEW_URL : undefined;
  switch (format) {
    case 'html':
      return new Response(
        htmlPage(`<header><h1>Nearby buses</h1></header>
<div class="card notice">${escapeHtml(message)}${renewLink(renewUrl)}</div>`),
        { status, headers: HTML_HEADERS }
      );
    case 'json':
      return Response.json({ error: message, renewUrl }, { status });
    default:
      return new Response(renewUrl ? `${message}\nRenew: ${renewUrl}` : message, { status, headers: TEXT_HEADERS });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const now = Date.now();

    if (url.pathname.startsWith('/admin/')) return handleAdmin(request, url, env, now);
    if (url.pathname === '/stripe/webhook' && request.method === 'POST') return handleStripeWebhook(request, env, now);
    if (url.pathname === '/welcome') return handleWelcome(url, env, now);

    const format = url.searchParams.get('format');
    const access = await authorize(request, url, env, now);
    if (access.error) return renderError(access.error, format, env);

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

    const stops = nearest.map((stop, i) => toStopModel(stop, arrivals[i], now));
    const pass = access.pass;
    const warning = expiryWarning(pass, now);
    const renewUrl = warning ? env.RENEW_URL : undefined;

    switch (format) {
      case 'html':
        return new Response(renderHtml(stops, now, { pass, warning, renewUrl }), { headers: HTML_HEADERS });
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
        return new Response(renderText(stops, warning, renewUrl), { headers: TEXT_HEADERS });
    }
  },
};
