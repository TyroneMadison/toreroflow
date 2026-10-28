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

`GET /carousels/sunra/models` lists every Sunra model with a `text-to-image`
endpoint, each priced from its Sunra price card. The list is cached for an
hour; a failed fetch is not cached and answers 502.

```ts
{ models: Array<{ id: string; label: string; provider: string; creditsPerImage: number;
  supportedAspectRatios: string[]; supportedSizes: string[]; supportedResolutions: string[];
  maxRefImages: number }> }
```

With a key, `id` is Sunra's `owner/model` alias (e.g. `black-forest-labs/flux-1.1-pro`),
`provider` the owner, `label` the model name. Sunra's docs publish no
aspect-ratio or reference-image list per model, so those arrays stay empty
(not checked) and `maxRefImages` is 0.

Quote and generate take a `modelId` from that list. A model that lists aspect
ratios without the platform's (4:5 or 9:16) is refused at quote time.
Generate must send the quote's `modelId`, and is refused if Sunra stopped
offering it. Fractional credit prices round the quote up.

**Credits.** Sunra bills in USD. Quotes stay in credits, and one credit is one
US cent: a $0.045 image is 4.5 credits a slide. The price is the dearest row
of the model's card (or `freeze_amount` for usage-settled models), so the
quote is a ceiling, never an underestimate.

Without `SUNRA_API_KEY` the list is the two observed prices in
`SUNRA_CREDITS_PER_IMAGE` (`packages/contracts/src/ideas.ts`):
nano-banana-2 at 7 credits a slide (default), nano-banana-pro at 14.

## Safety

- Kill switch: "Sunra spending" (`PUT /sunra/settings`), per agency, OFF by
  default. OFF still prices; it refuses to build.
- A quote lasts 15 minutes and pays at most once (claimed atomically).
- Sunra returning fewer slides than approved is recorded as a failure.

## Env vars and wiring (human)

Set in the server's repo root `.env` only (never in git):

- `SUNRA_API_KEY`: the key from sunra.ai/dashboard/api-tokens. Unset keeps the
  observed model list, `GET /sunra/settings` reports `connected: false`, and
  building answers 503.
- `SUNRA_API_BASE`: optional, empty is `https://api.sunra.ai`.

The client is `apps/api/src/ideas/sunraClient.ts`. Each slide is one queued
`text-to-image` request (`{ prompt, aspect_ratio }`, the prompt suffixed with
"Slide i of n"), built one at a time so a failure stops spending. Polling backs
off from 1 s to 10 s; a slide not done in 5 minutes is cancelled and the
carousel fails. Every HTTP call times out after 30 s.

Sunra endpoints called: `GET /v1/models`, `GET /v1/pricing`,
`GET /v1/pricing/model/{model_id}/endpoint/text-to-image`,
`POST /v1/queue/{owner}/{model}/text-to-image`,
`GET /v1/queue/requests/{id}/status`, `GET /v1/queue/requests/{id}`,
`PUT /v1/queue/requests/{id}/cancel`, then a GET of each image URL.

Endpoints: `GET /carousels/sunra/models`, `POST /sunra/carousel/quote`
(`{ brandId, prompt, platform, slides, modelId }`),
`POST /sunra/carousel/:quoteId/generate` (`{ "approved": true, "modelId": "..." }`),
`GET/PUT /sunra/settings`. Shapes: `packages/contracts/src/ideas.ts`.
