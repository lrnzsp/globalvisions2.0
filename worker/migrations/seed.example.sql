-- TEMPLATE, do not run as is. Fill one block per track that is ready to sell.
-- Run with: npx wrangler d1 execute gv-store --remote --file migrations/seed.sql

-- TODO(owner): one row per track. folder = the Assetto Corsa folder name under
-- content/tracks/. r2_key = the clean build uploaded with:
--   npx wrangler r2 object put gv-tracks/tracks/<track_id>/<version>.zip --file <build.zip> --remote
-- zip_root: path of the track folder inside the zip; leave NULL when the zip
-- starts with content/tracks/<folder>/.
INSERT INTO tracks (track_id, name, folder, zip_root, r2_key, version, active) VALUES
  ('example-circuit', 'Example Circuit', 'gv_example', NULL, 'tracks/example-circuit/1.0.0.zip', '1.0.0', 0);

-- TODO(owner): Stripe product and price ids (live mode) per track and type.
-- The Worker only sells what is here and only grants a licence when the paid
-- price id matches. max_machines: personal 2, commercial according to the deal.
INSERT INTO catalog (track_id, type, stripe_product_id, stripe_price_id, max_machines, active) VALUES
  ('example-circuit', 'personal',   'prod_TODO', 'price_TODO', 2, 0),
  ('example-circuit', 'commercial', 'prod_TODO', 'price_TODO', 10, 0);

-- Go live for a track (after the circuit authorisation is on file):
-- UPDATE tracks SET active = 1 WHERE track_id = 'example-circuit';
-- UPDATE catalog SET active = 1 WHERE track_id = 'example-circuit';
