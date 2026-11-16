-- Global Visions track store: initial schema.
-- Apply with: npx wrangler d1 migrations apply gv-store --remote

CREATE TABLE IF NOT EXISTS tracks (
  track_id   TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  folder     TEXT NOT NULL,          -- folder under content/tracks/ in Assetto Corsa
  zip_root   TEXT,                   -- path of the track folder inside the zip; NULL means content/tracks/<folder>
  r2_key     TEXT,                   -- clean build zip in R2, NULL until uploaded
  version    TEXT NOT NULL DEFAULT '1.0.0',
  active     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS catalog (
  track_id          TEXT NOT NULL REFERENCES tracks(track_id),
  type              TEXT NOT NULL CHECK (type IN ('personal', 'commercial')),
  stripe_product_id TEXT,
  stripe_price_id   TEXT,            -- the only trusted source of price ids
  max_machines      INTEGER NOT NULL,
  active            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (track_id, type)
);

CREATE TABLE IF NOT EXISTS licences (
  id                TEXT PRIMARY KEY,
  steam_id          TEXT,            -- personal licences only
  track_id          TEXT NOT NULL REFERENCES tracks(track_id),
  type              TEXT NOT NULL CHECK (type IN ('personal', 'commercial')),
  max_machines      INTEGER NOT NULL,
  status            TEXT NOT NULL CHECK (status IN ('active', 'refunded', 'disabled')),
  order_id          TEXT,
  licence_key_hash  TEXT,            -- commercial licences only
  last_release_at   TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_licences_steam ON licences(steam_id, track_id);
CREATE INDEX IF NOT EXISTS idx_licences_key ON licences(licence_key_hash);
CREATE INDEX IF NOT EXISTS idx_licences_order ON licences(order_id);

CREATE TABLE IF NOT EXISTS machines (
  id           TEXT PRIMARY KEY,
  licence_id   TEXT NOT NULL REFERENCES licences(id),
  machine_hash TEXT NOT NULL,
  first_seen   TEXT NOT NULL,
  last_seen    TEXT NOT NULL,
  released_at  TEXT,
  UNIQUE (licence_id, machine_hash)
);
CREATE INDEX IF NOT EXISTS idx_machines_licence ON machines(licence_id);

CREATE TABLE IF NOT EXISTS orders (
  id                 TEXT PRIMARY KEY,   -- Stripe Checkout Session id
  payment_intent     TEXT,
  steam_id           TEXT,
  track_id           TEXT NOT NULL,
  type               TEXT NOT NULL,
  price_id           TEXT NOT NULL,
  amount_total       INTEGER,
  currency           TEXT,
  licence_id         TEXT,
  licence_key_plain  TEXT,               -- commercial key, cleared once shown
  created_at         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_orders_pi ON orders(payment_intent);

CREATE TABLE IF NOT EXISTS downloads (
  id          TEXT PRIMARY KEY,          -- copy id embedded in the build
  licence_id  TEXT NOT NULL REFERENCES licences(id),
  track_id    TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_downloads_licence ON downloads(licence_id);
CREATE INDEX IF NOT EXISTS idx_downloads_track ON downloads(track_id);

CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce       TEXT PRIMARY KEY,
  created_at  TEXT NOT NULL
);

-- Simple fixed-window rate limiting for the public licence API.
CREATE TABLE IF NOT EXISTS rate_limits (
  bucket      TEXT PRIMARY KEY,
  count       INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);
