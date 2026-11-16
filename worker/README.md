# gv-store: Cloudflare Worker for the Global Visions track store

Steam sign in, Stripe Checkout, licences in D1, fingerprinted downloads from R2,
the licence API used by the in-game script and by AssettoServer, and the admin API.
The full contract is in [`docs/store/CONTRACT.md`](../docs/store/CONTRACT.md).

Already created on the Cloudflare account:

| Resource | Name | Notes |
|---|---|---|
| D1 database | `gv-store` (`37889644-30f6-4420-93f1-8327da52baeb`), Western Europe | schema from `migrations/0001_init.sql` already applied |
| R2 bucket | `gv-tracks` | empty, private |

The Worker itself is not deployed yet: that needs `wrangler` with your Cloudflare login.

## Deploy

```bash
cd worker
```

```bash
npm install
```

```bash
npx wrangler login
```

```bash
npx wrangler deploy
```

The first deploy prints the `*.workers.dev` URL. Put it in `STORE_API_ORIGIN`
in `wrangler.toml` and in the `/api/store` rewrite in the root `vercel.json`,
then deploy again.

### Secrets

Generate each random value with `openssl rand -base64 48` and set it with
`npx wrangler secret put NAME`:

| Secret | What it is |
|---|---|
| `SESSION_SECRET` | signs the session cookie and the Steam login state |
| `DOWNLOAD_SECRET` | signs the 15 minute download links |
| `LICENCE_TOKEN_SECRET` | signs the tokens returned by `/activate` |
| `FINGERPRINT_SECRET` | signs `gv_licence.ini` inside every download |
| `KEY_PEPPER` | hashes commercial licence keys. Never change it once keys exist |
| `STRIPE_SECRET_KEY` | live secret key of the Global Visions account. A restricted key with write access to Checkout Sessions and read access to Checkout Sessions is enough |
| `STRIPE_WEBHOOK_SECRET` | `whsec_...` of the webhook endpoint below |
| `ADMIN_TOKEN` | at least 32 characters, for `/store/admin/` |
| `SERVER_KEYS` | comma-separated keys, one per race server, at least 32 characters each |
| `RESEND_API_KEY`, `EMAIL_FROM` | optional, for licence emails. TODO(owner): choose the email provider |

`STEAM_API_KEY` is not needed: Steam OpenID returns the Steam ID without a key.
TODO(owner): add it only if we decide to check Steam ownership of Assetto Corsa server side.

## Stripe setup (live mode, account "Global Visions")

1. **Statement descriptor.** The account currently shows `INGLESE CORRETTO` on card statements.
   Change it to something like `GLOBAL VISIONS` in Settings > Business > Public details,
   otherwise buyers will not recognise the charge.
2. **Terms of Service URL** in the same page: `https://globalvisions.it/store/licence/`.
   Checkout asks the buyer to accept it and to waive the 14-day withdrawal right for
   immediate digital delivery (EU rule for digital content).
3. **Stripe Tax:** activate it, set the origin address (Sepapaja tn 6, Tallinn) and the
   tax registrations (Estonia, plus OSS for EU sales to consumers). Give each track product
   a digital goods tax code (TODO(owner): pick the code with your accountant).
4. **Products and prices:** one product per track with a personal price and a commercial
   price. TODO(owner): put the ids in `migrations/seed.sql` (copy `seed.example.sql`).
5. **Webhook endpoint:** `https://<STORE_API_ORIGIN>/stripe/webhook`, events
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `charge.refunded`, `charge.dispute.created`. Copy the signing secret into `STRIPE_WEBHOOK_SECRET`.

Note: the Stripe account also holds older products for other businesses (English
courses, the Inglese Corretto plans and two products created with the metadata
`created_by=caccabastarda2026`). The Worker ignores them: it only sells and grants
what is in the D1 `catalog` table.

## Adding a track

1. Package the build as a normal zip (under 4 GB, no ZIP64) whose paths start with
   `content/tracks/<folder>/`, or set `zip_root` to the folder path inside the zip.
2. Upload it: `npx wrangler r2 object put gv-tracks/tracks/<track_id>/<version>.zip --file build.zip --remote`
3. Add the rows in `migrations/seed.sql` and run it with
   `npx wrangler d1 execute gv-store --remote --file migrations/seed.sql`.
4. Add the track to `store-src/tracks.json`, run `node tools/build-store.mjs`, commit.
5. Only set `active = 1` once the circuit authorisation is on file. TODO(owner).

## Security notes

- Prices and products are read from D1, never from the browser. The webhook fetches
  the session again from Stripe and grants nothing unless the single paid line item's
  price id matches the catalog for that track and type.
- Webhook signatures are verified (HMAC SHA-256, 5 minute tolerance). Orders are
  idempotent on the Checkout Session id.
- Steam OpenID answers are checked field by field, re-verified with Steam
  (`check_authentication`), bound to the browser with a signed state cookie, and
  each nonce is accepted once.
- State-changing browser calls require `Origin: https://globalvisions.it` and a
  SameSite=Lax HttpOnly cookie.
- The public licence API is rate limited per hashed IP (60 requests per minute).
- Personal data kept: the Steam ID, an opaque machine hash, the Stripe ids of the order.
  Emails stay in Stripe.

## Tests

```bash
node --test test/*.test.mjs
```

The tests run the real Worker code against SQLite (Node 22 `node:sqlite`), an in-memory
R2 and fake Stripe and Steam servers: sign in, checkout, webhook signature and price
checks, idempotency, a fingerprinted zip validated with Python's `zipfile`, machine
limits, simultaneous use, release cooldown, refunds, disputes, commercial keys, admin
and rate limiting.
