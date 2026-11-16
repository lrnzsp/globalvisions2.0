// Sessions and "Sign in through Steam" (OpenID 2.0).
// Steam returns only the SteamID64. We store nothing about the user except
// that id inside a signed, HttpOnly cookie.

import {
  HttpError, cookie, getCookie, json, nowIso, randomId, safeNext, signToken, verifyToken, isSteamId,
} from './util.js';

const STEAM_OPENID = 'https://steamcommunity.com/openid/login';
const SESSION_TTL = 30 * 24 * 3600;
const STATE_TTL = 600;

export async function readSession(request, env) {
  const token = getCookie(request, 'gv_session');
  if (!token) return null;
  const { payload } = await verifyToken(env.SESSION_SECRET, 'session', token);
  if (!payload) return null;
  if (payload.k === 'steam' && isSteamId(payload.sid)) return { kind: 'steam', steamId: payload.sid };
  if (payload.k === 'commercial' && Array.isArray(payload.lids)) return { kind: 'commercial', licenceIds: payload.lids.slice(0, 50) };
  return null;
}

export async function sessionCookie(env, payload) {
  return cookie('gv_session', await signToken(env.SESSION_SECRET, 'session', payload, SESSION_TTL), { maxAge: SESSION_TTL });
}

export const clearSessionCookie = () => cookie('gv_session', '', { maxAge: 0 });

const callbackUrl = (env) => `${env.PUBLIC_ORIGIN}/api/store/auth/steam/callback`;

export async function steamLogin(request, env, url) {
  const lang = url.searchParams.get('lang') === 'it' ? 'it' : 'en';
  const next = safeNext(url.searchParams.get('next'), lang === 'it' ? '/it/store/account/' : '/store/account/');
  const state = randomId('st', 20);
  const returnTo = `${callbackUrl(env)}?state=${state}`;
  const params = new URLSearchParams({
    'openid.ns': 'http://specs.openid.net/auth/2.0',
    'openid.mode': 'checkid_setup',
    'openid.return_to': returnTo,
    'openid.realm': env.PUBLIC_ORIGIN,
    'openid.identity': 'http://specs.openid.net/auth/2.0/identifier_select',
    'openid.claimed_id': 'http://specs.openid.net/auth/2.0/identifier_select',
  });
  const stateToken = await signToken(env.SESSION_SECRET, 'state', { s: state, n: next }, STATE_TTL);
  return new Response(null, {
    status: 302,
    headers: {
      location: `${STEAM_OPENID}?${params}`,
      'set-cookie': cookie('gv_state', stateToken, { maxAge: STATE_TTL }),
      'cache-control': 'no-store',
    },
  });
}

export async function steamCallback(request, env, url, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  const p = url.searchParams;
  const fallback = '/store/account/';

  // 1. Our own state: binds this answer to the browser that started the login.
  const stateCookie = getCookie(request, 'gv_state');
  const { payload: st } = stateCookie ? await verifyToken(env.SESSION_SECRET, 'state', stateCookie) : {};
  const state = p.get('state');
  if (!st || !state || st.s !== state) return loginFailed(fallback, 'state');
  const next = safeNext(st.n, fallback);

  // 2. Shape of the OpenID answer.
  if (p.get('openid.mode') !== 'id_res') return loginFailed(next, 'cancelled');
  if (p.get('openid.op_endpoint') !== STEAM_OPENID) return loginFailed(next, 'endpoint');
  if (p.get('openid.return_to') !== `${callbackUrl(env)}?state=${state}`) return loginFailed(next, 'return_to');
  const claimed = p.get('openid.claimed_id') || '';
  const m = claimed.match(/^https:\/\/steamcommunity\.com\/openid\/id\/(7656119\d{10})$/);
  if (!m || p.get('openid.identity') !== claimed) return loginFailed(next, 'identity');
  const signed = (p.get('openid.signed') || '').split(',');
  for (const field of ['op_endpoint', 'claimed_id', 'identity', 'return_to', 'response_nonce', 'assoc_handle']) {
    if (!signed.includes(field)) return loginFailed(next, 'unsigned');
  }

  // 3. Nonce: fresh and never seen before.
  const nonce = p.get('openid.response_nonce') || '';
  const nonceTime = Date.parse(nonce.slice(0, 20));
  if (!nonceTime || Math.abs(Date.now() - nonceTime) > 5 * 60 * 1000) return loginFailed(next, 'nonce_age');
  const inserted = await env.DB.prepare('INSERT OR IGNORE INTO auth_nonces (nonce, created_at) VALUES (?1, ?2)')
    .bind(nonce, nowIso()).run();
  if (!inserted.meta || inserted.meta.changes !== 1) return loginFailed(next, 'nonce_reuse');

  // 4. Ask Steam to confirm the signature.
  const check = new URLSearchParams();
  for (const [k, v] of p) if (k.startsWith('openid.')) check.set(k, v);
  check.set('openid.mode', 'check_authentication');
  let verified = false;
  try {
    const res = await fetchImpl(STEAM_OPENID, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: check.toString(),
    });
    verified = /(^|\n)is_valid\s*:\s*true(\n|$)/.test(await res.text());
  } catch {
    verified = false;
  }
  if (!verified) return loginFailed(next, 'not_verified');

  // Old nonces are useless after five minutes: keep the table small.
  await env.DB.prepare('DELETE FROM auth_nonces WHERE created_at < ?1')
    .bind(new Date(Date.now() - 3600 * 1000).toISOString()).run();

  const headers = new Headers({ location: next, 'cache-control': 'no-store' });
  headers.append('set-cookie', await sessionCookie(env, { k: 'steam', sid: m[1] }));
  headers.append('set-cookie', cookie('gv_state', '', { maxAge: 0 }));
  return new Response(null, { status: 302, headers });
}

function loginFailed(next, reason) {
  const sep = next.includes('?') ? '&' : '?';
  const headers = new Headers({ location: `${next}${sep}login_error=${reason}`, 'cache-control': 'no-store' });
  headers.append('set-cookie', cookie('gv_state', '', { maxAge: 0 }));
  return new Response(null, { status: 302, headers });
}

export function logout() {
  return json({ ok: true }, 200, { 'set-cookie': clearSessionCookie() });
}

export async function requireSession(request, env) {
  const session = await readSession(request, env);
  if (!session) throw new HttpError(401, 'login_required');
  return session;
}
