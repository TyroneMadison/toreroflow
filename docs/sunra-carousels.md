# Sunra carousels (Create > Carousels)

"Build it with Sunra" on the Carousels screen: type what the carousel should
be, pick platform, model and slide count, press **Build carousel**. The API
answers with a price in Sunra credits; **Approve and spend N credits** builds
every slide. Nothing is spent without that approval.

| Platform | Size | Ratio | Max slides |
| --- | --- | --- | --- |
| Instagram | 1080x1350 | 4:5 | 10 |
| TikTok | 1080x1920 | 9:16 | 20 |

| Model | Credits per slide (observed) |
| --- | --- |
| nano-banana-2 (default) | 7 |
| nano-banana-pro | 14 |

Credit prices live in `SUNRA_CREDITS_PER_IMAGE` in
`packages/contracts/src/ideas.ts`. The old `SUNRA_PRICE_PER_IMAGE_USD` env var
is gone; nothing reads it.

## Safety

- Kill switch: "Sunra spending" (`PUT /sunra/settings`), per agency, OFF by
  default. OFF still prices; it refuses to build.
- A quote lasts 15 minutes and pays at most once (claimed atomically).
- Sunra returning fewer slides than approved is recorded as a failure.

## Env vars and wiring (human)

The Sunra integration in this codebase is the quote/approve/generate flow in
`apps/api/src/routes/sunra.ts`. It has no Sunra HTTP client and reads no
Sunra key from the environment, so there is no Sunra env var to set today.
Until a generator is wired with `setSunraGenerator(...)` at API startup,
`GET /sunra/settings` reports `connected: false` and building answers 503.

The generator receives `{ prompt, slides, platform, model, width, height,
aspectRatio }` and must return one image buffer per slide, in order. Whoever
wires it decides the key's env var name and puts the key in the server's
repo root `.env` only (never in git).

Endpoints: `POST /sunra/carousel/quote`, `POST /sunra/carousel/:quoteId/generate`
(`{ "approved": true }`), `GET/PUT /sunra/settings`.
