// Loading LTA's paginated stop list: retries, never caching an incomplete list, lists past one batch.
// Run with `node --test`.
import assert from 'node:assert/strict';
import worker from '../worker/bus-nearest-worker.js';

const near = { BusStopCode: '00001', Description: 'Near', RoadName: 'Road', Latitude: 1.3, Longitude: 103.8 };
const filler = (n, from) => Array.from({ length: n }, (_, i) => ({ ...near, BusStopCode: String(from + i), Latitude: 1.5 }));

function setup({ total, failing = {} }) {
  const stops = [near, ...filler(total - 1, 10000)];
  const calls = [];
  globalThis.fetch = async (u) => {
    const url = new URL(u);
    if (!url.pathname.endsWith('/BusStops')) return new Response(JSON.stringify({ Services: [] }));
    const skip = Number(url.searchParams.get('$skip'));
    calls.push(skip);
    if (failing[skip] > 0) {
      failing[skip]--;
      return new Response('Too many requests', { status: 429 });
    }
    return new Response(JSON.stringify({ value: stops.slice(skip, skip + 500) }));
  };
  const kv = new Map();
  const env = { LTA_API_KEY: 'k', BUS_STOPS_KV: { get: async (k) => (kv.has(k) ? JSON.parse(kv.get(k)) : null), put: async (k, v) => void kv.set(k, v) } };
  const cached = () => (kv.has('bus_stops_cache') ? JSON.parse(kv.get('bus_stops_cache')).length : null);
  const request = () => worker.fetch(new Request('https://x.dev/?lat=1.3&lon=103.8&format=json'), env);
  return { calls, cached, request };
}

// A page that fails twice then loads is retried, and the full list is cached
let t = setup({ total: 5210, failing: { 1500: 2 } });
let res = await t.request();
assert.equal(res.status, 200);
assert.equal(t.cached(), 5210);
assert.equal(t.calls.filter((s) => s === 1500).length, 3);

// A page that never loads: this request is still served, but nothing is cached, so the next one retries
t = setup({ total: 5210, failing: { 3000: 99 } });
res = await t.request();
assert.equal(res.status, 200);
assert.equal((await res.json()).stops[0].code, '00001');
assert.equal(t.cached(), null, 'incomplete list must not be cached');

// More stops than one batch of 12 pages: keeps going until a short page
t = setup({ total: 6400 });
await t.request();
assert.equal(t.cached(), 6400);
assert.ok(t.calls.includes(6000));

// BusArrival calls are retried too: a throttled first attempt still yields arrival times
{
  let arrivalCalls = 0;
  const env = { LTA_API_KEY: 'k' };
  globalThis.fetch = async (u) => {
    const url = new URL(u);
    if (url.pathname.endsWith('/BusStops')) return new Response(JSON.stringify({ value: url.searchParams.get('$skip') === '0' ? [near] : [] }));
    arrivalCalls++;
    if (arrivalCalls === 1) return new Response('Too many requests', { status: 429 });
    return new Response(JSON.stringify({ Services: [{ ServiceNo: '14', NextBus: { EstimatedArrival: new Date(Date.now() + 5 * 60000).toISOString() } }] }));
  };
  const body = await (await worker.fetch(new Request('https://x.dev/?lat=1.3&lon=103.8&format=json'), env)).json();
  assert.equal(arrivalCalls, 2);
  assert.deepEqual(body.stops[0].services.map((s) => s.no), ['14']);
}
