// Customer-token lifecycle against a real SQLite database standing in for D1.
// Run with `node --test` (Node 22+, for node:sqlite).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker from '../worker/bus-nearest-worker.js';

// --- D1 stand-in backed by real SQLite, schema from the repo's migration ---
const sqlite = new DatabaseSync(':memory:');
sqlite.exec(readFileSync(new URL('../migrations/0001_create_tokens.sql', import.meta.url), 'utf8'));
const DB = {
  prepare(sql) {
    const stmt = sqlite.prepare(sql);
    let args = [];
    const api = {
      bind: (...a) => { assert.ok(!a.includes(undefined), `undefined bound in: ${sql}`); args = a; return api; },
      first: async () => { const r = stmt.get(...args); return r ? { ...r } : null; },
      all: async () => ({ results: stmt.all(...args).map((r) => ({ ...r })) }),
    };
    return api;
  },
};

// --- LTA stand-in + controllable clock ---
const DAY = 86400000;
let clock = Date.parse('2026-10-07T01:00:00Z'); // 09:00 SGT
Date.now = () => clock;
let stopListFetches = 0;
globalThis.fetch = async (u) => {
  const url = new URL(u);
  if (url.pathname.endsWith('/BusStops')) {
    stopListFetches++;
    const value = url.searchParams.get('$skip') === '0'
      ? [{ BusStopCode: '28091', Description: 'Lakeside Stn', RoadName: 'Boon Lay Way', Latitude: 1.3442, Longitude: 103.721 }] : [];
    return new Response(JSON.stringify({ value }));
  }
  const bus = (m, load) => ({ EstimatedArrival: new Date(clock + m * 60000 + 10000).toISOString(), Load: load, Monitored: 1 });
  return new Response(JSON.stringify({ Services: [{ ServiceNo: '180', NextBus: bus(0, 'LSD'), NextBus2: bus(12, 'SDA'), NextBus3: bus(14, 'SEA') }] }));
};

const kv = new Map();
const BUS_STOPS_KV = { get: async (k) => (kv.has(k) ? JSON.parse(kv.get(k)) : null), put: async (k, v) => void kv.set(k, v) };
const env = { BUS_STOPS_KV, ACCESS_TOKEN: 'owner-secret', ADMIN_SECRET: 'admin-secret', LTA_API_KEY: 'k', DB, RENEW_URL: 'https://pay.example/renew' };
const get = (qs, e = env) => worker.fetch(new Request(`https://x.dev/?lat=1.3442&lon=103.721&${qs}`), e);
const admin = (method, path, body, secret = 'admin-secret', e = env) =>
  worker.fetch(new Request(`https://x.dev/admin/tokens${path}`, {
    method, headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  }), e);
const issue = async (body) => { const r = await admin('POST', '', body); assert.equal(r.status, 201); return r.json(); };

// Owner token: unlimited, refresh allowed; legacy single-token setup still works without DB
assert.equal((await get('token=owner-secret')).status, 200);
const noDb = { ACCESS_TOKEN: 'owner-secret', LTA_API_KEY: 'k' };
assert.equal((await get('token=owner-secret', noDb)).status, 200);
assert.equal((await get('token=wrong', noDb)).status, 401);
assert.equal((await get('', { LTA_API_KEY: 'k' })).status, 200, 'no gate configured stays open');
stopListFetches = 0; await get('token=owner-secret&refresh=1'); assert.equal(stopListFetches, 12);

// Admin auth
assert.equal((await admin('GET', '', null, 'nope')).status, 401);
assert.equal((await admin('GET', '', null, 'admin-secret', { ...env, ADMIN_SECRET: undefined })).status, 404);
assert.equal((await admin('POST', '', { plan: 'weekly' })).status, 400);
assert.equal((await admin('POST', '', { plan: 'monthly', days: -3 })).status, 400);

// Issue a monthly token; only its hash is stored
const monthly = await issue({ plan: 'monthly', customer: 'a@example.com', note: 'paid via PayNow' });
assert.match(monthly.token, /^sgb_[a-km-z2-9]{32}$/);
assert.match(monthly.id, /^tk_[a-km-z2-9]{8}$/);
assert.equal(monthly.expiresAt, new Date(clock + 31 * DAY).toISOString());
assert.equal(monthly.dailyLimit, 300);
assert.equal(monthly.state, 'active');
assert.ok(!JSON.stringify(sqlite.prepare('SELECT * FROM tokens').all()).includes(monthly.token));

// Customer token works (query param and Bearer header), counts usage, no refresh privilege
stopListFetches = 0;
let res = await get(`token=${monthly.token}&format=json&refresh=1`);
assert.equal(res.status, 200); assert.equal(stopListFetches, 0, 'customers cannot force refresh');
let body = await res.json();
assert.deepEqual(body.pass, { plan: 'monthly', expiresAt: monthly.expiresAt, dailyLimit: 300, usedToday: 1 });
res = await worker.fetch(new Request('https://x.dev/?lat=1.3442&lon=103.721', { headers: { authorization: `Bearer ${monthly.token}` } }), env);
assert.equal(res.status, 200);
let info = await (await admin('GET', `/${monthly.id}`)).json();
assert.equal(info.usedToday, 2); assert.equal(info.totalRequests, 2); assert.ok(info.firstUsedAt);
assert.ok(!(await (await get(`token=${monthly.token}`)).text()).includes('⚠️'), 'no warning far from expiry');

// Unknown token
res = await get('token=sgb_doesnotexist');
assert.equal(res.status, 401); assert.match(await res.text(), /Invalid access token/);

// Daily limit, then reset at SGT midnight
await admin('PATCH', `/${monthly.id}`, { dailyLimit: 4 });
assert.equal((await get(`token=${monthly.token}`)).status, 200); // 4th today
res = await get(`token=${monthly.token}`);
assert.equal(res.status, 429); assert.match(await res.text(), /Daily limit of 4/);
clock = Date.parse('2026-10-07T15:59:00Z'); // 23:59 SGT, same day
assert.equal((await get(`token=${monthly.token}`)).status, 429);
clock = Date.parse('2026-10-07T16:01:00Z'); // 00:01 SGT next day
assert.equal((await get(`token=${monthly.token}`)).status, 200);
await admin('PATCH', `/${monthly.id}`, { dailyLimit: null });

// Expiry warning within 3 days (text + html), then expiry with renew link
clock = Date.parse(monthly.expiresAt) - 2 * DAY;
let text = await (await get(`token=${monthly.token}`)).text();
assert.match(text, /^⚠️ Your pass expires on 7 Nov 2026\. Renew: https:\/\/pay\.example\/renew\n/);
let html = await (await get(`token=${monthly.token}&format=html`)).text();
assert.match(html, /class="card notice">⚠️ Your pass expires on 7 Nov 2026\. <a href="https:\/\/pay\.example\/renew">Renew<\/a>/);
assert.match(html, /Pass valid until 7 Nov 2026/);
clock = Date.parse(monthly.expiresAt);
res = await get(`token=${monthly.token}`);
assert.equal(res.status, 402);
assert.equal(await res.text(), 'Your pass expired on 7 Nov 2026.\nRenew: https://pay.example/renew');
res = await get(`token=${monthly.token}&format=html`);
assert.equal(res.status, 402); html = await res.text();
assert.ok(!html.includes('http-equiv="refresh"'), 'error page must not auto-refresh');
assert.deepEqual(await (await get(`token=${monthly.token}&format=json`)).json(), { error: 'Your pass expired on 7 Nov 2026.', renewUrl: 'https://pay.example/renew' });
assert.equal((await (await admin('GET', `/${monthly.id}`)).json()).state, 'expired');

// Renew late: counts from now, same token keeps working
clock += 5 * DAY;
info = await (await admin('POST', `/${monthly.id}/extend`, { days: 31 })).json();
assert.equal(info.expiresAt, new Date(clock + 31 * DAY).toISOString());
assert.equal((await get(`token=${monthly.token}`)).status, 200);
// Renew early: stacks onto the current expiry
const before = Date.parse(info.expiresAt);
info = await (await admin('POST', `/${monthly.id}/extend`, { days: 31 })).json();
assert.equal(Date.parse(info.expiresAt), before + 31 * DAY);
assert.equal((await admin('POST', `/${monthly.id}/extend`, { days: 0 })).status, 400);

// Revoke / reactivate
await admin('PATCH', `/${monthly.id}`, { status: 'revoked' });
res = await get(`token=${monthly.token}`);
assert.equal(res.status, 403); assert.equal(await res.text(), 'This access token has been disabled.');
assert.equal((await (await admin('GET', `/${monthly.id}`)).json()).state, 'revoked');
await admin('PATCH', `/${monthly.id}`, { status: 'active' });
assert.equal((await get(`token=${monthly.token}`)).status, 200);
assert.equal((await admin('PATCH', `/${monthly.id}`, { status: 'paused' })).status, 400);

// Rotate: old token dies, new one inherits everything
const rotated = await (await admin('POST', `/${monthly.id}/rotate`)).json();
assert.notEqual(rotated.token, monthly.token);
assert.equal(rotated.expiresAt, info.expiresAt);
assert.equal((await get(`token=${monthly.token}`)).status, 401);
assert.equal((await get(`token=${rotated.token}`)).status, 200);

// Trial code whose clock starts on first use
const trial = await issue({ plan: 'trial', startOnFirstUse: true });
assert.equal(trial.state, 'unused'); assert.equal(trial.expiresAt, null); assert.equal(trial.pendingDays, 7);
await admin('POST', `/${trial.id}/extend`, { days: 3 }); // still unused: adds to the pending days
clock += 20 * DAY;
assert.equal((await get(`token=${trial.token}`)).status, 200);
info = await (await admin('GET', `/${trial.id}`)).json();
assert.equal(info.state, 'active'); assert.equal(info.pendingDays, null);
assert.equal(info.expiresAt, new Date(clock + 10 * DAY).toISOString());
assert.equal(info.dailyLimit, 100);
clock += 10 * DAY;
assert.equal((await get(`token=${trial.token}`)).status, 402);

// Lifetime: never expires, extend is a no-op, absolute expiry can still be set
const lifetime = await issue({ plan: 'lifetime', dailyLimit: null });
assert.equal(lifetime.expiresAt, null); assert.equal(lifetime.dailyLimit, null);
clock += 3650 * DAY;
assert.equal((await get(`token=${lifetime.token}`)).status, 200);
assert.equal((await (await admin('POST', `/${lifetime.id}/extend`, { days: 30 })).json()).expiresAt, null);
assert.equal((await admin('PATCH', `/${lifetime.id}`, { expiresAt: 'not a date' })).status, 400);
await admin('PATCH', `/${lifetime.id}`, { expiresAt: new Date(clock - 1).toISOString() });
assert.equal((await get(`token=${lifetime.token}`)).status, 402);

// Listing and lookup
let list = await (await admin('GET', '?customer=a@example.com')).json();
assert.deepEqual(list.tokens.map((t) => t.id), [monthly.id]);
list = await (await admin('GET', '')).json();
assert.equal(list.tokens.length, 3);
assert.ok(list.tokens.every((t) => !('token' in t) && !('token_hash' in t)));
assert.equal((await admin('GET', '/tk_missing')).status, 404);
assert.equal((await admin('PATCH', '/tk_missing', { note: 'x' })).status, 404);
assert.equal((await admin('POST', '/tk_missing/rotate')).status, 404);
assert.equal((await admin('PATCH', `/${lifetime.id}`, {})).status, 400);

