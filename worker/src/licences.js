// Licences: what buyers see, what the game client checks, what race servers ask.

import {
  HttpError, isLicenceId, isMachineHash, isSteamId, isTrackId, json, normaliseLicenceKey, nowIso,
  randomId, sha256Hex, signToken, timingSafeEqual, verifyToken,
} from './util.js';
import { sessionCookie } from './auth.js';

export const IN_USE_WINDOW_MS = 15 * 60 * 1000; // a machine "in use" was seen in the last 15 minutes
export const CHECK_INTERVAL_S = 600; // clients re-validate every 10 minutes
export const CLIENT_TOKEN_TTL_S = 3600;
export const RELEASE_COOLDOWN_MS = 7 * 24 * 3600 * 1000; // a buyer may free one machine slot per week
export const DOWNLOAD_TTL_S = 15 * 60;

export const hashLicenceKey = (env, key) => sha256Hex(`${env.KEY_PEPPER || env.SESSION_SECRET}:${normaliseLicenceKey(key)}`);

// ---------- browser: account ----------

async function licencesForSession(env, session) {
  if (session.kind === 'steam') {
    const r = await env.DB.prepare(
      `SELECT l.*, t.name AS track_name FROM licences l LEFT JOIN tracks t ON t.track_id = l.track_id
       WHERE l.steam_id = ?1 ORDER BY l.created_at DESC`,
    ).bind(session.steamId).all();
    return r.results || [];
  }
  if (!session.licenceIds.length) return [];
  const marks = session.licenceIds.map((_, i) => `?${i + 1}`).join(',');
  const r = await env.DB.prepare(
    `SELECT l.*, t.name AS track_name FROM licences l LEFT JOIN tracks t ON t.track_id = l.track_id
     WHERE l.id IN (${marks}) AND l.type = 'commercial' ORDER BY l.created_at DESC`,
  ).bind(...session.licenceIds).all();
  return r.results || [];
}

async function machinesFor(env, licenceId) {
  const r = await env.DB.prepare(
    'SELECT id, first_seen, last_seen FROM machines WHERE licence_id = ?1 AND released_at IS NULL ORDER BY first_seen',
  ).bind(licenceId).all();
  const cutoff = Date.now() - IN_USE_WINDOW_MS;
  return (r.results || []).map((m) => ({ ...m, active_now: Date.parse(m.last_seen) >= cutoff }));
}

export async function publicLicence(env, l) {
  const releaseAt = l.last_release_at ? Date.parse(l.last_release_at) + RELEASE_COOLDOWN_MS : 0;
  return {
    id: l.id,
    track_id: l.track_id,
    track_name: l.track_name || l.track_id,
    type: l.type,
    status: l.status,
    max_machines: l.max_machines,
    created_at: l.created_at,
    machines: await machinesFor(env, l.id),
    release_available_at: releaseAt > Date.now() ? new Date(releaseAt).toISOString() : null,
  };
}

export async function listLicences(env, session) {
  const rows = await licencesForSession(env, session);
  return json({ ok: true, licences: await Promise.all(rows.map((l) => publicLicence(env, l))) });
}

async function ownedLicence(env, session, licenceId) {
  if (!isLicenceId(licenceId)) throw new HttpError(400, 'bad_request');
  const l = await env.DB.prepare('SELECT * FROM licences WHERE id = ?1').bind(licenceId).first();
  if (!l) throw new HttpError(404, 'not_found');
  const owns = session.kind === 'steam' ? l.steam_id === session.steamId : session.licenceIds.includes(l.id);
  if (!owns) throw new HttpError(403, 'not_owner');
  return l;
}

export async function releaseMachine(env, session, body) {
  const l = await ownedLicence(env, session, body.licence_id);
  if (typeof body.machine_id !== 'string') throw new HttpError(400, 'bad_request');
  const now = nowIso();
  const cutoff = new Date(Date.now() - RELEASE_COOLDOWN_MS).toISOString();
  // One transaction: the machine is released only if the weekly cooldown is
  // free, and the cooldown is claimed only by the request that released it.
  // Two parallel requests serialise, and the second sees the claimed cooldown.
  const [release] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE machines SET released_at = ?3
       WHERE id = ?1 AND licence_id = ?2 AND released_at IS NULL
         AND EXISTS (SELECT 1 FROM licences WHERE id = ?2 AND (last_release_at IS NULL OR last_release_at < ?4))`,
    ).bind(body.machine_id, l.id, now, cutoff),
    env.DB.prepare(
      `UPDATE licences SET last_release_at = ?2, updated_at = ?2
       WHERE id = ?1 AND EXISTS (SELECT 1 FROM machines WHERE id = ?3 AND licence_id = ?1 AND released_at = ?2)`,
    ).bind(l.id, now, body.machine_id),
  ]);
  if (release.meta && release.meta.changes === 1) return json({ ok: true });
  const fresh = await env.DB.prepare('SELECT last_release_at FROM licences WHERE id = ?1').bind(l.id).first();
  if (fresh && fresh.last_release_at && fresh.last_release_at >= cutoff) {
    const retry = Date.parse(fresh.last_release_at) + RELEASE_COOLDOWN_MS;
    throw new HttpError(429, 'release_cooldown', { retry_at: new Date(retry).toISOString() });
  }
  throw new HttpError(404, 'not_found');
}

export async function createDownload(env, session, body) {
  const l = await ownedLicence(env, session, body.licence_id);
  if (l.status !== 'active') throw new HttpError(403, 'licence_inactive', { status: l.status });
  const track = await env.DB.prepare('SELECT r2_key FROM tracks WHERE track_id = ?1').bind(l.track_id).first();
  if (!track || !track.r2_key) throw new HttpError(409, 'track_unavailable');
  const copyId = randomId('cp');
  const token = await signToken(env.DOWNLOAD_SECRET || env.SESSION_SECRET, 'download', { l: l.id, c: copyId }, DOWNLOAD_TTL_S);
  return json({
    ok: true,
    url: `${env.STORE_API_ORIGIN}/dl/${token}`,
    copy_id: copyId,
    expires_at: new Date(Date.now() + DOWNLOAD_TTL_S * 1000).toISOString(),
  });
}

export async function checkoutResult(env, session, sessionId) {
  if (typeof sessionId !== 'string' || !/^cs_[A-Za-z0-9_]{8,200}$/.test(sessionId)) throw new HttpError(400, 'bad_request');
  const order = await env.DB.prepare('SELECT * FROM orders WHERE id = ?1').bind(sessionId).first();
  if (!order) return { body: { ok: true, status: 'pending' } };
  const base = { ok: true, status: 'ready', licence_id: order.licence_id, type: order.type, track_id: order.track_id };
  if (order.type === 'personal') {
    if (!session || session.kind !== 'steam' || session.steamId !== order.steam_id) return { body: { ok: true, status: 'ready' } };
    return { body: base };
  }
  // Commercial: the key is shown exactly once, to whoever holds the session id
  // from the Stripe redirect, and the browser is signed in to that licence.
  let key = null;
  if (order.licence_key_plain) {
    const cleared = await env.DB.prepare('UPDATE orders SET licence_key_plain = NULL WHERE id = ?1 AND licence_key_plain IS NOT NULL')
      .bind(sessionId).run();
    if (cleared.meta && cleared.meta.changes === 1) key = order.licence_key_plain;
  }
  const ids = new Set(session && session.kind === 'commercial' ? session.licenceIds : []);
  ids.add(order.licence_id);
  const cookieHeader = key ? await sessionCookie(env, { k: 'commercial', lids: [...ids].slice(-50) }) : null;
  return { body: { ...base, licence_key: key }, cookie: cookieHeader };
}

export async function commercialLogin(env, body) {
  const key = normaliseLicenceKey(body.licence_key);
  if (key.length !== 16) throw new HttpError(400, 'bad_request');
  const hash = await hashLicenceKey(env, key);
  const rows = await env.DB.prepare(`SELECT id FROM licences WHERE licence_key_hash = ?1 AND type = 'commercial'`).bind(hash).all();
  const ids = (rows.results || []).map((r) => r.id);
  if (!ids.length) throw new HttpError(404, 'not_found');
  return json({ ok: true, licence_ids: ids }, 200, { 'set-cookie': await sessionCookie(env, { k: 'commercial', lids: ids }) });
}

// ---------- game client: /activate and /validate ----------

const reason = (r, extra = {}) => json({ ok: false, reason: r, ...extra }, 200);

async function findLicenceForClient(env, body) {
  if (!isTrackId(body.track_id)) return { error: 'bad_request' };
  let rows = [];
  if (body.licence_id !== undefined) {
    if (!isLicenceId(body.licence_id)) return { error: 'bad_request' };
    const l = await env.DB.prepare('SELECT * FROM licences WHERE id = ?1 AND track_id = ?2').bind(body.licence_id, body.track_id).first();
    rows = l ? [l] : [];
  } else if (body.steam_id !== undefined) {
    if (!isSteamId(body.steam_id)) return { error: 'bad_request' };
    const r = await env.DB.prepare(
      `SELECT * FROM licences WHERE steam_id = ?1 AND track_id = ?2 AND type = 'personal'
       ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, created_at DESC`,
    ).bind(body.steam_id, body.track_id).all();
    rows = r.results || [];
  } else {
    return { error: 'bad_request' };
  }
  const l = rows[0];
  if (!l) return { error: 'no_licence' };
  if (l.type === 'commercial') {
    if (!body.licence_key) return { error: 'no_licence' };
    const hash = await hashLicenceKey(env, body.licence_key);
    if (!timingSafeEqual(hash, l.licence_key_hash || '')) return { error: 'no_licence' };
  }
  if (l.status === 'refunded') return { error: 'refunded' };
  if (l.status === 'disabled') return { error: 'disabled' };
  return { licence: l };
}

// Marks the machine as in use. The simultaneous-use limit is checked inside the
// UPDATE itself, so concurrent validations cannot all slip under it.
async function touchMachine(env, licence, machine) {
  const cutoff = new Date(Date.now() - IN_USE_WINDOW_MS).toISOString();
  const r = await env.DB.prepare(
    `UPDATE machines SET last_seen = ?2
     WHERE id = ?1 AND released_at IS NULL
       AND (SELECT COUNT(*) FROM machines o
            WHERE o.licence_id = ?3 AND o.released_at IS NULL AND o.last_seen >= ?4 AND o.id != ?1) < ?5`,
  ).bind(machine.id, nowIso(), licence.id, cutoff, licence.max_machines).run();
  return r.meta && r.meta.changes === 1 ? null : 'too_many_active';
}

async function clientToken(env, licence, machine) {
  return signToken(env.LICENCE_TOKEN_SECRET || env.SESSION_SECRET, 'client', { l: licence.id, m: machine.id, t: licence.track_id }, CLIENT_TOKEN_TTL_S);
}

export async function activate(env, body) {
  if (!isMachineHash(body.machine_hash)) return reason('bad_request');
  const found = await findLicenceForClient(env, body);
  if (found.error) return reason(found.error);
  const l = found.licence;

  let machine = await env.DB.prepare('SELECT * FROM machines WHERE licence_id = ?1 AND machine_hash = ?2').bind(l.id, body.machine_hash).first();
  if (machine && machine.released_at) {
    // A released machine coming back counts as a new registration.
    machine = null;
    await env.DB.prepare('DELETE FROM machines WHERE licence_id = ?1 AND machine_hash = ?2 AND released_at IS NOT NULL').bind(l.id, body.machine_hash).run();
  }
  if (!machine) {
    // Registration and capacity check in one statement: SQLite runs it
    // atomically, so concurrent activations cannot exceed max_machines.
    const now = nowIso();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO machines (id, licence_id, machine_hash, first_seen, last_seen)
       SELECT ?1, ?2, ?3, ?4, '1970-01-01T00:00:00.000Z'
       WHERE (SELECT COUNT(*) FROM machines WHERE licence_id = ?2 AND released_at IS NULL) < ?5`,
    ).bind(randomId('mac'), l.id, body.machine_hash, now, l.max_machines).run();
    machine = await env.DB.prepare('SELECT * FROM machines WHERE licence_id = ?1 AND machine_hash = ?2 AND released_at IS NULL').bind(l.id, body.machine_hash).first();
    if (!machine) return reason('machine_limit', { max_machines: l.max_machines });
  }
  const busy = await touchMachine(env, l, machine);
  if (busy) return reason(busy, { max_machines: l.max_machines });
  return json({
    ok: true,
    token: await clientToken(env, l, machine),
    expires_in: CLIENT_TOKEN_TTL_S,
    licence_id: l.id,
    next_check_in: CHECK_INTERVAL_S,
  });
}

export async function validate(env, body) {
  let l;
  let machine;
  if (body.token !== undefined) {
    const { payload, error } = await verifyToken(env.LICENCE_TOKEN_SECRET || env.SESSION_SECRET, 'client', body.token);
    if (error) return reason(error);
    l = await env.DB.prepare('SELECT * FROM licences WHERE id = ?1').bind(payload.l).first();
    if (!l) return reason('no_licence');
    if (l.status !== 'active') return reason(l.status === 'refunded' ? 'refunded' : 'disabled');
    machine = await env.DB.prepare('SELECT * FROM machines WHERE id = ?1 AND licence_id = ?2 AND released_at IS NULL').bind(payload.m, l.id).first();
    if (!machine) return reason('unknown_machine');
  } else {
    if (!isMachineHash(body.machine_hash)) return reason('bad_request');
    const found = await findLicenceForClient(env, body);
    if (found.error) return reason(found.error);
    l = found.licence;
    machine = await env.DB.prepare('SELECT * FROM machines WHERE licence_id = ?1 AND machine_hash = ?2 AND released_at IS NULL').bind(l.id, body.machine_hash).first();
    if (!machine) return reason('unknown_machine');
  }
  const busy = await touchMachine(env, l, machine);
  if (busy) return reason(busy, { max_machines: l.max_machines });
  return json({ ok: true, next_check_in: CHECK_INTERVAL_S });
}

// ---------- race server ----------

export async function serverCheck(env, body) {
  if (!isSteamId(body.steam_id) || !isTrackId(body.track_id)) return reason('bad_request');
  const r = await env.DB.prepare(
    `SELECT status FROM licences WHERE steam_id = ?1 AND track_id = ?2 AND type = 'personal'
     ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END LIMIT 1`,
  ).bind(body.steam_id, body.track_id).first();
  if (!r) return reason('no_licence');
  if (r.status !== 'active') return reason(r.status === 'refunded' ? 'refunded' : 'disabled');
  return json({ ok: true });
}
