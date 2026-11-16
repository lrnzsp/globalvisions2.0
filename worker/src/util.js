// Small helpers shared by every route. No dependencies: Workers runtime only.

const enc = new TextEncoder();
const dec = new TextDecoder();

export const nowIso = () => new Date().toISOString();

export function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export const fail = (error, status = 400, extra = {}) => json({ ok: false, error, ...extra }, status);

export class HttpError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export async function readJson(request, maxBytes = 16384) {
  const text = await request.text();
  if (text.length > maxBytes) throw new HttpError(413, 'bad_request');
  if (!text) return {};
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('not an object');
    return value;
  } catch {
    throw new HttpError(400, 'bad_request');
  }
}

// ---------- encoding ----------

export function b64urlEncode(bytes) {
  if (typeof bytes === 'string') bytes = enc.encode(bytes);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlDecode(text) {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export const bytesToText = (bytes) => dec.decode(bytes);
export const textToBytes = (text) => enc.encode(text);

const B32 = 'abcdefghjkmnpqrstuvwxyz23456789'; // no i, l, o, 0, 1

export function randomId(prefix, length = 24) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const b of bytes) out += B32[b % B32.length];
  return `${prefix}_${out}`;
}

const KEY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols, no 0/O/1/I

export function newLicenceKey() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const chars = [...bytes].map((b) => KEY_ALPHABET[b % 32]).join('');
  return `GVC-${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}-${chars.slice(12, 16)}`;
}

export const normaliseLicenceKey = (key) =>
  String(key || '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^GVC/, '');

// ---------- crypto ----------

const keyCache = new Map();

async function hmacKey(secret) {
  if (!secret) throw new HttpError(500, 'server_error', { message: 'missing secret' });
  let key = keyCache.get(secret);
  if (!key) {
    key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
    keyCache.set(secret, key);
  }
  return key;
}

export async function hmac(secret, data) {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), typeof data === 'string' ? enc.encode(data) : data);
  return new Uint8Array(sig);
}

export async function hmacHex(secret, data) {
  return [...(await hmac(secret, data))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// Signed, expiring tokens: base64url(json).base64url(hmac). Purpose-scoped so a
// token minted for one use (session, download, licence) is useless elsewhere.
export async function signToken(secret, purpose, payload, ttlSeconds) {
  const body = b64urlEncode(JSON.stringify({ ...payload, p: purpose, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  const sig = b64urlEncode(await hmac(secret, `${purpose}.${body}`));
  return `${body}.${sig}`;
}

export async function verifyToken(secret, purpose, token) {
  if (typeof token !== 'string' || token.length > 4096) return { error: 'bad_token' };
  const [body, sig] = token.split('.');
  if (!body || !sig) return { error: 'bad_token' };
  const expected = b64urlEncode(await hmac(secret, `${purpose}.${body}`));
  if (!timingSafeEqual(sig, expected)) return { error: 'bad_token' };
  let payload;
  try {
    payload = JSON.parse(bytesToText(b64urlDecode(body)));
  } catch {
    return { error: 'bad_token' };
  }
  if (payload.p !== purpose) return { error: 'bad_token' };
  if (typeof payload.exp !== 'number' || payload.exp < Math.floor(Date.now() / 1000)) return { error: 'expired_token' };
  return { payload };
}

// ---------- validation ----------

export const isSteamId = (v) => typeof v === 'string' && /^7656119\d{10}$/.test(v);
export const isTrackId = (v) => typeof v === 'string' && /^[a-z0-9-]{2,48}$/.test(v);
export const isLicenceId = (v) => typeof v === 'string' && /^lic_[a-z0-9]{24}$/.test(v);
export const isMachineHash = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(v);
export const isType = (v) => v === 'personal' || v === 'commercial';

// ---------- cookies ----------

export function getCookie(request, name) {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

export function cookie(name, value, { maxAge, path = '/', httpOnly = true } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${path}`, 'Secure', 'SameSite=Lax'];
  if (httpOnly) parts.push('HttpOnly');
  if (maxAge !== undefined) parts.push(`Max-Age=${maxAge}`);
  return parts.join('; ');
}

// Only allow redirects back into the store, never to another site.
export function safeNext(next, fallback = '/store/account/') {
  if (typeof next !== 'string') return fallback;
  if (!/^\/(it\/)?store(\/[A-Za-z0-9\-_/]*)?(\?[A-Za-z0-9=&_\-.%]*)?$/.test(next)) return fallback;
  return next;
}
