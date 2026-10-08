// Destination and next MRT stations per service. Run with `node --test`.
import assert from 'node:assert/strict';
import worker from '../worker/bus-nearest-worker.js';
import { MRT_STATIONS } from '../worker/mrt-stations.js';

const exitOf = (name) => MRT_STATIONS.find(([n]) => n === name)[2][0];
const at = (name, dLat = 0.0002) => { const [lat, lon] = exitOf(name); return { Latitude: lat + dLat, Longitude: lon }; };
const stop = (code, description, pos) => ({ BusStopCode: code, Description: description, RoadName: 'Rd', ...pos });

// Lakeside → Chinese Garden → Jurong East, with plain stops in between; Boon Lay the other way.
const STOPS = [
  stop('28091', 'Lakeside Stn', at('Lakeside')),
  stop('28001', 'Blk 1', { Latitude: 1.3400, Longitude: 103.7300 }),
  stop('28002', 'Chinese Garden Stn', at('Chinese Garden')),
  stop('28003', 'Opp Chinese Garden Stn', at('Chinese Garden', -0.0003)),
  stop('28004', 'Blk 2', { Latitude: 1.3380, Longitude: 103.7380 }),
  stop('28009', 'Jurong East Int', at('Jurong East')),
  stop('22009', 'Boon Lay Int', at('Boon Lay')),
  stop('28005', 'Blk 3', { Latitude: 1.3500, Longitude: 103.7100 }),
  stop('28006', 'Far Away', { Latitude: 1.4000, Longitude: 103.9000 }),
];
const ROUTES = {
  '49|1': '22009,28091,28001,28002,28003,28004,28009',
  '49|2': '28009,28004,28003,28002,28001,28091,22009',
  '240|1': '28091,28005,28006', // no station ahead
};

let clock = Date.parse('2026-10-08T01:00:00Z');
Date.now = () => clock;
const bus = (m, dest) => ({ EstimatedArrival: new Date(clock + m * 60000 + 10000).toISOString(), Load: 'SEA', Monitored: 1, DestinationCode: dest });
let routeCalls = 0;
globalThis.fetch = async (u) => {
  const url = new URL(u);
  if (url.pathname.endsWith('/BusStops')) return new Response(JSON.stringify({ value: url.searchParams.get('$skip') === '0' ? STOPS : [] }));
  if (url.pathname.endsWith('/BusRoutes')) { routeCalls++; return new Response(JSON.stringify({ value: [] })); }
  const code = url.searchParams.get('BusStopCode');
  if (code !== '28091') return new Response(JSON.stringify({ Services: [] }));
  return new Response(JSON.stringify({ Services: [
    { ServiceNo: '49', NextBus: bus(3, '28009'), NextBus2: bus(12, '28009'), NextBus3: bus(20, '28009') },
    { ServiceNo: '240', NextBus: bus(5, '28006'), NextBus2: bus(13, '28006'), NextBus3: {} },
    { ServiceNo: '99', NextBus: bus(9, 'nowhere'), NextBus2: {}, NextBus3: {} },
  ] }));
};

const kv = new Map();
const KV = { get: async (k, t) => (kv.has(k) ? (t === 'json' ? JSON.parse(kv.get(k)) : kv.get(k)) : null), put: async (k, v) => void kv.set(k, v), delete: async (k) => void kv.delete(k) };
const env = { BUS_STOPS_KV: KV, LTA_API_KEY: 'k' };
const request = async (format) => {
  const pending = [];
  const res = await worker.fetch(new Request(`https://x.dev/?lat=${STOPS[0].Latitude}&lon=${STOPS[0].Longitude}&format=${format}`), env, { waitUntil: (p) => pending.push(p) });
  const body = format === 'json' ? await res.json() : await res.text();
  await Promise.all(pending);
  return body;
};
const svc = (body, no) => body.stops.find((s) => s.code === '28091').services.find((s) => s.no === no);

// Before the routes table exists: destination names, no stations yet, and a background build starts
let body = await request('json');
assert.deepEqual(svc(body, '49').destination, { code: '28009', name: 'Jurong East Int' });
assert.deepEqual(svc(body, '49').nextStations, []);
assert.equal(svc(body, '49').buses.length, 2, 'only the next two buses');
assert.ok(routeCalls > 0, 'routes table build started');

// With the routes table
kv.set('bus_route_stops', JSON.stringify({ updatedAt: clock, routes: ROUTES }));
body = await request('json');
const jurongEast = MRT_STATIONS.find(([n]) => n === 'Jurong East')[1];
assert.deepEqual(svc(body, '49').nextStations, [
  { name: 'Chinese Garden', codes: ['EW25'] },
  { name: 'Jurong East', codes: jurongEast },
], 'skips the station it is at, dedupes stops at the same station, picks the direction to the destination');
assert.deepEqual(svc(body, '240').nextStations, []);
assert.equal(svc(body, '240').destination.name, 'Far Away');
assert.deepEqual(svc(body, '99').destination, { code: 'nowhere', name: 'nowhere' });

const html = await request('html');
assert.match(html, /<span class="dest"><b>Jurong East Int<\/b><span class="mrt"><i class="ln" style="background:#009645">EW25<\/i>Chinese Garden<\/span>/);
assert.match(html, /<span class="dest solo">Far Away<\/span>/, 'no station ahead: destination fills the space');
assert.ok(!/<span class="t[^"]*"><i class="dot[^"]*"><\/i><b>20<\/b>/.test(html), 'third bus not shown');

const text = await request('text');
assert.match(text, /49   🟢3 · 🟢12 min → Jurong East Int \(🟩Chinese Garden, 🟥Jurong East\)\n/);
assert.match(text, /240   🟢5 · 🟢13 min → Far Away\n/);
