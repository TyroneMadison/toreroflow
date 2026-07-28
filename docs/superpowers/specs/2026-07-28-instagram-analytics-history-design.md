# Instagram analytics history: the full-history pull and the rolling store

Date: 2026-07-28
Status: approved
Source: "List of improvments for the app.md", item 5, including the two
Zernio support replies (Ana, then the follow-up) quoted inside it.

## Context

The analytics Videos tab ranks every video into view tiers (1M+,
100K-1M, 10K-100K). The boards already rank lifetime rather than the
selected range, but lifetime is only as deep as the data underneath, and
today that is secretly 90 days for Instagram:

- The only place the app calls Zernio's `GET /v1/analytics` is
  `packages/publishers/src/zernio.ts` `analytics()`, and it passes only
  `limit` and `page`. Zernio's `fromDate` defaults to 90 days ago when
  omitted.
- Per-post view counts for provider-discovered posts are never
  persisted. Every screen load re-fetches them live. The only durable
  per-post store is `ExternalVideo`, written solely by the YouTube
  catalogue sync.

Zernio support confirmed:

- `fromDate` unlocks history. Max range 366 days per request; older
  history is fetched by windowing year-by-year `fromDate`/`toDate`
  pairs. Plain-date format, e.g. `fromDate=2025-07-27`. Docs:
  https://docs.zernio.com/analytics/get-analytics
- Instagram (examplemotors) is complete on their side: 452 posts back to
  2025-07-26. The 136 the app saw was purely the `fromDate` default.
- YouTube external discovery is capped at roughly the 200 most recent
  videos on their side, permanently (203 stored vs 481 on the channel).
  Not fixable by re-sync.
- Their historical sync covers 365 days. Lifetime history is not
  something they can serve on any platform: "you'll want to keep your
  own rolling store of what you pull from us."

Tyrone chose Option C: the full-history pull plus a rolling store, and a
daily per-video metric row, so future features (views-over-time charts,
a live all-client view counter on torerone.com) accumulate history from
day one. Neither future feature is built now; the counter also waits on
the hosted-backend decision (backlog conflict C3).

## Decisions

- **All platforms except YouTube persist from the Zernio pull.** YouTube
  keeps its direct Data API sync, which already fetches the full channel
  (481 videos) and is both deeper and fresher than Zernio's capped copy.
  Persisting Zernio's YouTube rows would fight it over the same
  `[socialAccountId, platformVideoId]` key.
- **`ExternalVideo` is the rolling store.** It was built
  platform-agnostic and the read paths already merge it for every
  platform; YouTube just got there first. Ingest only ever adds or
  updates rows, never deletes, so a bad network day cannot erase
  history.
- **One write path.** A single upsert helper writes an `ExternalVideo`
  row and its daily metric row together. The Zernio persist, the API's
  YouTube sync, and the worker's YouTube catalogue refresh all call it.
  It lives in `packages/db` (both processes already depend on it) and
  takes the `PrismaClient` as an argument.
- **New model `ExternalVideoMetric`**: one row per video per UTC
  calendar day, holding that day's views, likes, and comments. A second
  run on the same day overwrites the day's row via an upsert on
  `[externalVideoId, capturedOn]`, so boot catch-up, the daily job, and
  manual refreshes can never duplicate. Written for every stored video,
  YouTube included. Nothing reads it yet, on purpose.
- **The worker owns all Zernio persistence.** Its `ingestAnalytics()`
  switches to the windowed history fetch and persists before doing its
  existing rollups. The Analytics screen's Refresh button and the
  reports refresh already enqueue that same ingest job, so both trigger
  the full persist with no new wiring.
- **The persist sees every fetched post.** The worker's existing
  200-day horizon trim exists for `MetricSnapshot` day-bucketing only;
  the persist runs on the untrimmed list.
- **Windowing walks backwards** in 366-day steps from today, stopping at
  the first empty window, with a hard cap of 10 windows as a runaway
  guard. Windows are contiguous; because writes are upserts, an
  accidental overlap would be harmless.
- **Merge preference is platform-aware.** For YouTube, stored catalogue
  rows keep superseding provider copies (current behavior; the direct
  API data is richer). For every other platform, a live provider post
  wins over its stored row, because live is fresher and carries shares
  and watch time that the store does not. Stored rows fill in only the
  posts the live 90-day fetch no longer reaches.
- **The duplicated merge is collapsed.** The inline copy of the merge in
  `apps/api/src/routes/clients.ts` (the `/analytics/posts` route) is
  replaced by a call to `buildMergedPosts`, which also fixes the drift
  already present (`decodeEscapes` on titles, missing `platformKey` on
  external rows).
- **No UI changes.** The boards, the 30/60/90/All chips, and the
  platform tabs stay exactly as they are; they simply see deeper data.
  Screen loads stay fast: the live fetch remains the 90-day default,
  history comes from the store.

## Design

### 1. Windowed history fetch

`packages/publishers/src/zernio.ts`:

- `analytics()` gains optional `fromDate`/`toDate` params, appended to
  the query string as plain `YYYY-MM-DD` dates. Existing pagination
  (100 per page, up to 10 pages) is unchanged.
- A pure exported `historyWindows(today: Date, maxWindows = 10)` returns
  `{ fromDate, toDate }` pairs walking backwards in contiguous 366-day
  steps, newest window first.
- A new `analyticsHistory()` iterates those windows, calling
  `analytics()` per window, concatenating results, and stopping early at
  the first window that returns zero posts.

### 2. The write path

A new `packages/db/src/externalStore.ts` (exported from the package
index):

- `upsertExternalVideo(prisma, row)`: upserts on
  `[socialAccountId, platformVideoId]`, updating title, thumbnailUrl,
  url, publishedAt, views, likes, comments, durationSec, and fetchedAt,
  then upserts the video's `ExternalVideoMetric` row for today's UTC
  date. Every writer of `ExternalVideo` goes through this function.
- `persistProviderPosts(prisma, posts, accountsByProviderId)`: maps
  Zernio analytics entries to rows. For each post, each `platforms[]`
  entry whose `accountId` resolves to a `SocialAccount.providerAccountId`
  becomes one row, skipping `platform === "youtube"`. Field mapping
  follows the existing merge conventions: `platformVideoId` is the
  entry's `platformPostId` (entries without one are skipped),
  title is the decoded trimmed `content` else "(untitled)", metrics use
  the established first-match name lists (`views`/`impressions`/`plays`,
  entry-level analytics preferred with post-level fallback), publishedAt
  from `publishedAt` else `scheduledFor`, and url from
  `platformPostUrl`.
- The existing YouTube writers (`apps/api/src/analytics/youtubeSync.ts`
  and the worker's `refreshYouTubeCatalogues`) swap their hand-rolled
  upserts for `upsertExternalVideo`, which is how YouTube videos get
  their daily metric rows.

### 3. The `ExternalVideoMetric` model

`packages/db/prisma/schema.prisma`, migrated with hand-written SQL and
`migrate:deploy` (this environment's rule; `prisma generate` needs the
API and worker stopped first):

```prisma
model ExternalVideoMetric {
  id              String   @id @default(cuid())
  externalVideoId String
  /// UTC calendar date of the capture; one row per video per day.
  capturedOn      DateTime @db.Date
  views           Int      @default(0)
  likes           Int      @default(0)
  comments        Int      @default(0)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  externalVideo ExternalVideo @relation(fields: [externalVideoId], references: [id], onDelete: Cascade)

  @@unique([externalVideoId, capturedOn])
}
```

### 4. Ingest wiring

`apps/worker/src/index.ts` `ingestAnalytics()`:

- Replaces its `zernio.analytics(500)` call with `analyticsHistory()`.
- Immediately persists via `persistProviderPosts` using its existing
  provider-account map, before the 200-day horizon trim and the
  `MetricSnapshot`/`PostMetric` work, which continue unchanged on the
  data they use today.
- A window fetch failure stops the walk, and the run continues with the
  windows already fetched. Since writes are upserts and ingest never
  deletes, a partial run can only refresh less, never lose data. The
  job-level error handling already in place is untouched; ingest still
  never throws past its guards.

No trigger changes: the daily scheduler, the boot catch-up,
`POST /clients/:id/analytics/refresh`, and the reports refresh all
already run this job.

### 5. The read path

- `apps/api/src/routes/clients.ts` `/clients/:id/analytics/posts` drops
  its inline merge (about a hundred lines) and calls `buildMergedPosts`,
  keeping its cache and response shape.
- In `apps/api/src/analytics/mergedPosts.ts`, the external-supersede
  block becomes platform-aware per the merge-preference decision: for
  non-YouTube rows, when a live provider post carries the same
  `platform:platformVideoId` key, the stored row is dropped instead of
  the live post. The supersede decision is extracted as a small pure
  function so it can carry a check.
- Everything downstream (`viewTiers.ts`, `AnalyticsScreen`, reports) is
  untouched and simply sees deeper history. Instagram rows arriving from
  the store carry `lifetime: true` like YouTube rows do today.

### 6. Checks

Repo convention: no framework, `assert`-style `.check.ts` run under
`tsx`, one per module of logic.

- `historyWindows`: spans never exceed 366 days, windows are contiguous
  with no gaps, newest first, cap honored.
- The Zernio-to-row mapping: a fake analytics entry maps to the expected
  fields; YouTube entries are skipped; entries with unknown `accountId`
  or missing `platformPostId` are skipped; the "(untitled)" fallback
  applies.
- The UTC day bucket: times across a day collapse to one `capturedOn`
  date; the day boundary lands on UTC midnight.
- The merge supersede rule: YouTube keeps the stored row, other
  platforms keep the live post.

`packages/db` gains a `test` script for its checks, matching the other
packages.

## Out of scope, recorded so it is not lost

- Any UI reading `ExternalVideoMetric` (views-over-time charts). The
  series accumulates from ship day; past days cannot be reconstructed.
- The torerone.com live view counter (needs the C3 hosted-backend
  decision first).
- Instagram history older than 2025-07-26. Zernio never had it; no one
  can fetch it.
- Thumbnail longevity: stored Instagram thumbnail URLs die on Meta's CDN
  within days once a post ages past Zernio's window and stops being
  re-fetched. The tier boards render no thumbnails, so nothing visible
  breaks today; if a future surface needs old thumbnails, cache the
  images locally then.
- Instagram stories land in the store like any other post. Their view
  counts sit far below the 10K tier floor, so they never surface on the
  boards; filtering them out is not worth code until something shows
  them.

## Verification

On the installed app with the full stack running:

1. Note the Videos tab totals for Northstar before the change, then refresh.
   The Instagram post population should rise from about 136 to about
   452, and the tier boards should hold genuinely all-time rankings.
2. In the database: `ExternalVideo` holds about 452 `instagram` rows;
   `ExternalVideoMetric` holds one row per stored video for today.
   Refresh again the same day: the metric row count does not grow.
3. The 30/60/90/All chips still filter the non-board sections, now over
   the full history.
4. Rebuild a client report: the report's numbers agree with the screen
   (the collapsed merge proof).
5. `pnpm --filter` checks pass for publishers, api, desktop, and db, and
   all seven workspace projects typecheck.
