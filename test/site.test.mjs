// Landing page, pricing (launch offer and after), free passes, legal pages.
// Run with `node --test` (Node 22+, for node:sqlite).
import assert from 'node:assert/strict';
import worker from '../worker/bus-nearest-worker.js';
import { createD1 } from './d1.mjs';

const { DB, sqlite } = createD1();
const DAY = 86400000;
let clock = Date.parse('2026-10-07T01:00:00Z');
Date.now = () => clock;

const kv = new Map([['bus_stops_cache', JSON.stringify([{ BusStopCode: '28091', Description: 'Lakeside Stn', Latitude: 1.3442, Longitude: 103.721 }])]]);
const BUS_STOPS_KV = { get: async (k) => (kv.has(k) ? JSON.parse(kv.get(k)) : null), put: async () => {} };
globalThis.fetch = async () => new Response(JSON.stringify({ Services: [] }));

const env = {
  BUS_STOPS_KV, DB, LTA_API_KEY: 'k', ACCESS_TOKEN: 'owner', ADMIN_SECRET: 'admin',
  PAYMENT_LINK_MONTHLY: 'https://buy.stripe.com/monthly', PAYMENT_LINK_MONTHLY_PROMO: 'https://buy.stripe.com/monthly-launch',
  PAYMENT_LINK_YEARLY: 'https://buy.stripe.com/yearly', PAYMENT_LINK_YEARLY_PROMO: 'https://buy.stripe.com/yearly-launch',
  MANAGE_URL: 'https://billing.stripe.com/p/login/abc', SUPPORT_EMAIL: 'hello@example.com', SHORTCUT_URL: 'https://www.icloud.com/shortcuts/abc',
};
const get = (path, e = env, headers = {}) => worker.fetch(new Request(`https://x.dev${path}`, { headers }), e);
const signup = (ip = '203.0.113.7') => worker.fetch(new Request('https://x.dev/free', { method: 'POST', headers: { 'cf-connecting-ip': ip } }), env);

// --- Landing page during the launch offer ---
let res = await get('/');
let html = await res.text();
assert.equal(res.status, 200);
assert.match(html, /<title>BusBoard — the bus stop display, in your pocket<\/title>/);
assert.match(html, /The bus stop display\.<br>In your pocket\./);
assert.match(html, /<b>Launch prices<\/b> — until 30 Nov 2026/);
assert.match(html, /<div class="was">S\$2\.90<\/div>\s*<div class="price">S\$1\.90 <small>\/ month<\/small>/);
assert.match(html, /<div class="was">S\$29\.90<\/div>\s*<div class="price">S\$18\.90 <small>\/ year<\/small>/);
assert.match(html, /Save 17%/); // 18.90 vs 12 × 1.90
assert.match(html, /href="https:\/\/buy\.stripe\.com\/monthly-launch">Buy with PayNow/);
assert.match(html, /href="https:\/\/buy\.stripe\.com\/yearly-launch">Buy with PayNow/);
assert.match(html, /<a class="pill ghost" href="\/app">Get free pass<\/a>/, 'Get free pass opens the web app');
assert.match(html, /Pay once with PayNow or card<\/li><li>No auto-renewal/);
assert.match(html, /4 checks a day<\/li><li>Built in — no sign-up, no token/);
assert.match(html, /Free is on by default — you don't need a pass to use it\./);
assert.match(html, /<a class="pill" href="\/app">Open BusBoard<\/a>/);
assert.match(html, /<a class="pill small" href="\/app">Try it free/);
assert.match(html, /<nav class="nav">/);
assert.match(html, /Contains information from LTA DataMall accessed on 7 Oct 2026/);
assert.match(html, /class="row"><span class="svc">49<\/span>/, 'demo cards rendered');
assert.ok(!html.includes('http-equiv="refresh"'));

// Last moment of the offer, then the switch to regular prices and links
clock = Date.parse('2026-11-30T23:59:59+08:00');
assert.match(await (await get('/')).text(), /S\$1\.90/);
clock = Date.parse('2026-12-01T00:00:00+08:00');
html = await (await get('/')).text();
assert.ok(!html.includes('Launch prices') && !html.includes('S$1.90'));
assert.match(html, /<div class="was"><\/div>\s*<div class="price">S\$2\.90 <small>\/ month<\/small>/);
assert.match(html, /Save 14%/); // 29.90 vs 12 × 2.90
assert.match(html, /href="https:\/\/buy\.stripe\.com\/monthly">Buy with PayNow/);
clock = Date.parse('2026-10-07T01:00:00Z');

// Launch link missing → regular link; no link at all → not purchasable yet
html = await (await get('/', { ...env, PAYMENT_LINK_MONTHLY_PROMO: undefined })).text();
assert.match(html, /href="https:\/\/buy\.stripe\.com\/monthly">Buy with PayNow/);
html = await (await get('/', { BUS_STOPS_KV, DB })).text();
assert.equal((html.match(/Coming soon/g) || []).length, 2);
assert.ok(!html.includes('action="/free"'), 'no token sign-up form: free is built in');
assert.ok(!html.includes('mailto:'));

// API behaviour at / is unchanged
assert.equal((await get('/?token=owner')).status, 400, 'token without lat/lon is still an API call');
assert.equal((await get('/', env, { authorization: 'Bearer owner' })).status, 400);
assert.equal((await get('/?lat=1.3442&lon=103.721&token=owner')).status, 200);
assert.equal((await get('/', { ACCESS_TOKEN: 'owner', LTA_API_KEY: 'k' })).status, 401, 'no website without a DB');

// Legal pages
for (const path of ['/privacy', '/terms', '/install']) {
  res = await get(path);
  assert.equal(res.status, 200);
  html = await res.text();
  assert.match(html, /mailto:hello@example\.com/);
  if (path !== '/install') assert.match(html, /Last updated 8 Oct 2026/);
}
assert.match(await (await get('/privacy')).text(), /Personal Data Protection Act/);
html = await (await get('/install')).text();
assert.match(html, /<a class="pill" href="\/app">Open BusBoard<\/a>/);
assert.match(html, /<a class="pill" href="https:\/\/www\.icloud\.com\/shortcuts\/abc">Add the BusBoard Shortcut<\/a>/);
assert.match(html, /On Android[\s\S]*Install app/);
assert.match(html, /leave it empty for the free plan<\/b>, or paste your token/);

// --- Free pass ---
res = await signup();
html = await res.text();
assert.equal(res.status, 200);
const token = html.match(/id="token">(sgb_[a-z0-9]{32})</)?.[1];
assert.ok(token);
const ref = html.match(/ref (tk_[a-z0-9]+)/)[1];
assert.match(html, new RegExp(`Free pass · Valid until 6 Nov 2026 · 4 checks a day · ref ${ref} · <a href="/renew\\?ref=${ref}">Upgrade</a>`));
assert.match(html, new RegExp(`<a href="/app#token=${token}">open BusBoard with this token</a>`));
assert.match(html, /can’t be shown again/);
assert.match(html, /location\.href = &quot;https:\/\/www\.icloud\.com\/shortcuts\/abc&quot;[^>]*>Copy token &amp; open the Shortcut</);
const stored = sqlite.prepare('SELECT * FROM tokens WHERE plan = ?').get('free');
assert.equal(stored.daily_limit, 4);
assert.ok(!JSON.stringify(stored).includes('203.0.113.7'), 'IP is not stored');

const bus = (format = '') => get(`/?lat=1.3442&lon=103.721&token=${token}${format}`);
html = await (await bus('&format=html')).text();
assert.ok(!html.includes('http-equiv="refresh"'), 'free passes are not auto-refreshed');
for (let i = 0; i < 3; i++) assert.equal((await bus()).status, 200);
res = await bus();
assert.equal(res.status, 429);
assert.equal(await res.text(), `Daily limit of 4 requests reached. It resets at midnight (SGT).\nUpgrade: https://x.dev/renew?ref=${ref}`);
html = await (await bus('&format=html')).text();
assert.match(html, new RegExp(`<a href="https://x\\.dev/renew\\?ref=${ref}">Upgrade</a>`));

// The top-up page: the paid plans, each Payment Link tagged with the pass, so paying extends it
html = await (await get(`/renew?ref=${ref}`)).text();
assert.match(html, /Top up your pass\./);
assert.match(html, new RegExp(`href="https://buy\\.stripe\\.com/monthly-launch\\?client_reference_id=${ref}">Top up with PayNow`));
assert.match(html, new RegExp(`href="https://buy\\.stripe\\.com/yearly-launch\\?client_reference_id=${ref}">Top up with PayNow`));
for (const bad of ['', '?ref=', '?ref=tk_<x>', '?ref=sgb_secret']) {
  res = await get(`/renew${bad}`);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://x.dev/#pricing');
}

// Sign-up cap per network per day
assert.equal((await signup()).status, 200);
assert.equal((await signup()).status, 200);
res = await signup();
assert.equal(res.status, 429);
assert.match(await res.text(), /You don't need a pass\.<\/h1>[\s\S]*4 checks a day, no token required/);
assert.equal((await signup('198.51.100.1')).status, 200, 'other networks unaffected');
clock += DAY;
assert.equal((await signup()).status, 200, 'cap resets the next day');
assert.equal((await get('/free')).status, 401, 'GET /free is not a sign-up');

// Free pass runs out after 30 days and points to pricing
clock = Date.parse('2026-10-07T01:00:00Z') + 30 * DAY;
res = await bus();
assert.equal(res.status, 402);
assert.equal(await res.text(), `Your pass expired on 6 Nov 2026.\nRenew: https://x.dev/renew?ref=${ref}`);

// --- Built-in free tier: no token, counted per device ---
clock = Date.parse('2026-10-08T01:00:00Z');
const anon = (device, format = '') =>
  get(`/?lat=1.3442&lon=103.721${device === undefined ? '' : `&device=${encodeURIComponent(device)}`}${format}`);
const phone = "Arthas's iPhone|iPhone17,1|26.0|402";
for (let i = 1; i <= 4; i++) {
  res = await anon(phone, '&format=json');
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()).pass, { plan: 'free', expiresAt: null, dailyLimit: 4, usedToday: i });
}
html = await (await anon('Other|iPhone16,2|26.0|430', '&format=html')).text();
assert.ok(!html.includes('http-equiv="refresh"'), 'free tier is not auto-refreshed');
res = await anon(phone);
assert.equal(res.status, 429);
assert.equal(await res.text(), "You've used today's 4 free checks. They reset at midnight (SGT).\nUpgrade: https://x.dev/#pricing");
assert.ok(!JSON.stringify(sqlite.prepare('SELECT * FROM anonymous_usage').all()).includes('iPhone'), 'device details not stored');
clock = Date.parse('2026-10-08T16:01:00Z'); // just past midnight SGT
assert.equal((await anon(phone)).status, 200, 'resets at midnight SGT');
assert.equal((await anon(undefined)).status, 401, 'no token and no device');
// The web app sends its device ID (and any token) as headers, with an empty Bearer meaning none
res = await get('/?lat=1.3442&lon=103.721&format=json', env, { 'x-device': 'app:1234', authorization: 'Bearer ' });
assert.equal(res.status, 200);
assert.equal((await res.json()).pass.usedToday, 1);
assert.equal((await get('/?lat=1.3442&lon=103.721', env, { 'x-device': 'app:1234', authorization: 'Bearer' })).status, 200);
assert.equal((await anon('   ')).status, 401);
assert.equal((await anon('x'.repeat(301))).status, 400);
assert.equal((await get('/?lat=1.3442&lon=103.721&device=x', { ACCESS_TOKEN: 'owner', LTA_API_KEY: 'k' })).status, 401, 'free tier needs the DB');
