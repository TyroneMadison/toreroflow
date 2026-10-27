# Sunra carousels (Create > Carousels)

"Build it with Sunra" on the Carousels screen: type what the carousel should
be, pick platform, model and slide count, press **Build carousel**. The API
answers with a price in Sunra credits; **Approve and spend N credits** builds
every slide. Nothing is spent without that approval.

| Platform | Size | Ratio | Max slides |
| --- | --- | --- | --- |
| Instagram | 1080x1350 | 4:5 | 10 |
| TikTok | 1080x1920 | 9:16 | 20 |

## Models

`GET /carousels/sunra/models` lists every image model Sunra offers (GPT
Image, Nano Banana, FLUX and the rest): Sunra's `list_models`, image models
only, each priced with `estimate_cost`. The list is cached for an hour; a
failed fetch is not cached and answers 502.

```ts
{ models: Array<{ id: string; label: string; provider: string; creditsPerImage: number;
  supportedAspectRatios: string[]; supportedSizes: string[]; supportedResolutions: string[];
  maxRefImages: number }> }
```

Quote and generate take a `modelId` from that list. A model that lists aspect
ratios without the platform's (4:5 or 9:16) is refused at quote time.
Generate must send the quote's `modelId`, and is refused if Sunra stopped
offering it. Fractional credit prices round the quote up.

Until a catalog is wired with `setSunraCatalog({ listModels, estimateCost })`
at API startup, the list is the two observed prices in
`SUNRA_CREDITS_PER_IMAGE` (`packages/contracts/src/ideas.ts`):
nano-banana-2 at 7 credits a slide (default), nano-banana-pro at 14. The old
`SUNRA_PRICE_PER_IMAGE_USD` env var is gone; nothing reads it.

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

The generator receives `{ prompt, slides, platform, modelId, width, height,
aspectRatio }` and must return one image buffer per slide, in order. Whoever
wires it decides the key's env var name and puts the key in the server's
repo root `.env` only (never in git).

Endpoints: `GET /carousels/sunra/models`, `POST /sunra/carousel/quote`
(`{ brandId, prompt, platform, slides, modelId }`),
`POST /sunra/carousel/:quoteId/generate` (`{ "approved": true, "modelId": "..." }`),
`GET/PUT /sunra/settings`. Shapes: `packages/contracts/src/ideas.ts`.
