// Global Visions track store: Cloudflare Worker entry point.
// Bindings (see wrangler.toml): DB (D1), TRACKS (R2).
// Secrets: SESSION_SECRET, DOWNLOAD_SECRET, LICENCE_TOKEN_SECRET, FINGERPRINT_SECRET,
//          KEY_PEPPER, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, ADMIN_TOKEN, SERVER_KEYS,
//          optional RESEND_API_KEY + EMAIL_FROM, optional STEAM_API_KEY.
// Vars: PUBLIC_ORIGIN (https://globalvisions.it), STORE_API_ORIGIN (this Worker's public origin).

import { HttpError, b64urlEncode, fail, hmac, json, nowIso, readJson, sha256Hex, timingSafeEqual, verifyToken } from './util.js';
import { logout, readSession, requireSession, steamCallback, steamLogin } from './auth.js';
import { createCheckout, handleWebhook } from './stripe.js';
import {
  activate, checkoutResult, commercialLogin, createDownload, listLicences, publicLicence, releaseMachine, serverCheck, validate,
} from './licences.js';
import { fingerprintedZip } from './zip.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'content-type',
  'access-control-max-age': '86400',
};

function withHeaders(res, headers) {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}

// Browser calls that change state must come from our own site.
function requireOrigin(request, env) {
  const origin = request.headers.get('origin');
  if (origin !== env.PUBLIC_ORIGIN) throw new HttpError(403, 'bad_origin');
}

// Fixed one-minute windows in D1. Keys are hashed, never raw IPs.
// Browser calls reach the Worker through the Vercel rewrite, so they all come
// from Vercel's addresses: for those we key on the visitor address Vercel
// forwards. The game and server APIs are called directly, so there we trust
// only Cloudflare's own header (a client could forge x-real-ip to dodge limits).
function clientAddress(request, proxied) {
  if (proxied) {
    const forwarded = request.headers.get('x-real-ip') || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim();
    if (forwarded) return forwarded;
  }
  return request.headers.get('cf-connecting-ip') || 'unknown';
}

async function rateLimit(env, request, scope, limit, proxied = false) {
  const ip = clientAddress(request, proxied);
  const minute = Math.floor(Date.now() / 60000);
  const bucket = (await sha256Hex(`${env.SESSION_SECRET}:${scope}:${ip}`)).slice(0, 32);
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (bucket, count, window_start) VALUES (?1, 1, ?2)
     ON CONFLICT(bucket) DO UPDATE SET
       count = CASE WHEN window_start = ?2 THEN count + 1 ELSE 1 END,
       window_start = ?2
     RETURNING count`,
  ).bind(bucket, minute).first();
  if (row && row.count > limit) throw new HttpError(429, 'rate_limited');
}

function bearer(request) {
  const h = request.headers.get('authorization') || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

function requireAdmin(request, env) {
  const token = bearer(request);
  if (!env.ADMIN_TOKEN || env.ADMIN_TOKEN.length < 32 || !timingSafeEqual(token, env.ADMIN_TOKEN)) throw new HttpError(401, 'unauthorised');
}

function requireServer(request, env) {
  const token = bearer(request);
  const keys = String(env.SERVER_KEYS || '').split(',').map((k) => k.trim()).filter((k) => k.length >= 32);
  if (!token || !keys.some((k) => timingSafeEqual(k, token))) throw new HttpError(401, 'unauthorised');
}

// ---------- download ----------

async function download(env, token) {
  const { payload, error } = await verifyToken(env.DOWNLOAD_SECRET || env.SESSION_SECRET, 'download', token);
  if (error) return new Response(error === 'expired_token' ? 'This download link has expired. Request a new one from your account.' : 'Invalid download link.', { status: 403 });
  const l = await env.DB.prepare(
    `SELECT l.id, l.track_id, l.type, l.status, t.folder, t.zip_root, t.r2_key, t.version
     FROM licences l JOIN tracks t ON t.track_id = l.track_id WHERE l.id = ?1`,
  ).bind(payload.l).first();
  if (!l || l.status !== 'active' || !l.r2_key) return new Response('This licence is not active.', { status: 403 });

  const issued = nowIso();
  const lines = [
    `LICENCE_ID=${l.id}`,
    `COPY_ID=${payload.c}`,
    `TRACK_ID=${l.track_id}`,
    `TYPE=${l.type}`,
    `ISSUED=${issued}`,
    `API=${env.STORE_API_ORIGIN}`,
  ];
  const signature = b64urlEncode(await hmac(env.FINGERPRINT_SECRET || env.SESSION_SECRET, lines.join('\n')));
  const ini = `[LICENCE]\n${lines.join('\n')}\nSIGNATURE=${signature}\n`;
  const root = (l.zip_root || `content/tracks/${l.folder}`).replace(/\/+$/, '');

  let zip;
  try {
    zip = await fingerprintedZip(env.TRACKS, l.r2_key, { name: `${root}/extension/gv_licence.ini`, data: new TextEncoder().encode(ini) });
  } catch (err) {
    console.error('download build failed', l.r2_key, err && err.message);
    return new Response('The download could not be prepared. Please write to hello@globalvisions.it.', { status: 500 });
  }
  // Record the copy only once the build is ready; the same token re-downloads the same copy.
  await env.DB.prepare('INSERT OR IGNORE INTO downloads (id, licence_id, track_id, created_at) VALUES (?1, ?2, ?3, ?4)')
    .bind(payload.c, l.id, l.track_id, issued).run();

  let body = zip.stream;
  if (typeof FixedLengthStream !== 'undefined') {
    // eslint-disable-next-line no-undef
    const fixed = new FixedLengthStream(zip.length);
    zip.stream.pipeTo(fixed.writable).catch(() => {});
    body = fixed.readable;
  }
  return new Response(body, {
    headers: {
      'content-type': 'application/zip',
      'content-length': String(zip.length),
      'content-disposition': `attachment; filename="${l.track_id}-${l.version}.zip"`,
      'cache-control': 'no-store',
    },
  });
}

// ---------- admin ----------

async function admin(request, env, path, url) {
  requireAdmin(request, env);
  if (request.method === 'GET' && path === '/admin/licences') {
    const where = [];
    const args = [];
    const add = (sql, v) => { args.push(v); where.push(sql.replace('?', `?${args.length}`)); };
    if (url.searchParams.get('steam_id')) add('l.steam_id = ?', url.searchParams.get('steam_id'));
    if (url.searchParams.get('track_id')) add('l.track_id = ?', url.searchParams.get('track_id'));
    if (url.searchParams.get('status')) add('l.status = ?', url.searchParams.get('status'));
    const q = url.searchParams.get('q');
    if (q) {
      args.push(q);
      where.push(`(l.id = ?${args.length} OR l.order_id = ?${args.length} OR l.steam_id = ?${args.length})`);
    }
    const rows = await env.DB.prepare(
      `SELECT l.*, t.name AS track_name FROM licences l LEFT JOIN tracks t ON t.track_id = l.track_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY l.created_at DESC LIMIT 200`,
    ).bind(...args).all();
    const licences = await Promise.all((rows.results || []).map(async (l) => ({
      ...(await publicLicence(env, l)), steam_id: l.steam_id, order_id: l.order_id,
    })));
    return json({ ok: true, licences });
  }
  let m = path.match(/^\/admin\/licences\/(lic_[a-z0-9]{24})\/(revoke|reactivate|reset-machines)$/);
  if (request.method === 'POST' && m) {
    const [, id, action] = m;
    const now = nowIso();
    let r;
    if (action === 'revoke') r = await env.DB.prepare(`UPDATE licences SET status = 'disabled', updated_at = ?2 WHERE id = ?1`).bind(id, now).run();
    if (action === 'reactivate') r = await env.DB.prepare(`UPDATE licences SET status = 'active', updated_at = ?2 WHERE id = ?1`).bind(id, now).run();
    if (action === 'reset-machines') {
      r = await env.DB.prepare('SELECT id FROM licences WHERE id = ?1').bind(id).first();
      if (r) {
        await env.DB.prepare('UPDATE machines SET released_at = ?2 WHERE licence_id = ?1 AND released_at IS NULL').bind(id, now).run();
        await env.DB.prepare('UPDATE licences SET last_release_at = NULL, updated_at = ?2 WHERE id = ?1').bind(id, now).run();
        return json({ ok: true });
      }
      throw new HttpError(404, 'not_found');
    }
    if (!r.meta || r.meta.changes !== 1) throw new HttpError(404, 'not_found');
    return json({ ok: true });
  }
  if (request.method === 'GET' && path === '/admin/stats') {
    const rows = await env.DB.prepare(
      `SELECT t.track_id, t.name,
         (SELECT COUNT(*) FROM licences l WHERE l.track_id = t.track_id) AS licences,
         (SELECT COUNT(*) FROM licences l WHERE l.track_id = t.track_id AND l.status = 'active') AS active,
         (SELECT COUNT(*) FROM licences l WHERE l.track_id = t.track_id AND l.status = 'refunded') AS refunded,
         (SELECT COUNT(*) FROM downloads d WHERE d.track_id = t.track_id) AS downloads
       FROM tracks t ORDER BY t.track_id`,
    ).all();
    return json({ ok: true, tracks: rows.results || [] });
  }
  m = path.match(/^\/admin\/copies\/(cp_[a-z0-9]{24})$/);
  if (request.method === 'GET' && m) {
    const row = await env.DB.prepare(
      `SELECT d.id AS copy_id, d.licence_id, d.track_id, d.created_at, l.steam_id, l.type, l.status
       FROM downloads d JOIN licences l ON l.id = d.licence_id WHERE d.id = ?1`,
    ).bind(m[1]).first();
    if (!row) throw new HttpError(404, 'not_found');
    return json({ ok: true, ...row });
  }
  throw new HttpError(404, 'not_found');
}

// ---------- router ----------

export async function route(request, env, deps = {}) {
  const url = new URL(request.url);
  // Requests proxied by Vercel arrive as /api/store/...; direct ones without the prefix.
  const path = url.pathname.replace(/^\/api\/store(?=\/)/, '');
  const method = request.method;

  if (method === 'OPTIONS' && ['/activate', '/validate'].includes(path)) return new Response(null, { status: 204, headers: CORS });

  // Licence API for the game client: public, CORS open, rate limited.
  if (method === 'POST' && (path === '/activate' || path === '/validate')) {
    await rateLimit(env, request, 'client', 60);
    const body = await readJson(request);
    const res = path === '/activate' ? await activate(env, body) : await validate(env, body);
    return withHeaders(res, CORS);
  }
  if (method === 'POST' && path === '/server/check') {
    requireServer(request, env);
    return serverCheck(env, await readJson(request));
  }
  if (method === 'POST' && path === '/stripe/webhook') return handleWebhook(request, env, deps);
  if (method === 'GET' && path.startsWith('/dl/')) return download(env, path.slice(4));
  if (path.startsWith('/admin/')) return admin(request, env, path, url);

  // Browser API.
  if (method === 'GET' && path === '/auth/steam/login') return steamLogin(request, env, url);
  if (method === 'GET' && path === '/auth/steam/callback') return steamCallback(request, env, url, deps);
  if (method === 'POST' && path === '/auth/logout') { requireOrigin(request, env); return logout(); }
  if (method === 'GET' && path === '/me') {
    const s = await readSession(request, env);
    if (!s) return json({ ok: true, signed_in: false, kind: null });
    return json({ ok: true, signed_in: true, kind: s.kind, steam_id: s.steamId, licence_ids: s.licenceIds });
  }
  if (method === 'GET' && path === '/licences') return listLicences(env, await requireSession(request, env));
  if (method === 'POST' && path === '/checkout') {
    requireOrigin(request, env);
    await rateLimit(env, request, 'checkout', 20, true);
    const body = await readJson(request);
    const session = await readSession(request, env);
    if (body.type === 'personal' && (!session || session.kind !== 'steam')) throw new HttpError(401, 'login_required');
    const checkoutUrl = await createCheckout(env, {
      trackId: body.track_id, type: body.type, lang: body.lang === 'it' ? 'it' : 'en',
      steamId: body.type === 'personal' ? session.steamId : null,
    }, deps);
    return json({ ok: true, url: checkoutUrl });
  }
  if (method === 'GET' && path === '/checkout/result') {
    const r = await checkoutResult(env, await readSession(request, env), url.searchParams.get('session_id'));
    return json(r.body, 200, r.cookie ? { 'set-cookie': r.cookie } : {});
  }
  if (method === 'POST' && path === '/downloads') {
    requireOrigin(request, env);
    await rateLimit(env, request, 'download', 20, true);
    return createDownload(env, await requireSession(request, env), await readJson(request));
  }
  if (method === 'POST' && path === '/machines/release') {
    requireOrigin(request, env);
    return releaseMachine(env, await requireSession(request, env), await readJson(request));
  }
  if (method === 'POST' && path === '/commercial/login') {
    requireOrigin(request, env);
    await rateLimit(env, request, 'keylogin', 10, true);
    return commercialLogin(env, await readJson(request));
  }
  if (method === 'GET' && path === '/') return json({ ok: true, service: 'gv-store' });
  throw new HttpError(404, 'not_found');
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env);
    } catch (err) {
      if (err instanceof HttpError) {
        const res = fail(err.code, err.status, err.extra);
        const path = new URL(request.url).pathname;
        return /\/(activate|validate)$/.test(path) ? withHeaders(res, CORS) : res;
      }
      console.error(err && err.stack ? err.stack : err);
      return fail('server_error', 500);
    }
  },
  // Daily housekeeping: old rate-limit windows and login nonces.
  async scheduled(event, env) {
    const minute = Math.floor(Date.now() / 60000);
    await env.DB.prepare('DELETE FROM rate_limits WHERE window_start < ?1').bind(minute - 60).run();
    await env.DB.prepare('DELETE FROM auth_nonces WHERE created_at < ?1').bind(new Date(Date.now() - 86400000).toISOString()).run();
  },
};
