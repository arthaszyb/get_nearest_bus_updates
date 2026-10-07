// Output formats against mocked LTA responses. Run with `node --test` (Node 22+).
import assert from 'node:assert/strict';
import worker from '../worker/bus-nearest-worker.js';

const ME = { lat: 1.3442, lon: 103.721 };
const M = 1 / 111320; // degrees latitude per metre
const stop = (code, desc, road, metres) => ({ BusStopCode: code, Description: desc, RoadName: road, Latitude: ME.lat + metres * M, Longitude: ME.lon });
const STOPS = [
  stop('28091', 'Lakeside Stn', 'Boon Lay Way', 90),
  stop('28099', 'Opp Lakeside Stn', 'Boon Lay Way', 186),
  stop('28381', 'Blk 515', 'Jurong West St 52', 222),
  stop('28389', 'Opp Blk 515 & 516', 'Jurong West St 52', 260),
  stop('99999', 'Far Away', 'Nowhere Rd', 5000),
];

const now = Date.now();
// [svc, [[mins, load, monitored], ...]]
const ARR = {
  28091: [['154', [[3, 'SEA'], [21, 'SEA'], [21, 'SEA', 0]]], ['180', [[0, 'LSD'], [12, 'SDA'], [14, 'SEA']]], ['187', [[1, 'SDA'], [9, 'SEA'], [20, 'SEA']]],
          ['240', [[3, 'SEA'], [8, 'SEA'], [15, 'SEA']]], ['246', [[6, 'SEA'], [25, 'SEA'], [32, 'SEA', 0]]], ['49', [[8, 'SEA'], [26, 'SEA'], [38, 'SDA', 0]]],
          ['98', [[10, 'SDA'], [18, 'SEA'], [25, 'SEA']]], ['98M', [[36, 'SEA', 0]]]],
  28099: [['154', [[1, 'SEA'], [7, 'SEA'], [14, 'SEA']]], ['180', [[0, 'SDA'], [5, 'SEA'], [6, 'SEA']]], ['187', [[3, 'SEA'], [12, 'SEA'], [21, 'SEA']]],
          ['240', [[3, 'SDA'], [10, 'SEA'], [25, 'SEA', 0]]], ['246', [[1, 'SEA'], [12, 'SEA'], [22, 'SEA']]], ['49', [[6, 'SEA'], [20, 'SEA'], [25, 'SEA']]],
          ['98', [[3, 'LSD'], [9, 'SDA'], [15, 'SEA']]]],
  28381: [['187', [[5, 'SEA'], [14, 'SEA'], [23, 'SEA']]], ['335', [[7, 'SEA'], [13, 'SEA'], [22, 'SEA', 0]]]],
  28389: [],
};
const bus = (b) => b ? { EstimatedArrival: new Date(now + b[0] * 60000 + 10000).toISOString(), Load: b[1], Monitored: b[2] ?? 1 } : { EstimatedArrival: '', Load: '', Monitored: 0 };
const svcs = (code) => (ARR[code] || []).map(([no, bs]) => ({ ServiceNo: no, NextBus: bus(bs[0]), NextBus2: bus(bs[1]), NextBus3: bus(bs[2]) }));

globalThis.fetch = async (u) => {
  const url = new URL(u);
  if (url.pathname.endsWith('/BusStops')) {
    const skip = Number(url.searchParams.get('$skip'));
    return new Response(JSON.stringify({ value: skip === 0 ? STOPS : [] }));
  }
  const code = url.searchParams.get('BusStopCode');
  return new Response(JSON.stringify({ BusStopCode: code, Services: svcs(code) }));
};

const env = { ACCESS_TOKEN: 'secret', LTA_API_KEY: 'k' };
const call = (qs) => worker.fetch(new Request(`https://x.dev/?${qs}`), env);
const base = `lat=${ME.lat}&lon=${ME.lon}&token=secret`;

assert.equal((await call(`lat=1&lon=2&token=nope`)).status, 401);
assert.equal((await call(`token=secret`)).status, 400);

const text = await (await call(base)).text();
assert.match(text, /^🚏 Lakeside Stn · 28091 · 90m\n49   🟢8 · 🟢26 · 🟡38 min\n98   🟡10/);
assert.match(text, /180   🔴Now · 🟡12 · 🟢14 min/);
assert.match(text, /🚏 Opp Blk 515 & 516 · 28389 · 260m\nNo arrival info/);
assert.ok(!text.includes('Far Away'));

const json = await (await call(base + '&format=json')).json();
assert.deepEqual(json.stops[0].services.map((s) => s.no), ['49', '98', '98M', '154', '180', '187', '240', '246']);
assert.deepEqual(json.stops[0].services.find((s) => s.no === '98M').buses, [{ mins: 36, load: 'seats', live: false }]);

const htmlRes = await call(base + '&format=html');
assert.equal(htmlRes.headers.get('content-type'), 'text/html; charset=utf-8');
const html = await htmlRes.text();
assert.ok(html.includes('Opp Blk 515 &amp; 516') && !html.includes('515 & 516'));
