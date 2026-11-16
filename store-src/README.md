# Store catalogue source

`tracks.json` is the source for every static store page. After editing it run:

```bash
node tools/build-store.mjs
```

and commit both `store-src/tracks.json` and the regenerated files under `store/`, `it/store/` and `sitemap.xml`.

## Fields

| Field | Notes |
|---|---|
| `track_id` | Slug, `[a-z0-9-]`. Must match `tracks.track_id` and `catalog.track_id` in D1. |
| `name`, `location`, `country` | Shown on cards and detail pages. `country` is ISO 3166 alpha-2. |
| `length_m`, `layouts` | Specs. |
| `summary`, `description` | `{ en, it }`. Description is an array of short paragraphs. |
| `screenshots`, `poster` | Site paths. Put images in `store/media/<track_id>/`. Prefer WebP or AVIF at 1600x900. |
| `video` | `{ "mp4": "<absolute URL>", "poster": "<path>" }` or `null`. Self-hosted only (for example a public R2 bucket), no YouTube embeds, so no third-party cookies. |
| `requirements` | `{ en, it }` one line. |
| `prices` | Display prices only. The price actually charged comes from Stripe through `catalog.stripe_price_id` in D1. Keep the two in sync. |
| `status` | `draft` (noindex, out of the sitemap, no prices shown, no buy button) or `available`. |

## TODO before launch

- TODO: replace `example-circuit` with the real list of tracks ready to sell.
- TODO: upload each clean build zip to R2 and fill `tracks.r2_key` and `tracks.folder` in D1.
- TODO: create the Stripe product and the two prices (personal, commercial) per track and put their ids in `catalog` in D1, not here.
- TODO: confirm the circuit authorisations (name, layout, logos) for every track before switching it to `available`.
- TODO: real screenshots and a short video per track.
