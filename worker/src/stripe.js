// Stripe Checkout, webhook verification and licence granting.
// Prices are never taken from the client: the Worker looks them up in the
// D1 catalog, and the webhook re-checks the paid line item against it.

import { HttpError, hmacHex, json, newLicenceKey, nowIso, randomId, timingSafeEqual, isTrackId, isType } from './util.js';
import { hashLicenceKey } from './licences.js';

const STRIPE_API = 'https://api.stripe.com/v1';

function formEncode(obj, prefix = '', out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === 'object' ? formEncode(item, `${key}[${i}]`, out) : out.append(`${key}[]`, String(item))));
    else if (typeof v === 'object') formEncode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export async function stripeRequest(env, method, path, params, deps = {}) {
  const fetchImpl = deps.fetch || fetch;
  if (!env.STRIPE_SECRET_KEY) throw new HttpError(500, 'server_error', { message: 'Stripe is not configured' });
  const init = {
    method,
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}`, 'stripe-version': '2024-06-20' },
  };
  let url = `${STRIPE_API}${path}`;
  if (params && method === 'GET') url += `?${formEncode(params)}`;
  else if (params) {
    init.headers['content-type'] = 'application/x-www-form-urlencoded';
    init.body = formEncode(params).toString();
  }
  const res = await fetchImpl(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new HttpError(502, 'server_error', { message: body?.error?.message || `Stripe ${res.status}` });
  return body;
}

const TOS_TEXT = {
  en: 'I accept the [licence terms]({licence}) and the [refund policy]({refunds}). I ask for immediate access to the download and understand that the 14-day withdrawal right ends once the track is available.',
  it: 'Accetto i [termini di licenza]({licence}) e la [politica di rimborso]({refunds}). Chiedo di accedere subito al download e so che il diritto di recesso di 14 giorni termina quando il tracciato è disponibile.',
};

export async function createCheckout(env, { trackId, type, lang, steamId }, deps = {}) {
  if (!isTrackId(trackId) || !isType(type)) throw new HttpError(400, 'bad_request');
  const row = await env.DB.prepare(
    `SELECT c.stripe_price_id, c.active AS c_active, t.active AS t_active, t.r2_key
     FROM catalog c JOIN tracks t ON t.track_id = c.track_id
     WHERE c.track_id = ?1 AND c.type = ?2`,
  ).bind(trackId, type).first();
  if (!row || !row.t_active || !row.c_active || !row.r2_key) throw new HttpError(409, 'track_unavailable');
  if (!row.stripe_price_id) throw new HttpError(409, 'price_not_configured');

  const base = `${env.PUBLIC_ORIGIN}${lang === 'it' ? '/it' : ''}/store`;
  const metadata = { track_id: trackId, type, steam_id: steamId || '' };
  const params = {
    mode: 'payment',
    line_items: [{ price: row.stripe_price_id, quantity: 1 }],
    success_url: `${base}/account/?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${base}/${trackId}/?checkout=cancelled`,
    locale: lang === 'it' ? 'it' : 'en',
    client_reference_id: steamId || 'commercial',
    metadata,
    payment_intent_data: { metadata },
    automatic_tax: { enabled: env.STRIPE_TAX === 'off' ? undefined : 'true' },
    billing_address_collection: 'auto',
  };
  if (type === 'commercial') {
    params.tax_id_collection = { enabled: 'true' };
    params.invoice_creation = { enabled: 'true' };
  }
  if (env.REQUIRE_TOS_CONSENT !== 'false') {
    const l = lang === 'it' ? 'it' : 'en';
    const prefix = `${env.PUBLIC_ORIGIN}${l === 'it' ? '/it' : ''}/store`;
    params.consent_collection = { terms_of_service: 'required' };
    params.custom_text = {
      terms_of_service_acceptance: {
        message: TOS_TEXT[l].replace('{licence}', `${prefix}/licence/`).replace('{refunds}', `${prefix}/refunds/`),
      },
    };
  }
  const session = await stripeRequest(env, 'POST', '/checkout/sessions', params, deps);
  return session.url;
}

// ---------- webhook ----------

export async function verifyStripeSignature(secret, header, payload, toleranceSeconds = 300) {
  if (!secret || !header) return false;
  let t = null;
  const v1 = [];
  for (const part of header.split(',')) {
    const [k, v] = part.split('=');
    if (k === 't') t = v;
    if (k === 'v1' && v) v1.push(v);
  }
  if (!t || !v1.length) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - Number(t)) > toleranceSeconds) return false;
  const expected = await hmacHex(secret, `${t}.${payload}`);
  return v1.some((sig) => timingSafeEqual(sig, expected));
}

export async function handleWebhook(request, env, deps = {}) {
  const payload = await request.text();
  const ok = await verifyStripeSignature(env.STRIPE_WEBHOOK_SECRET, request.headers.get('stripe-signature'), payload);
  if (!ok) return json({ ok: false, error: 'bad_signature' }, 400);
  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return json({ ok: false, error: 'bad_request' }, 400);
  }
  const obj = event?.data?.object || {};
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded':
      return json({ ok: true, result: await grantFromSession(env, obj.id, deps) });
    case 'charge.refunded':
      return json({ ok: true, result: await markRefunded(env, obj) });
    case 'charge.dispute.created':
      return json({ ok: true, result: await markDisputed(env, obj) });
    default:
      return json({ ok: true, result: 'ignored' });
  }
}

export async function grantFromSession(env, sessionId, deps = {}) {
  if (typeof sessionId !== 'string' || !sessionId.startsWith('cs_')) return 'bad_session';
  const existing = await env.DB.prepare('SELECT licence_id FROM orders WHERE id = ?1').bind(sessionId).first();
  if (existing) return 'already_granted';

  // Never trust the webhook body for money: ask Stripe for the session again.
  const session = await stripeRequest(env, 'GET', `/checkout/sessions/${encodeURIComponent(sessionId)}`, { expand: ['line_items'] }, deps);
  if (session.mode !== 'payment') return 'not_payment';
  if (session.payment_status !== 'paid') return 'not_paid_yet';
  const trackId = session.metadata?.track_id;
  const type = session.metadata?.type;
  const steamId = session.metadata?.steam_id || null;
  if (!isTrackId(trackId) || !isType(type)) return 'bad_metadata';
  if (type === 'personal' && !/^7656119\d{10}$/.test(steamId || '')) return 'bad_metadata';

  const items = session.line_items?.data || [];
  if (items.length !== 1 || items[0].quantity !== 1) return 'bad_line_items';
  const paidPrice = items[0].price?.id;
  const cat = await env.DB.prepare('SELECT stripe_price_id, stripe_product_id, max_machines FROM catalog WHERE track_id = ?1 AND type = ?2')
    .bind(trackId, type).first();
  if (!cat || !cat.stripe_price_id || paidPrice !== cat.stripe_price_id) return 'price_mismatch';
  if (cat.stripe_product_id && items[0].price?.product && items[0].price.product !== cat.stripe_product_id) return 'product_mismatch';

  const now = nowIso();
  const licenceId = randomId('lic');
  let licenceKey = null;
  let keyHash = null;
  if (type === 'commercial') {
    licenceKey = newLicenceKey();
    keyHash = await hashLicenceKey(env, licenceKey);
  }

  // The order row is the idempotency lock: if two webhook deliveries race,
  // only one INSERT succeeds and only that one creates the licence.
  const order = await env.DB.prepare(
    `INSERT OR IGNORE INTO orders (id, payment_intent, steam_id, track_id, type, price_id, amount_total, currency, licence_id, licence_key_plain, created_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
  ).bind(sessionId, session.payment_intent || null, steamId, trackId, type, paidPrice, session.amount_total ?? null, session.currency ?? null, licenceId, licenceKey, now).run();
  if (!order.meta || order.meta.changes !== 1) return 'already_granted';

  await env.DB.prepare(
    `INSERT INTO licences (id, steam_id, track_id, type, max_machines, status, order_id, licence_key_hash, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'active', ?6, ?7, ?8, ?8)`,
  ).bind(licenceId, type === 'personal' ? steamId : null, trackId, type, cat.max_machines, sessionId, keyHash, now).run();

  const email = session.customer_details?.email;
  if (email && deps.sendEmail !== false) {
    await sendLicenceEmail(env, { email, trackId, type, licenceId, licenceKey, lang: session.locale === 'it' ? 'it' : 'en' }, deps).catch(() => {});
  }
  return 'granted';
}

async function ordersForCharge(env, charge) {
  if (!charge?.payment_intent) return [];
  const rows = await env.DB.prepare('SELECT licence_id FROM orders WHERE payment_intent = ?1').bind(charge.payment_intent).all();
  return rows.results || [];
}

export async function markRefunded(env, charge) {
  // Only a full refund revokes. Partial refunds (goodwill discounts) keep the licence.
  if (!charge?.refunded) return 'partial_refund_ignored';
  const rows = await ordersForCharge(env, charge);
  for (const r of rows) {
    await env.DB.prepare(`UPDATE licences SET status = 'refunded', updated_at = ?2 WHERE id = ?1`).bind(r.licence_id, nowIso()).run();
  }
  return rows.length ? 'refunded' : 'no_order';
}

export async function markDisputed(env, dispute) {
  const rows = await ordersForCharge(env, { payment_intent: dispute?.payment_intent });
  for (const r of rows) {
    await env.DB.prepare(`UPDATE licences SET status = 'disabled', updated_at = ?2 WHERE id = ?1 AND status = 'active'`).bind(r.licence_id, nowIso()).run();
  }
  return rows.length ? 'disabled' : 'no_order';
}

// ---------- email (optional) ----------

// TODO(owner): choose an email provider. This uses Resend's HTTP API when
// RESEND_API_KEY and EMAIL_FROM are set; otherwise licence emails are skipped
// and buyers rely on the Stripe receipt plus the account page.
async function sendLicenceEmail(env, { email, trackId, type, licenceId, licenceKey, lang }, deps) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return;
  const fetchImpl = deps.fetch || fetch;
  const account = `${env.PUBLIC_ORIGIN}${lang === 'it' ? '/it' : ''}/store/account/`;
  const lines = lang === 'it'
    ? [
        `Grazie per l'acquisto. La tua licenza ${type === 'commercial' ? 'commerciale' : 'personale'} per ${trackId} è attiva.`,
        `Codice licenza: ${licenceId}`,
        licenceKey ? `Chiave per le postazioni: ${licenceKey} (conservala, serve per accedere e attivare le macchine).` : '',
        `Scarica il tracciato da: ${account}`,
        'Per qualsiasi problema scrivi a hello@globalvisions.it.',
      ]
    : [
        `Thank you for your purchase. Your ${type} licence for ${trackId} is active.`,
        `Licence id: ${licenceId}`,
        licenceKey ? `Machine key: ${licenceKey} (keep it safe, you need it to sign in and activate machines).` : '',
        `Download the track from: ${account}`,
        'If anything goes wrong, write to hello@globalvisions.it.',
      ];
  await fetchImpl('https://api.resend.com/emails', {
    method: 'POST',
    headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      from: env.EMAIL_FROM,
      to: [email],
      subject: lang === 'it' ? 'La tua licenza Global Visions' : 'Your Global Visions licence',
      text: lines.filter(Boolean).join('\n\n'),
    }),
  });
}
