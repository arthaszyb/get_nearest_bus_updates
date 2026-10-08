// Home Screen web app: shell page, manifest, icons, and that its script parses.
import assert from 'node:assert/strict';
import worker from '../worker/bus-nearest-worker.js';
import { createD1 } from './d1.mjs';

const { DB } = createD1();
const env = { DB, BUS_STOPS_KV: { get: async () => null, put: async () => {} }, LTA_API_KEY: 'k', ADMIN_SECRET: 'admin' };
const get = (path, e = env) => worker.fetch(new Request(`https://x.dev${path}`), e);

let res = await get('/app');
assert.equal(res.status, 200);
let html = await res.text();
assert.match(html, /<link rel="manifest" href="\/app\.webmanifest">/);
assert.match(html, /<link rel="apple-touch-icon" href="\/app-icon-180\.png">/);
assert.match(html, /<meta name="apple-mobile-web-app-capable" content="yes">/);
assert.match(html, /4 checks a day/);
const script = html.match(/<script>([\s\S]*)<\/script>/)[1];
assert.doesNotThrow(() => new Function(script), 'app script is valid JavaScript');
assert.match(script, /'app:' \+ crypto\.randomUUID\(\)/);
assert.match(script, /Couldn\\'t reach BusBoard/);
assert.match(script, /'x-device': device/, 'device ID goes in a header');
assert.match(script, /headers\.authorization = 'Bearer ' \+ token/, 'token goes in a header');
assert.ok(!/q\.set\('token'/.test(script) && !/device \}\)/.test(script), 'neither is put in the URL');
assert.match(script, /beforeinstallprompt/);
assert.match(script, /serviceWorker\.register\('\/sw\.js', \{ scope: '\/app' \}\)/);
assert.match(script, /location\.hash/, 'takes a token handed over from the pass page');

res = await get('/app.webmanifest');
const manifest = await res.json();
assert.equal(manifest.display, 'standalone');
assert.equal(manifest.start_url, '/app');
assert.equal(manifest.icons.length, 2);

for (const size of [180, 512]) {
  res = await get(`/app-icon-${size}.png`);
  assert.equal(res.headers.get('content-type'), 'image/png');
  const png = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...png.slice(1, 4)].map((c) => String.fromCharCode(c)).join(''), 'PNG');
  assert.equal(new DataView(png.buffer).getUint32(16), size, `icon is ${size}px wide`);
}

res = await get('/sw.js');
assert.match(res.headers.get('content-type'), /javascript/);
const sw = await res.text();
assert.doesNotThrow(() => new Function(sw));
assert.match(sw, /addEventListener\('fetch'/, 'Chrome needs a fetch handler to offer installing');

// The per-request log line never carries the location, token or device
const lines = [];
const realLog = console.log;
console.log = (line) => lines.push(line);
const kv = new Map([['bus_stops_cache', JSON.stringify([{ BusStopCode: '28091', Description: 'Lakeside Stn', Latitude: 1.3442, Longitude: 103.721 }])]]);
const withStops = { ...env, BUS_STOPS_KV: { get: async (k) => (kv.has(k) ? JSON.parse(kv.get(k)) : null), put: async () => {} } };
globalThis.fetch = async () => new Response(JSON.stringify({ Services: [] }));
await worker.fetch(new Request('https://x.dev/?lat=1.344211&lon=103.721987&format=html&device=Secret%20iPhone&token=sgb_secret'), withStops);
await worker.fetch(new Request('https://x.dev/?lat=1.344211&lon=103.721987', { headers: { 'x-device': 'app:abc' } }), withStops);
console.log = realLog;
assert.equal(lines.length, 2);
for (const line of lines) {
  const entry = JSON.parse(line);
  assert.equal(entry.path, '/');
  assert.ok(!/1\.3442|103\.72|Secret|sgb_|app:abc/.test(line), `log line leaks nothing: ${line}`);
}
assert.equal(JSON.parse(lines[0]).access, 'denied');
assert.deepEqual([JSON.parse(lines[1]).access, JSON.parse(lines[1]).stops], ['device', '28091']);

// Without a DB (plain API deployment) there is no website, so no app either.
res = await get('/app', { ...env, DB: undefined });
assert.notEqual(res.status, 200);
console.log('ok app');
