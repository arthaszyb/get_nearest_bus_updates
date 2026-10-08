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
assert.match(script, /Couldn\\'t reach BusNearby/);

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

// Without a DB (plain API deployment) there is no website, so no app either.
res = await get('/app', { ...env, DB: undefined });
assert.notEqual(res.status, 200);
console.log('ok app');
