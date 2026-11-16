# Global Visions Track Store: shared contract

This file is the single source of truth that the front end (`store/`, `it/store/`),
the Cloudflare Worker (`worker/`), the AssettoServer plugin (`assettoserver-plugin/`)
and the in-game Lua integration (`csp-integration/`) all follow. Change it first,
then the code.

## 1. Topology

```
Browser ── https://globalvisions.it/store/...           static pages (Vercel)
        └─ https://globalvisions.it/api/store/*  ──►    Vercel rewrite (same origin, cookies work)
                                                        └─► Worker  ${STORE_API_ORIGIN}/*
Browser ── ${STORE_API_ORIGIN}/dl/:token                downloads go straight to the Worker,
                                                        never through Vercel (bandwidth)
Stripe  ── ${STORE_API_ORIGIN}/stripe/webhook
Game PC ── ${STORE_API_ORIGIN}/activate, /validate     (CSP Lua script inside the track)
Race srv── ${STORE_API_ORIGIN}/server/check            (AssettoServer plugin)
```

`STORE_API_ORIGIN` is the Worker's public origin, `https://api.globalvisions.it`
(a Cloudflare custom domain on the globalvisions.it zone). Every client reads it
from configuration, never hard-codes a workers.dev name.

The front end always calls the Worker through the same-origin prefix
`/api/store`, so `GET /me` from the browser is `GET /api/store/me`.

## 2. Identifiers

| Thing        | Format                                   | Example                       |
|--------------|------------------------------------------|-------------------------------|
| track_id     | lowercase slug, `[a-z0-9-]{2,48}`        | `example-circuit`             |
| licence id   | `lic_` + 24 base32 chars                 | `lic_k3m9x2...`               |
| machine id   | `mac_` + 24 base32 chars                 |                               |
| copy id      | `cp_` + 24 base32 chars (one per download)|                              |
| steam_id     | SteamID64, 17 digits, as a string        | `76561198000000000`           |
| machine_hash | client generated, 32 to 128 chars of `[A-Za-z0-9_-]`, opaque | |
| licence key  | commercial only, `GVC-XXXX-XXXX-XXXX-XXXX` (base32, no 0/O/1/I) | |
| type         | `personal` or `commercial`               |                               |
| status       | `active`, `refunded`, `disabled`         |                               |

Steam IDs are always strings in JSON (they exceed 2^53).

## 3. D1 schema (authoritative copy: `worker/migrations/0001_init.sql`)

- `tracks(track_id PK, name, folder, zip_root NULL, r2_key, version, active)`
  `folder` is the Assetto Corsa folder under `content/tracks/`. `zip_root` is the
  path of that folder inside the zip (NULL means `content/tracks/<folder>`).
  `r2_key` is the object key of the clean build zip in R2.
- `catalog(track_id, type, stripe_product_id, stripe_price_id, max_machines, active, PK(track_id, type))`
  The only place where Stripe ids are trusted from.
- `licences(id PK, steam_id NULL, track_id, type, max_machines, status, order_id,
   licence_key_hash NULL, last_release_at NULL, created_at, updated_at)`
  Personal: `steam_id` set. Commercial: `steam_id` NULL, `licence_key_hash` set.
- `machines(id PK, licence_id, machine_hash, first_seen, last_seen, released_at NULL,
   UNIQUE(licence_id, machine_hash))`
- `orders(id PK = Stripe Checkout Session id, payment_intent, steam_id NULL, track_id, type,
   price_id, amount_total, currency, licence_id, licence_key_plain NULL, created_at)`
  `licence_key_plain` holds a commercial key only until the buyer has seen it once.
- `downloads(id PK = copy id, licence_id, track_id, created_at)`
- `auth_nonces(nonce PK, created_at)` replay protection for Steam OpenID.
- `revocations(payment_intent PK, status, created_at)` refunds and disputes by payment
  intent, kept even if the licence does not exist yet (webhooks can arrive out of order).

Timestamps are ISO 8601 UTC strings.

## 4. Browser API (cookie `gv_session`, same origin via `/api/store`)

All responses are JSON `{ ok: true, ... }` or `{ ok: false, error: "<code>", message? }`.
State-changing calls are `POST` with a JSON body and must carry an `Origin` header
equal to `PUBLIC_ORIGIN` (the Worker rejects others with `bad_origin`).

| Method | Path | Body / query | Answer |
|---|---|---|---|
| GET  | `/auth/steam/login` | `?next=/store/account/&lang=en` | 302 to Steam |
| GET  | `/auth/steam/callback` | Steam OpenID params | sets cookie, 302 to `next` |
| POST | `/auth/logout` | `{}` | clears cookie |
| GET  | `/me` | | `{ signed_in, kind: "steam"\|"commercial"\|null, steam_id?, licence_ids? }` |
| GET  | `/licences` | | `{ licences: [Licence] }` for the session |
| POST | `/checkout` | `{ track_id, type, lang }` | `{ url }` Stripe Checkout URL. `personal` needs a Steam session (`error: "login_required"`). `commercial` does not. |
| GET  | `/checkout/result` | `?session_id=cs_...` | `{ status: "pending"\|"ready", licence_id?, type?, track_id?, licence_key? }` (`licence_key` is returned once, commercial only) |
| POST | `/downloads` | `{ licence_id }` | `{ url, expires_at, copy_id }`; `url` is absolute on `STORE_API_ORIGIN` |
| POST | `/machines/release` | `{ licence_id, machine_id }` | `{ ok }` or `error: "release_cooldown"` with `retry_at` |
| POST | `/commercial/login` | `{ licence_key }` | sets a commercial session |

`Licence` object:

```json
{
  "id": "lic_...", "track_id": "example-circuit", "track_name": "Example Circuit",
  "type": "personal", "status": "active", "max_machines": 2,
  "created_at": "2026-11-16T12:00:00Z",
  "machines": [{ "id": "mac_...", "first_seen": "...", "last_seen": "...", "active_now": true }],
  "release_available_at": null
}
```

Error codes the UI must handle: `login_required`, `not_found`, `not_owner`,
`licence_inactive`, `track_unavailable`, `price_not_configured`, `release_cooldown`,
`bad_origin`, `rate_limited`, `server_error`.

## 5. Download

`GET ${STORE_API_ORIGIN}/dl/:token` where `token` is an HMAC-signed, 15 minute token.
The Worker re-checks that the licence is active, then streams the R2 zip with one
extra entry appended, without recompressing the rest:

`<zip_root>/extension/gv_licence.ini` (by default `content/tracks/<folder>/extension/gv_licence.ini`)

```ini
[LICENCE]
LICENCE_ID=lic_...
COPY_ID=cp_...
TRACK_ID=example-circuit
TYPE=personal
ISSUED=2026-11-16T12:00:00Z
API=https://api.globalvisions.it
SIGNATURE=<base64url HMAC-SHA256 of the five lines above, key FINGERPRINT_SECRET>
```

The copy id is recorded in `downloads`, so a leaked build can be traced to its
licence from the admin view. The file carries no personal data.

## 6. Licence API (game client, no cookies, CORS `*`)

### POST /activate

```json
{ "track_id": "example-circuit", "machine_hash": "<opaque>",
  "licence_id": "lic_...",            // or
  "steam_id": "76561198000000000",    // personal, when the licence id is unknown
  "licence_key": "GVC-...." }         // commercial licences need the key
```

Answer `{ ok: true, token, expires_in: 3600, licence_id, next_check_in: 600 }` or
`{ ok: false, reason }`.

### POST /validate

```json
{ "token": "<from /activate>" }
```
or the same body as `/activate` (it then activates implicitly if the machine is
already registered, it never registers a new machine).

Answer `{ ok: true, next_check_in: 600 }` or `{ ok: false, reason }`.

Reasons: `no_licence`, `refunded`, `disabled`, `unknown_machine`, `machine_limit`,
`too_many_active`, `bad_token`, `expired_token`, `bad_request`, `rate_limited`.

Commercial venues: the download carries the licence id; the venue adds its
`GVC-...` key once per PC in `<zip_root>/extension/gv_licence_key.ini`
(`[LICENCE]` / `LICENCE_KEY=`), and the script sends it as `licence_key`.

Rules:
- A licence may have at most `max_machines` registered (not released) machines.
- A machine counts as "in use" when `last_seen` is within the last 15 minutes.
  `/validate` refuses with `too_many_active` if this machine would make the number
  of in-use machines exceed `max_machines`.
- Clients call `/validate` at load and then every `next_check_in` seconds. If the
  API cannot be reached the client keeps features on for a grace period
  (recommended 72 hours since the last success) so a server outage never punishes
  buyers.

## 7. Race server API

`POST ${STORE_API_ORIGIN}/server/check`, header `Authorization: Bearer <SERVER_KEY>`

```json
{ "steam_id": "76561198000000000", "track_id": "example-circuit" }
```

Answer `{ ok: true }` or `{ ok: false, reason: "no_licence" | "refunded" | "disabled" }`.
A commercial venue's own server can whitelist its machines locally instead.

## 8. Admin API (header `Authorization: Bearer <ADMIN_TOKEN>`)

| Method | Path | Answer |
|---|---|---|
| GET  | `/admin/licences?steam_id=&track_id=&status=&q=` | `{ licences: [Licence + order_id, steam_id] }` |
| POST | `/admin/licences/:id/revoke` | sets `disabled` |
| POST | `/admin/licences/:id/reactivate` | sets `active` |
| POST | `/admin/licences/:id/reset-machines` | releases every machine |
| GET  | `/admin/stats` | `{ tracks: [{ track_id, licences, active, refunded, downloads }] }` |
| GET  | `/admin/copies/:copy_id` | `{ copy_id, licence_id, steam_id, track_id, created_at }` |

## 9. Stripe

- Checkout Session: `mode=payment`, `automatic_tax[enabled]=true`,
  `client_reference_id` = steam_id (personal) or `commercial`,
  `metadata[track_id]`, `metadata[type]`, `metadata[steam_id]`,
  `consent_collection[terms_of_service]=required` with custom text that waives the
  EU withdrawal right for immediate digital delivery.
- Webhooks: `checkout.session.completed` (and `checkout.session.async_payment_succeeded`),
  `charge.refunded`, `charge.dispute.created`.
- The Worker verifies the `Stripe-Signature` header, then fetches the session's
  line items from Stripe and only grants a licence when the single line item's
  `price.id` equals `catalog.stripe_price_id` for the session's `track_id` and `type`.
- Orders are idempotent on the Checkout Session id.
