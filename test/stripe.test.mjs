// Stripe webhook → token issuance, welcome page, subscription renewals and cancellations.
// Run with `node --test` (Node 22+, for node:sqlite).
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import worker from '../worker/bus-nearest-worker.js';
import { createD1 } from './d1.mjs';

const { DB, sqlite } = createD1();
const DAY = 86400000;
let clock = Date.parse('2026-10-07T01:00:00Z');
Date.now = () => clock;

const kv = new Map([['bus_stops_cache', JSON.stringify([{ BusStopCode: '28091', Description: 'Lakeside Stn', Latitude: 1.3442, Longitude: 103.721 }])]]);
const BUS_STOPS_KV = { get: async (k) => (kv.has(k) ? JSON.parse(kv.get(k)) : null), put: async (k, v) => void kv.set(k, v) };
globalThis.fetch = async () => new Response(JSON.stringify({ Services: [] }));

const SECRET = 'whsec_test_secret';
const env = {
  BUS_STOPS_KV, DB, LTA_API_KEY: 'k', ACCESS_TOKEN: 'owner', ADMIN_SECRET: 'admin',
  STRIPE_WEBHOOK_SECRET: SECRET, SHORTCUT_URL: 'https://www.icloud.com/shortcuts/abc',
};

const sign = (body, t = Math.floor(clock / 1000), secret = SECRET) =>
  `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${body}`).digest('hex')}`;
const deliver = (event, { signature, e = env } = {}) => {
  const body = JSON.stringify(event);
  return worker.fetch(new Request('https://x.dev/stripe/webhook', {
    method: 'POST', body, headers: { 'stripe-signature': signature ?? sign(body), 'content-type': 'application/json' },
  }), e);
};
const event = (type, object, livemode = true) => ({ id: `evt_${Math.random()}`, type, livemode, data: { object } });
const checkout = (id, extra = {}) => ({
  id, object: 'checkout.session', mode: 'payment', payment_status: 'paid',
  customer_details: { email: 'buyer@example.com' }, metadata: { plan: 'yearly' }, subscription: null, ...extra,
});
const welcome = (sessionId) => worker.fetch(new Request(`https://x.dev/welcome?session_id=${sessionId}`), env);
const tokenFromWelcome = async (sessionId) => (await (await welcome(sessionId)).text()).match(/id="token">(sgb_[a-z0-9]{32})</)?.[1];
const busStatus = async (token) => (await worker.fetch(new Request(`https://x.dev/?lat=1.3442&lon=103.721&token=${token}`), env)).status;
const rowFor = (sessionId) => sqlite.prepare('SELECT * FROM tokens WHERE stripe_checkout_session = ?').get(sessionId);
const count = () => sqlite.prepare('SELECT COUNT(*) AS n FROM tokens').get().n;

// --- Signature checks ---
assert.equal((await deliver(event('checkout.session.completed', checkout('cs_live_x')), { e: { ...env, STRIPE_WEBHOOK_SECRET: undefined } })).status, 404);
const sample = JSON.stringify(event('ping', {}));
for (const signature of [
  '',                                                          // missing
  sign(sample, undefined, 'whsec_wrong'),                      // wrong secret
  sign(sample, Math.floor(clock / 1000) - 301),                // too old (replay)
  `t=${Math.floor(clock / 1000)},v1=${'0'.repeat(64)}`,        // bogus signature
]) {
  const res = await worker.fetch(new Request('https://x.dev/stripe/webhook', { method: 'POST', body: sample, headers: { 'stripe-signature': signature } }), env);
  assert.equal(res.status, 400);
}
// Body tampered after signing
let res = await worker.fetch(new Request('https://x.dev/stripe/webhook', { method: 'POST', body: sample + ' ', headers: { 'stripe-signature': sign(sample) } }), env);
assert.equal(res.status, 400);
// While a secret is being rolled Stripe sends two v1 signatures; either may be the valid one
const t = Math.floor(clock / 1000);
res = await worker.fetch(new Request('https://x.dev/stripe/webhook', {
  method: 'POST', body: sample,
  headers: { 'stripe-signature': `t=${t},v1=${createHmac('sha256', 'whsec_old').update(`${t}.${sample}`).digest('hex')},v1=${sign(sample).split('v1=')[1]}` },
}), env);
assert.equal(res.status, 200, 'unhandled event types are acknowledged');
assert.equal((await deliver(event('ping', {}), { e: { ...env, DB: undefined } })).status, 501);

// --- One-time purchase ---
// Customer can land on the welcome page before the webhook arrives
res = await welcome('cs_live_one');
let html = await res.text();
assert.equal(res.status, 200);
assert.match(html, /setting up your pass/);
assert.match(html, /http-equiv="refresh" content="3"/);

assert.equal((await deliver(event('checkout.session.completed', checkout('cs_live_one')))).status, 200);
let row = rowFor('cs_live_one');
assert.equal(row.plan, 'yearly');
assert.equal(row.customer, 'buyer@example.com');
assert.equal(row.expires_at, clock + 366 * DAY);
assert.equal(row.daily_limit, 300);
assert.equal(row.note, null);
assert.equal(row.stripe_subscription, null);

res = await welcome('cs_live_one');
html = await res.text();
const token = html.match(/id="token">(sgb_[a-z0-9]{32})</)?.[1];
assert.ok(token, 'welcome page shows the token');
assert.ok(!html.includes('http-equiv="refresh"'));
assert.match(html, /<meta name="referrer" content="no-referrer">/);
assert.match(html, /<a href="https:\/\/www\.icloud\.com\/shortcuts\/abc">Add the Shortcut<\/a>/);
assert.match(html, /Yearly pass · Valid until 8 Oct 2027 · 300 checks a day · ref tk_/);
assert.equal(await busStatus(token), 200, 'issued token works');
assert.equal(await tokenFromWelcome('cs_live_one'), token, 'revisiting shows the same token');

// Stripe redelivers: still one token, same token
const before = count();
assert.equal((await deliver(event('checkout.session.completed', checkout('cs_live_one')))).status, 200);
assert.equal(count(), before);
assert.equal(await tokenFromWelcome('cs_live_one'), token);

assert.equal((await welcome('not_a_session')).status, 404);
assert.equal((await welcome('cs_live_<script>')).status, 404);

// Without a valid plan in metadata: refuse loudly, issue nothing
res = await deliver(event('checkout.session.completed', checkout('cs_live_noplan', { metadata: {} })));
assert.equal(res.status, 400);
assert.match(await res.text(), /cs_live_noplan: invalid metadata — plan must be one of/);
res = await deliver(event('checkout.session.completed', checkout('cs_live_proto', { metadata: { plan: 'constructor', days: '5' } })));
assert.equal(res.status, 400);
res = await deliver(event('checkout.session.completed', checkout('cs_live_baddays', { metadata: { plan: 'monthly', days: 'abc' } })));
assert.equal(res.status, 400);
assert.equal(rowFor('cs_live_noplan') ?? rowFor('cs_live_proto') ?? rowFor('cs_live_baddays'), undefined);

// Metadata can override length and limit (e.g. a 3-month pass)
await deliver(event('checkout.session.completed', checkout('cs_live_quarter', { metadata: { plan: 'monthly', days: '92', daily_limit: '500' } })));
row = rowFor('cs_live_quarter');
assert.equal(row.expires_at, clock + 92 * DAY);
assert.equal(row.daily_limit, 500);

// Delayed payment method: nothing until the money arrives
await deliver(event('checkout.session.completed', checkout('cs_live_async', { payment_status: 'unpaid' })));
assert.equal(rowFor('cs_live_async'), undefined);
await deliver(event('checkout.session.async_payment_succeeded', checkout('cs_live_async', { payment_status: 'paid' })));
assert.ok(rowFor('cs_live_async'));

// Admin rotates a Stripe-issued token: welcome page stops showing the old one
const rotated = await (await worker.fetch(new Request(`https://x.dev/admin/tokens/${rowFor('cs_live_one').id}/rotate`, {
  method: 'POST', headers: { authorization: 'Bearer admin' },
}), env)).json();
html = await (await welcome('cs_live_one')).text();
assert.ok(!html.includes(token));
assert.match(html, /can no longer show your token/);
assert.equal(await busStatus(token), 401);
assert.equal(await busStatus(rotated.token), 200);

// --- Subscription ---
const start = clock;
const subCheckout = checkout('cs_test_sub', { mode: 'subscription', subscription: 'sub_1', metadata: { plan: 'monthly' } });
await deliver(event('checkout.session.completed', subCheckout, false));
row = rowFor('cs_test_sub');
assert.equal(row.stripe_subscription, 'sub_1');
assert.equal(row.note, 'Stripe test mode');
assert.equal(row.expires_at, start + 31 * DAY);
const subToken = await tokenFromWelcome('cs_test_sub');
assert.match(await (await welcome('cs_test_sub')).text(), /Monthly pass · Renews automatically · paid until 7 Nov 2026 · 300 checks a day/);

const periodEnd = (ms) => Math.floor(ms / 1000);
// First invoice (newer API shape): exact period end + grace, never shortening
const invoiceNew = (sub, end) => ({ object: 'invoice', parent: { type: 'subscription_details', subscription_details: { subscription: sub } }, lines: { data: [{ period: { start: periodEnd(clock), end: periodEnd(end) } }] } });
const invoiceOld = (sub, end) => ({ object: 'invoice', subscription: sub, lines: { data: [{ period: { start: periodEnd(clock), end: periodEnd(end) } }] } });
await deliver(event('invoice.paid', invoiceNew('sub_1', start + 30 * DAY)));
assert.equal(rowFor('cs_test_sub').expires_at, start + 32 * DAY);

// Renewal a month later (older API shape)
clock = start + 30 * DAY + 3600000;
await deliver(event('invoice.paid', invoiceOld('sub_1', start + 61 * DAY)));
assert.equal(rowFor('cs_test_sub').expires_at, start + 63 * DAY);
// A late redelivery of the first invoice doesn't pull the expiry back
await deliver(event('invoice.paid', invoiceNew('sub_1', start + 30 * DAY)));
assert.equal(rowFor('cs_test_sub').expires_at, start + 63 * DAY);
assert.equal(await busStatus(subToken), 200);

// Renewal payment fails: access runs out after the grace period
clock = start + 62 * DAY;
assert.equal(await busStatus(subToken), 200, 'still inside grace');
clock = start + 63 * DAY;
assert.equal(await busStatus(subToken), 402);

// Cancelled at period end: access ends when the subscription does
clock = start + 70 * DAY;
await deliver(event('invoice.paid', invoiceOld('sub_1', start + 100 * DAY)));
assert.equal(await busStatus(subToken), 200, 'paying again revives the same token');
clock = start + 100 * DAY;
await deliver(event('customer.subscription.deleted', { object: 'subscription', id: 'sub_1', ended_at: periodEnd(clock), canceled_at: periodEnd(start + 80 * DAY) }));
assert.equal(rowFor('cs_test_sub').expires_at, Math.floor(clock / 1000) * 1000);
assert.equal(await busStatus(subToken), 402);

// Invoice arriving before its checkout event, then immediate cancellation
await deliver(event('invoice.paid', invoiceNew('sub_2', clock + 30 * DAY)));
await deliver(event('checkout.session.completed', checkout('cs_live_sub2', { mode: 'subscription', subscription: 'sub_2', metadata: { plan: 'monthly' } })));
const sub2Token = await tokenFromWelcome('cs_live_sub2');
assert.equal(await busStatus(sub2Token), 200);
clock += DAY;
await deliver(event('customer.subscription.deleted', { object: 'subscription', id: 'sub_2', ended_at: periodEnd(clock), canceled_at: periodEnd(clock) }));
assert.equal(await busStatus(sub2Token), 402);

// Events for subscriptions we don't know are acknowledged and ignored
assert.equal((await deliver(event('invoice.paid', invoiceNew('sub_unknown', clock + DAY)))).status, 200);
assert.equal((await deliver(event('customer.subscription.deleted', { id: 'sub_unknown', ended_at: periodEnd(clock) }))).status, 200);
