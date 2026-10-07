// Background build of the routes table (which services call at each stop) and "Not running now".
// Run with `node --test`.
import assert from 'node:assert/strict';
import worker from '../worker/bus-nearest-worker.js';

let clock = Date.parse('2026-10-07T07:00:00Z');
Date.now = () => clock;

// 26,010 route rows → 53 pages. Stop 18101 is served by 14, 33, 97 and 197; LTA's arrivals only list 33 and 197.
const ROWS = [
  ...['197', '14', '97', '33'].map((no) => ({ ServiceNo: no, BusStopCode: '18101' })),
  ...Array.from({ length: 26006 }, (_, i) => ({ ServiceNo: String(100 + (i % 50)), BusStopCode: String(20000 + Math.floor(i / 5)) })),
];
const stop = { BusStopCode: '18101', Description: '5 Sci Pk Dr', RoadName: 'Buona Vista Flyover', Latitude: 1.2935, Longitude: 103.7856 };
const bus = (m) => ({ EstimatedArrival: new Date(clock + m * 60000 + 10000).toISOString(), Load: 'SEA', Monitored: 1 });

let routeCalls = [];
let failRoutesAt = null;
globalThis.fetch = async (u) => {
  const url = new URL(u);
  const skip = Number(url.searchParams.get('$skip'));
  if (url.pathname.endsWith('/BusStops')) return new Response(JSON.stringify({ value: skip === 0 ? [stop] : [] }));
  if (url.pathname.endsWith('/BusRoutes')) {
    routeCalls.push(skip);
    if (skip === failRoutesAt) return new Response('busy', { status: 503 });
    return new Response(JSON.stringify({ value: ROWS.slice(skip, skip + 500) }));
  }
  return new Response(JSON.stringify({ Services: [
    { ServiceNo: '197', NextBus: bus(4), NextBus2: bus(12), NextBus3: bus(15) },
    { ServiceNo: '33', NextBus: bus(3), NextBus2: bus(15), NextBus3: bus(29) },
  ] }));
};

// KV stand-in that honours expirationTtl
const kv = new Map();
const KV = {
  get: async (k, type) => {
    const e = kv.get(k);
    if (!e || (e.exp && clock >= e.exp)) return null;
    return type === 'json' ? JSON.parse(e.v) : e.v;
  },
  put: async (k, v, opts) => void kv.set(k, { v, exp: opts?.expirationTtl ? clock + opts.expirationTtl * 1000 : null }),
  delete: async (k) => void kv.delete(k),
};
const env = { BUS_STOPS_KV: KV, LTA_API_KEY: 'k' };

async function request(format = 'json') {
  const pending = [];
  const res = await worker.fetch(new Request(`https://x.dev/?lat=1.2935&lon=103.7856&format=${format}`), env, { waitUntil: (p) => pending.push(p) });
  const body = format === 'json' ? await res.json() : await res.text();
  await Promise.all(pending);
  return body;
}

// Before the table exists: arrivals as usual, nothing marked not running, and a step starts
let body = await request();
assert.deepEqual(body.stops[0].services.map((s) => s.no), ['33', '197']);
assert.deepEqual(body.stops[0].notRunning, []);
assert.equal(routeCalls.length, 12, 'one step = 12 pages');
assert.equal(Math.max(...routeCalls), 11 * 500);

// Lock: another request within the minute doesn't start a second step
routeCalls = [];
await request();
assert.equal(routeCalls.length, 0);

// A page failing mid-step: progress up to it is kept and the next step resumes there
clock += 61_000;
failRoutesAt = 20 * 500;
await request();
const job = JSON.parse(kv.get('bus_routes_job').v);
assert.equal(job.nextSkip, 20 * 500, 'resumes at the failed page');
failRoutesAt = null;

// Cron steps finish the table
for (let i = 0; i < 6 && !(await KV.get('bus_routes_by_stop')); i++) {
  clock += 61_000;
  const pending = [];
  await worker.scheduled({}, env, { waitUntil: (p) => pending.push(p) });
  await Promise.all(pending);
}
const table = await KV.get('bus_routes_by_stop', 'json');
assert.ok(table, 'routes table built');
assert.equal(table.byStop['18101'], '14,33,97,197');
assert.equal(Object.keys(table.byStop).length, 1 + Math.ceil(26006 / 5));
assert.equal(kv.has('bus_routes_job'), false, 'job cleaned up');

// Now 14 and 97 show as not running, in every format
body = await request();
assert.deepEqual(body.stops[0].notRunning, ['14', '97']);
const text = await request('text');
assert.match(text, /197   🟢4 · 🟢12 · 🟢15 min\nNot running now: 14, 97\n/);
const html = await request('html');
assert.match(html, /<div class="row empty">Not running now: 14, 97<\/div>/);

// Fresh table: no more LTA route calls, even after the lock expires
routeCalls = [];
clock += 61_000;
await request();
assert.equal(routeCalls.length, 0);

// A week later it's rebuilt in the background while the old table keeps being used
clock += 7 * 86400000;
body = await request();
assert.deepEqual(body.stops[0].notRunning, ['14', '97']);
assert.equal(routeCalls.length, 12);
