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
assert.match(html, /<title>BusNearby — live bus arrivals near you, in one tap<\/title>/);
assert.match(html, /Which bus is coming\?/);
assert.match(html, /<b>Launch offer<\/b> — subscribe by 30 Nov 2026/);
assert.match(html, /<div class="was">S\$2\.90<\/div>\s*<div class="price">S\$1\.90 <small>\/ month<\/small>/);
assert.match(html, /<div class="was">S\$29\.90<\/div>\s*<div class="price">S\$18\.90 <small>\/ year<\/small>/);
assert.match(html, /Save 17%/); // 18.90 vs 12 × 1.90
assert.match(html, /href="https:\/\/buy\.stripe\.com\/monthly-launch">Subscribe/);
assert.match(html, /href="https:\/\/buy\.stripe\.com\/yearly-launch">Subscribe/);
assert.match(html, /<form method="post" action="\/free">/);
assert.match(html, /4 checks a day<\/li><li>Valid for 30 days/);
assert.match(html, /href="https:\/\/billing\.stripe\.com\/p\/login\/abc">Manage subscription/);
assert.match(html, /Contains information from LTA DataMall accessed on 7 Oct 2026/);
assert.match(html, /class="row"><span class="svc">49<\/span>/, 'demo cards rendered');
assert.ok(!html.includes('http-equiv="refresh"'));

// Last moment of the offer, then the switch to regular prices and links
clock = Date.parse('2026-11-30T23:59:59+08:00');
assert.match(await (await get('/')).text(), /S\$1\.90/);
clock = Date.parse('2026-12-01T00:00:00+08:00');
html = await (await get('/')).text();
assert.ok(!html.includes('Launch offer') && !html.includes('S$1.90'));
assert.match(html, /<div class="was"><\/div>\s*<div class="price">S\$2\.90 <small>\/ month<\/small>/);
assert.match(html, /Save 14%/); // 29.90 vs 12 × 2.90
assert.match(html, /href="https:\/\/buy\.stripe\.com\/monthly">Subscribe/);
clock = Date.parse('2026-10-07T01:00:00Z');

// Launch link missing → regular link; no link at all → not purchasable yet
html = await (await get('/', { ...env, PAYMENT_LINK_MONTHLY_PROMO: undefined })).text();
assert.match(html, /href="https:\/\/buy\.stripe\.com\/monthly">Subscribe/);
html = await (await get('/', { BUS_STOPS_KV, DB })).text();
assert.equal((html.match(/Coming soon/g) || []).length, 2);
assert.ok(!html.includes('Manage subscription') && !html.includes('mailto:'));

// API behaviour at / is unchanged
assert.equal((await get('/?token=owner')).status, 400, 'token without lat/lon is still an API call');
assert.equal((await get('/', env, { authorization: 'Bearer owner' })).status, 400);
assert.equal((await get('/?lat=1.3442&lon=103.721&token=owner')).status, 200);
assert.equal((await get('/', { ACCESS_TOKEN: 'owner', LTA_API_KEY: 'k' })).status, 401, 'no website without a DB');

// Legal pages
for (const path of ['/privacy', '/terms']) {
  res = await get(path);
  assert.equal(res.status, 200);
  html = await res.text();
  assert.match(html, /mailto:hello@example\.com/);
  assert.match(html, /Last updated 7 Oct 2026/);
}
assert.match(await (await get('/privacy')).text(), /Personal Data Protection Act/);

// --- Free pass ---
res = await signup();
html = await res.text();
assert.equal(res.status, 200);
const token = html.match(/id="token">(sgb_[a-z0-9]{32})</)?.[1];
assert.ok(token);
assert.match(html, /Free pass · Valid until 6 Nov 2026 · 4 checks a day · ref tk_\w+ · <a href="\/#pricing">Upgrade<\/a>/);
assert.match(html, /can’t be shown again/);
assert.match(html, /href="https:\/\/www\.icloud\.com\/shortcuts\/abc">Add the Shortcut/);
const stored = sqlite.prepare('SELECT * FROM tokens WHERE plan = ?').get('free');
assert.equal(stored.daily_limit, 4);
assert.ok(!JSON.stringify(stored).includes('203.0.113.7'), 'IP is not stored');

const bus = (format = '') => get(`/?lat=1.3442&lon=103.721&token=${token}${format}`);
html = await (await bus('&format=html')).text();
assert.ok(!html.includes('http-equiv="refresh"'), 'free passes are not auto-refreshed');
for (let i = 0; i < 3; i++) assert.equal((await bus()).status, 200);
res = await bus();
assert.equal(res.status, 429);
assert.equal(await res.text(), 'Daily limit of 4 requests reached. It resets at midnight (SGT).\nUpgrade: https://x.dev/#pricing');
html = await (await bus('&format=html')).text();
assert.match(html, /<a href="https:\/\/x\.dev\/#pricing">Upgrade<\/a>/);

// Sign-up cap per network per day
assert.equal((await signup()).status, 200);
assert.equal((await signup()).status, 200);
res = await signup();
assert.equal(res.status, 429);
assert.match(await res.text(), /Too many free passes/);
assert.equal((await signup('198.51.100.1')).status, 200, 'other networks unaffected');
clock += DAY;
assert.equal((await signup()).status, 200, 'cap resets the next day');
assert.equal((await get('/free')).status, 401, 'GET /free is not a sign-up');

// Free pass runs out after 30 days and points to pricing
clock = Date.parse('2026-10-07T01:00:00Z') + 30 * DAY;
res = await bus();
assert.equal(res.status, 402);
assert.equal(await res.text(), 'Your pass expired on 6 Nov 2026.\nRenew: https://x.dev/#pricing');
