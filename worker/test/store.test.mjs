// End-to-end tests of the Worker with real SQLite, an in-memory R2 and fake
// Stripe/Steam servers. Run: node --test worker/test/
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createD1, createR2 } from './harness.mjs';
import worker, { route } from '../src/index.js';
import { hmacHex } from '../src/util.js';

const ORIGIN = 'https://globalvisions.it';
const API = 'https://api.test';
const STEAM_ID = '76561198000000001';

const env = {
  PUBLIC_ORIGIN: ORIGIN,
  STORE_API_ORIGIN: API,
  SESSION_SECRET: 's'.repeat(40),
  DOWNLOAD_SECRET: 'd'.repeat(40),
  LICENCE_TOKEN_SECRET: 'l'.repeat(40),
  FINGERPRINT_SECRET: 'f'.repeat(40),
  KEY_PEPPER: 'k'.repeat(40),
  STRIPE_SECRET_KEY: 'sk_test_x',
  STRIPE_WEBHOOK_SECRET: 'whsec_test',
  ADMIN_TOKEN: 'a'.repeat(40),
  SERVER_KEYS: 'v'.repeat(40),
  DB: createD1(),
  TRACKS: createR2(),
};

// ---------- fake outside world ----------
const stripeSessions = new Map();
const stripeCalls = [];
let steamSaysValid = true;
async function fakeFetch(url, init = {}) {
  url = String(url);
  if (url === 'https://steamcommunity.com/openid/login') {
    return new Response(`ns:http://specs.openid.net/auth/2.0\nis_valid:${steamSaysValid}\n`);
  }
  if (url === 'https://api.stripe.com/v1/checkout/sessions' && init.method === 'POST') {
    const params = new URLSearchParams(init.body);
    stripeCalls.push(params);
    const id = `cs_test_${stripeCalls.length}abcdefgh`;
    return Response.json({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
  }
  const m = url.match(/^https:\/\/api\.stripe\.com\/v1\/checkout\/sessions\/([^?]+)\?/);
  if (m && init.method === 'GET') {
    const s = stripeSessions.get(decodeURIComponent(m[1]));
    return s ? Response.json(s) : Response.json({ error: { message: 'No such session' } }, { status: 404 });
  }
  throw new Error(`unexpected fetch ${url}`);
}
const deps = { fetch: fakeFetch, sendEmail: false };
globalThis.fetch = fakeFetch; // stripe.js / auth.js default to global fetch inside route()

async function call(method, path, { body, cookie, origin = ORIGIN, headers = {} } = {}) {
  const h = new Headers(headers);
  if (cookie) h.set('cookie', cookie);
  if (origin && method !== 'GET') h.set('origin', origin);
  if (body !== undefined) h.set('content-type', 'application/json');
  const req = new Request(`${API}${path}`, { method, headers: h, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
  return worker.fetch(req, env, {});
}
const jsonOf = async (res) => res.json();
const cookieFrom = (res, name) => {
  const all = res.headers.getSetCookie ? res.headers.getSetCookie() : [res.headers.get('set-cookie')];
  const c = all.find((x) => x && x.startsWith(`${name}=`));
  return c ? c.split(';')[0] : null;
};

async function signedWebhook(event, secret = env.STRIPE_WEBHOOK_SECRET) {
  const payload = JSON.stringify(event);
  const t = Math.floor(Date.now() / 1000);
  const sig = await hmacHex(secret, `${t}.${payload}`);
  return call('POST', '/stripe/webhook', { body: payload, origin: null, headers: { 'stripe-signature': `t=${t},v1=${sig}` } });
}

function paidSession(id, { trackId = 'example-circuit', type = 'personal', steamId = STEAM_ID, price = 'price_personal', pi = `pi_${id}` } = {}) {
  stripeSessions.set(id, {
    id, mode: 'payment', payment_status: 'paid', payment_intent: pi, amount_total: 1999, currency: 'eur', locale: 'en',
    metadata: { track_id: trackId, type, steam_id: type === 'personal' ? steamId : '' },
    customer_details: { email: 'buyer@example.com' },
    line_items: { data: [{ quantity: 1, price: { id: price, product: 'prod_track' } }] },
  });
}

// ---------- fixtures ----------
const work = mkdtempSync(join(tmpdir(), 'gvstore-'));
const srcZip = join(work, 'track.zip');
execFileSync('python3', ['-I', '-c', `
import zipfile, sys, os
with zipfile.ZipFile(sys.argv[1], 'w', zipfile.ZIP_DEFLATED) as z:
    z.writestr('content/tracks/gv_example/models.ini', '[MODEL_0]\\nFILE=example.kn5\\n')
    z.writestr('content/tracks/gv_example/example.kn5', os.urandom(300000))
    z.writestr('content/tracks/gv_example/ui/ui_track.json', '{"name":"Example"}')
`, srcZip]);
await env.TRACKS.put('tracks/example-circuit/1.0.0.zip', readFileSync(srcZip));
await env.DB.prepare(`INSERT INTO tracks (track_id, name, folder, r2_key, version, active) VALUES ('example-circuit', 'Example Circuit', 'gv_example', 'tracks/example-circuit/1.0.0.zip', '1.0.0', 1)`).run();
await env.DB.prepare(`INSERT INTO catalog VALUES ('example-circuit', 'personal', 'prod_track', 'price_personal', 2, 1)`).run();
await env.DB.prepare(`INSERT INTO catalog VALUES ('example-circuit', 'commercial', 'prod_track', 'price_commercial', 10, 1)`).run();

let session; // Steam session cookie
let licenceId;

test('Steam sign in: happy path, state and nonce protection', async () => {
  const start = await call('GET', '/auth/steam/login?next=/store/example-circuit/&lang=en');
  assert.equal(start.status, 302);
  const loc = new URL(start.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, 'https://steamcommunity.com/openid/login');
  const returnTo = loc.searchParams.get('openid.return_to');
  assert.ok(returnTo.startsWith(`${ORIGIN}/api/store/auth/steam/callback?state=`));
  const state = cookieFrom(start, 'gv_state');
  const stateParam = new URL(returnTo).searchParams.get('state');

  const nonce = `${new Date().toISOString().slice(0, 19)}Zabc123`;
  const params = new URLSearchParams({
    state: stateParam,
    'openid.ns': 'http://specs.openid.net/auth/2.0', 'openid.mode': 'id_res',
    'openid.op_endpoint': 'https://steamcommunity.com/openid/login',
    'openid.claimed_id': `https://steamcommunity.com/openid/id/${STEAM_ID}`,
    'openid.identity': `https://steamcommunity.com/openid/id/${STEAM_ID}`,
    'openid.return_to': returnTo, 'openid.response_nonce': nonce, 'openid.assoc_handle': '1234567890',
    'openid.signed': 'signed,op_endpoint,claimed_id,identity,return_to,response_nonce,assoc_handle', 'openid.sig': 'x',
  });
  const cb = await route(new Request(`${API}/auth/steam/callback?${params}`, { headers: { cookie: state } }), env, deps);
  assert.equal(cb.status, 302);
  assert.equal(cb.headers.get('location'), '/store/example-circuit/');
  session = cookieFrom(cb, 'gv_session');
  assert.ok(session);

  const replay = await route(new Request(`${API}/auth/steam/callback?${params}`, { headers: { cookie: state } }), env, deps);
  assert.match(replay.headers.get('location'), /login_error=nonce_reuse/);

  const noState = await route(new Request(`${API}/auth/steam/callback?${params}`), env, deps);
  assert.match(noState.headers.get('location'), /login_error=state/);

  steamSaysValid = false;
  params.set('openid.response_nonce', `${new Date().toISOString().slice(0, 19)}Zother`);
  const forged = await route(new Request(`${API}/auth/steam/callback?${params}`, { headers: { cookie: state } }), env, deps);
  assert.match(forged.headers.get('location'), /login_error=not_verified/);
  steamSaysValid = true;

  const me = await jsonOf(await call('GET', '/me', { cookie: session }));
  assert.deepEqual([me.signed_in, me.kind, me.steam_id], [true, 'steam', STEAM_ID]);
  const bad = await jsonOf(await call('GET', '/me', { cookie: session.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')) }));
  assert.equal(bad.signed_in, false);
});

test('Checkout: login, origin and server-side price', async () => {
  const anon = await call('POST', '/checkout', { body: { track_id: 'example-circuit', type: 'personal' } });
  assert.equal((await jsonOf(anon)).error, 'login_required');
  const noOrigin = await call('POST', '/checkout', { cookie: session, origin: 'https://evil.example', body: { track_id: 'example-circuit', type: 'personal' } });
  assert.equal((await jsonOf(noOrigin)).error, 'bad_origin');
  const ok = await jsonOf(await call('POST', '/checkout', { cookie: session, body: { track_id: 'example-circuit', type: 'personal', lang: 'it', price: 'price_cheap' } }));
  assert.ok(ok.url.startsWith('https://checkout.stripe.com/'));
  const p = stripeCalls.at(-1);
  assert.equal(p.get('line_items[0][price]'), 'price_personal');
  assert.equal(p.get('metadata[steam_id]'), STEAM_ID);
  assert.equal(p.get('automatic_tax[enabled]'), 'true');
  assert.equal(p.get('consent_collection[terms_of_service]'), 'required');
  assert.equal(p.get('success_url'), `${ORIGIN}/it/store/account/?session_id={CHECKOUT_SESSION_ID}`);
  const unknown = await jsonOf(await call('POST', '/checkout', { cookie: session, body: { track_id: 'nope', type: 'personal' } }));
  assert.equal(unknown.error, 'track_unavailable');
});

test('Webhook: signature, price check, idempotency', async () => {
  paidSession('cs_test_personal_1');
  const forged = await signedWebhook({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_personal_1' } } }, 'whsec_wrong');
  assert.equal(forged.status, 400);

  stripeSessions.set('cs_test_tampered', { ...structuredClone(stripeSessions.get('cs_test_personal_1')), id: 'cs_test_tampered', line_items: { data: [{ quantity: 1, price: { id: 'price_cheap' } }] } });
  const tampered = await jsonOf(await signedWebhook({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_tampered' } } }));
  assert.equal(tampered.result, 'price_mismatch');

  const first = await jsonOf(await signedWebhook({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_personal_1' } } }));
  assert.equal(first.result, 'granted');
  const again = await jsonOf(await signedWebhook({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_personal_1' } } }));
  assert.equal(again.result, 'already_granted');

  const list = await jsonOf(await call('GET', '/licences', { cookie: session }));
  assert.equal(list.licences.length, 1);
  licenceId = list.licences[0].id;
  assert.equal(list.licences[0].status, 'active');
  assert.equal(list.licences[0].max_machines, 2);

  const result = await jsonOf(await call('GET', '/checkout/result?session_id=cs_test_personal_1', { cookie: session }));
  assert.deepEqual([result.status, result.licence_id], ['ready', licenceId]);
});

test('Download: fingerprinted zip is valid and traceable', async () => {
  const d = await jsonOf(await call('POST', '/downloads', { cookie: session, body: { licence_id: licenceId } }));
  assert.ok(d.url.startsWith(`${API}/dl/`));
  const res = await call('GET', new URL(d.url).pathname);
  assert.equal(res.status, 200);
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.equal(Number(res.headers.get('content-length')), bytes.length);
  const out = join(work, 'download.zip');
  writeFileSync(out, bytes);
  const report = JSON.parse(execFileSync('python3', ['-I', '-c', `
import zipfile, sys, json
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
ini = z.read('content/tracks/gv_example/extension/gv_licence.ini').decode()
print(json.dumps({'bad': bad, 'names': z.namelist(), 'ini': ini, 'kn5': len(z.read('content/tracks/gv_example/example.kn5'))}))
`, out]).toString());
  assert.equal(report.bad, null);
  assert.equal(report.kn5, 300000);
  assert.equal(report.names.length, 4);
  assert.match(report.ini, new RegExp(`LICENCE_ID=${licenceId}`));
  assert.match(report.ini, new RegExp(`COPY_ID=${d.copy_id}`));

  const trace = await jsonOf(await call('GET', `/admin/copies/${d.copy_id}`, { headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` } }));
  assert.equal(trace.steam_id, STEAM_ID);

  const stranger = await jsonOf(await call('POST', '/downloads', { cookie: null, body: { licence_id: licenceId } }));
  assert.equal(stranger.error, 'login_required');
  const expired = await call('GET', '/dl/garbage.token');
  assert.equal(expired.status, 403);
});

test('Licence API: activation, machine limit, simultaneous use, release', async () => {
  const A = 'A'.repeat(40);
  const B = 'B'.repeat(40);
  const C = 'C'.repeat(40);
  const a = await jsonOf(await call('POST', '/activate', { origin: null, body: { track_id: 'example-circuit', licence_id: licenceId, machine_hash: A } }));
  assert.equal(a.ok, true);
  assert.equal((await jsonOf(await call('POST', '/validate', { origin: null, body: { token: a.token } }))).ok, true);
  const b = await jsonOf(await call('POST', '/activate', { origin: null, body: { track_id: 'example-circuit', steam_id: STEAM_ID, machine_hash: B } }));
  assert.equal(b.ok, true);
  const c = await jsonOf(await call('POST', '/activate', { origin: null, body: { track_id: 'example-circuit', licence_id: licenceId, machine_hash: C } }));
  assert.equal(c.reason, 'machine_limit');
  const unknown = await jsonOf(await call('POST', '/validate', { origin: null, body: { track_id: 'example-circuit', steam_id: STEAM_ID, machine_hash: C } }));
  assert.equal(unknown.reason, 'unknown_machine');
  const other = await jsonOf(await call('POST', '/activate', { origin: null, body: { track_id: 'example-circuit', steam_id: '76561198000000099', machine_hash: C } }));
  assert.equal(other.reason, 'no_licence');

  // Simultaneous use: with the limit at 1, a second machine in use is refused.
  await env.DB.prepare('UPDATE licences SET max_machines = 1 WHERE id = ?1').bind(licenceId).run();
  const busy = await jsonOf(await call('POST', '/validate', { origin: null, body: { token: a.token } }));
  assert.equal(busy.reason, 'too_many_active');
  await env.DB.prepare('UPDATE licences SET max_machines = 2 WHERE id = ?1').bind(licenceId).run();

  // The buyer frees machine B from the account page, then C fits; a second release waits a week.
  const list = await jsonOf(await call('GET', '/licences', { cookie: session }));
  const machineB = list.licences[0].machines.find((m) => m.id && m.active_now);
  assert.equal(list.licences[0].machines.length, 2);
  const rel = await jsonOf(await call('POST', '/machines/release', { cookie: session, body: { licence_id: licenceId, machine_id: list.licences[0].machines[1].id } }));
  assert.equal(rel.ok, true, JSON.stringify(rel));
  assert.ok(machineB);
  const c2 = await jsonOf(await call('POST', '/activate', { origin: null, body: { track_id: 'example-circuit', licence_id: licenceId, machine_hash: C } }));
  assert.equal(c2.ok, true, JSON.stringify(c2));
  const rel2 = await jsonOf(await call('POST', '/machines/release', { cookie: session, body: { licence_id: licenceId, machine_id: list.licences[0].machines[0].id } }));
  assert.equal(rel2.error, 'release_cooldown');
  assert.ok(rel2.retry_at);

  const forged = await jsonOf(await call('POST', '/validate', { origin: null, body: { token: a.token.slice(0, -2) + 'xx' } }));
  assert.equal(forged.reason, 'bad_token');
});

test('Race server check', async () => {
  const noKey = await call('POST', '/server/check', { origin: null, body: { steam_id: STEAM_ID, track_id: 'example-circuit' } });
  assert.equal(noKey.status, 401);
  const auth = { authorization: `Bearer ${env.SERVER_KEYS}` };
  assert.equal((await jsonOf(await call('POST', '/server/check', { origin: null, headers: auth, body: { steam_id: STEAM_ID, track_id: 'example-circuit' } }))).ok, true);
  assert.equal((await jsonOf(await call('POST', '/server/check', { origin: null, headers: auth, body: { steam_id: '76561198000000099', track_id: 'example-circuit' } }))).reason, 'no_licence');
});

test('Refund and dispute revoke the licence everywhere', async () => {
  const partial = await jsonOf(await signedWebhook({ type: 'charge.refunded', data: { object: { refunded: false, payment_intent: 'pi_cs_test_personal_1' } } }));
  assert.equal(partial.result, 'partial_refund_ignored');
  const full = await jsonOf(await signedWebhook({ type: 'charge.refunded', data: { object: { refunded: true, payment_intent: 'pi_cs_test_personal_1' } } }));
  assert.equal(full.result, 'refunded');
  const v = await jsonOf(await call('POST', '/validate', { origin: null, body: { track_id: 'example-circuit', steam_id: STEAM_ID, machine_hash: 'A'.repeat(40) } }));
  assert.equal(v.reason, 'refunded');
  const dl = await jsonOf(await call('POST', '/downloads', { cookie: session, body: { licence_id: licenceId } }));
  assert.equal(dl.error, 'licence_inactive');
  const auth = { authorization: `Bearer ${env.SERVER_KEYS}` };
  assert.equal((await jsonOf(await call('POST', '/server/check', { origin: null, headers: auth, body: { steam_id: STEAM_ID, track_id: 'example-circuit' } }))).reason, 'refunded');
});

test('Commercial licence: key shown once, key login, key required to activate', async () => {
  const co = await jsonOf(await call('POST', '/checkout', { body: { track_id: 'example-circuit', type: 'commercial', lang: 'en' } }));
  assert.ok(co.url);
  assert.equal(stripeCalls.at(-1).get('line_items[0][price]'), 'price_commercial');
  paidSession('cs_test_commercial_1', { type: 'commercial', price: 'price_commercial' });
  assert.equal((await jsonOf(await signedWebhook({ type: 'checkout.session.completed', data: { object: { id: 'cs_test_commercial_1' } } }))).result, 'granted');

  const r1res = await call('GET', '/checkout/result?session_id=cs_test_commercial_1');
  const r1 = await jsonOf(r1res);
  assert.match(r1.licence_key, /^GVC-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const venue = cookieFrom(r1res, 'gv_session');
  assert.ok(venue);
  const r2 = await jsonOf(await call('GET', '/checkout/result?session_id=cs_test_commercial_1'));
  assert.equal(r2.licence_key ?? null, null);

  const lic = (await jsonOf(await call('GET', '/licences', { cookie: venue }))).licences[0];
  assert.deepEqual([lic.type, lic.max_machines], ['commercial', 10]);

  const login = await call('POST', '/commercial/login', { body: { licence_key: r1.licence_key.toLowerCase() } });
  assert.equal((await jsonOf(login)).ok, true);
  assert.equal((await jsonOf(await call('POST', '/commercial/login', { body: { licence_key: 'GVC-AAAA-BBBB-CCCC-DDDD' } }))).error, 'not_found');

  const noKey = await jsonOf(await call('POST', '/activate', { origin: null, body: { track_id: 'example-circuit', licence_id: lic.id, machine_hash: 'Z'.repeat(40) } }));
  assert.equal(noKey.reason, 'no_licence');
  const withKey = await jsonOf(await call('POST', '/activate', { origin: null, body: { track_id: 'example-circuit', licence_id: lic.id, licence_key: r1.licence_key, machine_hash: 'Z'.repeat(40) } }));
  assert.equal(withKey.ok, true);
});

test('Admin API', async () => {
  assert.equal((await call('GET', '/admin/stats')).status, 401);
  const auth = { authorization: `Bearer ${env.ADMIN_TOKEN}` };
  const stats = await jsonOf(await call('GET', '/admin/stats', { headers: auth }));
  assert.deepEqual(stats.tracks[0], { track_id: 'example-circuit', name: 'Example Circuit', licences: 2, active: 1, refunded: 1, downloads: 1 });
  const all = await jsonOf(await call('GET', `/admin/licences?q=${STEAM_ID}`, { headers: auth }));
  assert.equal(all.licences.length, 1);
  const commercial = (await jsonOf(await call('GET', '/admin/licences?status=active', { headers: auth }))).licences[0];
  assert.equal((await jsonOf(await call('POST', `/admin/licences/${commercial.id}/revoke`, { headers: auth, origin: null }))).ok, true);
  assert.equal((await jsonOf(await call('GET', `/admin/licences?status=disabled`, { headers: auth }))).licences.length, 1);
  assert.equal((await jsonOf(await call('POST', `/admin/licences/${commercial.id}/reset-machines`, { headers: auth, origin: null }))).ok, true);
  assert.equal((await jsonOf(await call('POST', `/admin/licences/${commercial.id}/reactivate`, { headers: auth, origin: null }))).ok, true);
});

test('Rate limit on the public licence API', async () => {
  let last;
  for (let i = 0; i < 62; i++) {
    last = await call('POST', '/validate', { origin: null, body: { token: 'x.y' }, headers: { 'cf-connecting-ip': '203.0.113.9' } });
  }
  assert.equal((await jsonOf(last)).error, 'rate_limited');
  assert.equal(last.headers.get('access-control-allow-origin'), '*');
});
