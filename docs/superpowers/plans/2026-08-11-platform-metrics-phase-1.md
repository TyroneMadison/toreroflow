# Platform Metrics Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture and display every metric the publishing provider already sends and the app currently discards, across the Analytics tab, the client report page, and each card in the report's Video Breakdown.

**Architecture:** Seven new nullable columns on `ExternalVideo` and six on `ExternalVideoMetric` carry the fields Zernio sends but nothing reads. A widened capability matrix in `packages/core` decides, per platform, whether a metric is shown at all, so an unreported metric renders as absent rather than zero without migrating 1,682 historical rows. `buildMergedPosts` stays the single source both surfaces read, so the screen and the report cannot disagree.

**Tech Stack:** TypeScript, Prisma 6 on PostgreSQL, Fastify, React, hand-rolled inline SVG. No test framework: checks are `assert`-based `.check.ts` files run under `tsx`.

## Global Constraints

- **No em dashes and no en dashes** anywhere: code, comments, copy, commit messages. Use a comma, a period or a hyphen.
- **No AI attribution in commits.** No `Co-Authored-By`, no "Generated with" trailers. Tyrone's name only.
- **Never `git add -A` or `git add .`** Stage the exact files named in the step. A previous session swept personal photos into a commit this way.
- **No test framework may be added.** Checks are `assert`-based `.check.ts` files, registered in the owning package's `test` script.
- **Migrations are hand-written SQL plus `migrate:deploy`.** `prisma migrate dev` does not work here (non-interactive).
- **`prisma generate` fails with EPERM on Windows while the API or worker is running.** Stop them first.
- **An unmeasured metric is never rendered as zero.** It is absent. This is the property the whole phase exists to preserve.
- **Milliseconds to seconds happens exactly once**, in `mapProviderEntry`. Nowhere else.
- Commits stay local. Do not push.

---

## File Structure

**Created:**
- `packages/core/src/metricSeries.ts` plus `.check.ts` - pure math over daily metric rows
- `apps/desktop/src/lib/watchTime.ts` plus `.check.ts` - pure watch time totalling
- `packages/db/prisma/migrations/20260811120000_metric_depth/migration.sql`

**Modified:**
- `packages/core/src/platformMetrics.ts` plus `.check.ts` - the capability matrix
- `packages/db/prisma/schema.prisma` - new columns
- `packages/db/src/externalStore.ts` plus `.check.ts` - capture
- `apps/api/src/analytics/mergedPosts.ts` plus `.check.ts` - merge and carry
- `apps/api/src/reports/buildReportData.ts` - per-video fields and the series
- `assets/report-template.html` - strip placeholders, render the new set
- `apps/desktop/src/screens/AnalyticsScreen.tsx` - KPI fixes

**Deviation from the spec, deliberate:** section 4 of the spec calls for an
endpoint serving a video's day rows. Both consumers it names (the per-video
series and the period delta) are built inside `buildReportData`, which runs
server side and can query Prisma directly. No endpoint is built. If the
Analytics tab later wants per-video sparklines, add it then.

---

### Task 1: The capability matrix

**Files:**
- Modify: `packages/core/src/platformMetrics.ts`
- Test: `packages/core/src/platformMetrics.check.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `type MetricName`, `METRIC_REPORTED_BY: Record<MetricName, ReadonlySet<PlatformName>>`, `reportsMetric(metric: MetricName, platforms: readonly PlatformName[]): boolean`, `metricMeasurable(metric: MetricName, posts: readonly { platforms: readonly PlatformName[] }[]): boolean`. Existing `SAVES_REPORTED_BY`, `reportsSaves`, `savesMeasurable`, `followsMeasurable` keep working unchanged.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/platformMetrics.check.ts`, above the final
`console.log` line:

```ts
/* ---- the full matrix, measured 2026-08-11 over 800 posts ---- */

import { METRIC_REPORTED_BY, metricMeasurable, reportsMetric } from "./platformMetrics";

assert.ok(reportsMetric("views", ["tiktok"]), "every platform reports views");
assert.ok(reportsMetric("shares", ["tiktok"]), "tiktok reports shares, 57 of 238");
assert.ok(
  !reportsMetric("shares", ["youtube"]),
  "youtube shares are 0 of 243 through the provider, so a total would be a sum of unmeasured zeros",
);
assert.ok(!reportsMetric("reach", ["tiktok"]), "tiktok reach is 0 of 238");
assert.ok(reportsMetric("reach", ["facebook"]), "facebook reach is 40 of 40");
assert.ok(reportsMetric("clicks", ["facebook"]), "facebook clicks are 33 of 40");
assert.ok(!reportsMetric("clicks", ["instagram"]), "instagram clicks are 0 of 279");
assert.ok(
  !reportsMetric("impressions", ["instagram"]),
  "instagram impressions arrive but mirror views since Meta deprecated them, so showing both would print one number twice",
);
assert.ok(reportsMetric("impressions", ["facebook"]), "facebook impressions are 40 of 40");
assert.ok(reportsMetric("avgWatch", ["instagram"]), "instagram watch time is 274 of 279");
assert.ok(!reportsMetric("avgWatch", ["youtube"]), "no watch time through the provider");
assert.ok(reportsMetric("totalWatch", ["instagram"]), "instagram total watch is 274 of 279");

// follows is the one metric no platform serves. The set is empty on purpose,
// so every caller answers no without a special case.
assert.equal(METRIC_REPORTED_BY.follows.size, 0, "no platform reports follows");
assert.ok(!reportsMetric("follows", ["instagram", "tiktok", "youtube", "facebook"]), "nowhere");

// A cross-post needs one reporting platform for the number to mean something.
assert.ok(reportsMetric("saves", ["tiktok", "instagram"]), "one save-reporting platform is enough");
assert.ok(!reportsMetric("saves", ["tiktok", "youtube"]), "neither reports saves");

/* ---- across a set ---- */

assert.ok(metricMeasurable("reach", [TT, IG]), "a period containing instagram has reach");
assert.ok(!metricMeasurable("reach", [TT, YT]), "a tiktok and youtube period has none");
assert.ok(!metricMeasurable("reach", []), "an empty period measures nothing");

// The old helpers must keep agreeing with the new general one, because both
// are live and a disagreement would put a number on one surface and a dash on
// the other.
assert.equal(reportsMetric("saves", ["instagram"]), reportsSaves(["instagram"]), "agree on ig");
assert.equal(reportsMetric("saves", ["tiktok"]), reportsSaves(["tiktok"]), "agree on tiktok");
```

Move the new `import` line to join the existing import block at the top of the
file rather than leaving it mid-file.

- [ ] **Step 2: Run the check to verify it fails**

```bash
pnpm --filter @toreroflow/core exec tsx src/platformMetrics.check.ts
```

Expected: FAIL. TypeScript cannot resolve `METRIC_REPORTED_BY`, `reportsMetric`
or `metricMeasurable` from `./platformMetrics`.

- [ ] **Step 3: Write the implementation**

Append to `packages/core/src/platformMetrics.ts`:

```ts
/**
 * Every per-post metric the app can display, and which platforms actually
 * serve it.
 *
 * Measured 2026-08-11 against the live provider account: 800 posts, a full
 * year, all four platforms. The counts in the comments are nonzero/present out
 * of that platform's post count, so this is observation rather than what the
 * platforms claim in their documentation.
 *
 * A platform absent from a set means the number never arrives, so a total
 * built from it would be a sum of unmeasured zeros. Callers show nothing
 * rather than a zero. Add a platform the day a real value turns up for it.
 */
export type MetricName =
  | "views"
  | "likes"
  | "comments"
  | "shares"
  | "saves"
  | "reach"
  | "impressions"
  | "clicks"
  | "avgWatch"
  | "totalWatch"
  | "follows";

const ALL = ["facebook", "instagram", "tiktok", "youtube"] as const;

export const METRIC_REPORTED_BY: Record<MetricName, ReadonlySet<PlatformName>> = {
  // fb 37/40, ig 275/279, tt 238/238, yt 242/243
  views: new Set(ALL),
  // fb 39/40, ig 279/279, tt 237/238, yt 242/243
  likes: new Set(ALL),
  // fb 17/40, ig 155/279, tt 96/238, yt 154/243
  comments: new Set(ALL),
  // fb 18/40, ig 161/279, tt 57/238. YouTube is 0/243: the provider never
  // sends it, and YouTube's own share count needs the Analytics API.
  shares: new Set(["facebook", "instagram", "tiktok"]),
  // ig 185/279 only. See SAVES_REPORTED_BY above for why TikTok is excluded
  // despite having the button.
  saves: SAVES_REPORTED_BY,
  // fb 40/40, ig 275/279. TikTok and YouTube send nothing.
  reach: new Set(["facebook", "instagram"]),
  /*
   * Facebook only, deliberately, even though Instagram sends it on 275 of 279.
   * Meta deprecated impressions for Instagram media created after 2 July 2024
   * and the value now equals views, so surfacing it there would print the same
   * number twice under two names.
   */
  impressions: new Set(["facebook"]),
  // fb 33/40. Instagram sends the field and it is 0 on all 279.
  clicks: new Set(["facebook"]),
  // ig 274/279, from igReelsAvgWatchTime. Nothing else reports watch time.
  avgWatch: new Set(["instagram"]),
  // ig 274/279, from igReelsVideoViewTotalTime.
  totalWatch: new Set(["instagram"]),
  /*
   * Empty, and that is the finding. Followers gained is 0 on all 800 posts of
   * all four platforms. The provider carries the field and has never populated
   * it. Getting this needs a direct platform integration, see
   * docs/platform-capability-map.md. Callers get false without a special case.
   */
  follows: new Set(),
};

/** True when at least one of a post's platforms reports this metric. */
export function reportsMetric(
  metric: MetricName,
  platforms: readonly PlatformName[],
): boolean {
  const reporters = METRIC_REPORTED_BY[metric];
  return platforms.some((p) => reporters.has(p));
}

/**
 * True when this metric is worth showing at all across a set of posts.
 *
 * Nothing in the set is on a platform that reports it, so a total would be a
 * sum of unmeasured zeros. Callers show a dash, or leave the row out.
 */
export function metricMeasurable(
  metric: MetricName,
  posts: readonly { platforms: readonly PlatformName[] }[],
): boolean {
  return posts.some((p) => reportsMetric(metric, p.platforms));
}
```

- [ ] **Step 4: Run the check to verify it passes**

```bash
pnpm --filter @toreroflow/core exec tsx src/platformMetrics.check.ts
```

Expected: PASS, ending `platformMetrics.check.ts: ok`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/platformMetrics.ts packages/core/src/platformMetrics.check.ts
git commit -m "feat: one table saying which platform actually reports which number"
```

---

### Task 2: Schema and migration

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (model `ExternalVideo` at line 501, model `ExternalVideoMetric` at line 546)
- Create: `packages/db/prisma/migrations/20260811120000_metric_depth/migration.sql`

**Interfaces:**
- Consumes: nothing
- Produces: columns `impressions Int?`, `clicks Int?`, `avgWatchSec Float?`, `totalWatchSec Float?`, `engagementRate Float?`, `metricsUpdatedAt DateTime?`, `source String @default("zernio")` on `ExternalVideo`; the same six metric columns minus `source` on `ExternalVideoMetric`.

- [ ] **Step 1: Add the columns to the schema**

In `packages/db/prisma/schema.prisma`, inside `model ExternalVideo`, directly
after the `follows` field and its comment, insert:

```prisma
  /// Distinct from views and reach. Facebook only in practice: Meta deprecated
  /// it for Instagram media created after 2 July 2024 and the value now
  /// mirrors views there. Nullable because most rows will never have one.
  impressions      Int?
  /// Link and profile clicks. Facebook only; Instagram sends a flat 0.
  clicks           Int?
  /// Average seconds watched. Instagram only today. Stored rather than read
  /// live, because a post that ages out of the provider's rolling window used
  /// to lose its watch time permanently.
  avgWatchSec      Float?
  /// Total seconds watched across all viewers, replays included. The measured
  /// figure, as opposed to views multiplied by an average.
  totalWatchSec    Float?
  /// The provider's own engagement percentage. Stored for comparison only; the
  /// displayed figure stays our computation, because ours is defined.
  engagementRate   Float?
  /// When the provider last refreshed these numbers, so a report can say how
  /// fresh it is.
  metricsUpdatedAt DateTime?
  /// Which source produced this row: zernio or youtube today. Phases 2 and 3
  /// add instagram, tiktok and facebook without another migration.
  source           String   @default("zernio")
```

In `model ExternalVideoMetric`, directly after its `follows` field, insert:

```prisma
  impressions      Int?
  clicks           Int?
  avgWatchSec      Float?
  totalWatchSec    Float?
  engagementRate   Float?
  metricsUpdatedAt DateTime?
```

- [ ] **Step 2: Write the migration SQL**

Create `packages/db/prisma/migrations/20260811120000_metric_depth/migration.sql`:

```sql
-- The provider has been sending these on every pull and the app has been
-- discarding them. New nullable columns rather than widening the existing
-- ones: an existing metric column defaults to 0 across 1,682 rows, and
-- flipping it to nullable would leave every one of those zeros indistinguishable
-- from a real measurement of zero. New columns start with no history to
-- misrepresent.
ALTER TABLE "ExternalVideo" ADD COLUMN IF NOT EXISTS "impressions" INTEGER;
ALTER TABLE "ExternalVideo" ADD COLUMN IF NOT EXISTS "clicks" INTEGER;
ALTER TABLE "ExternalVideo" ADD COLUMN IF NOT EXISTS "avgWatchSec" DOUBLE PRECISION;
ALTER TABLE "ExternalVideo" ADD COLUMN IF NOT EXISTS "totalWatchSec" DOUBLE PRECISION;
ALTER TABLE "ExternalVideo" ADD COLUMN IF NOT EXISTS "engagementRate" DOUBLE PRECISION;
ALTER TABLE "ExternalVideo" ADD COLUMN IF NOT EXISTS "metricsUpdatedAt" TIMESTAMP(3);
ALTER TABLE "ExternalVideo" ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'zernio';

-- Existing YouTube rows came from our own catalogue sync, not the provider.
-- Labelling them correctly now means the per-field precedence rule in phase 2
-- has honest data to work from on day one.
UPDATE "ExternalVideo" SET "source" = 'youtube' WHERE "platform" = 'youtube';

-- The daily series carries the same fields, or the history for everything new
-- starts empty and the per-video charts have nothing to draw for months.
ALTER TABLE "ExternalVideoMetric" ADD COLUMN IF NOT EXISTS "impressions" INTEGER;
ALTER TABLE "ExternalVideoMetric" ADD COLUMN IF NOT EXISTS "clicks" INTEGER;
ALTER TABLE "ExternalVideoMetric" ADD COLUMN IF NOT EXISTS "avgWatchSec" DOUBLE PRECISION;
ALTER TABLE "ExternalVideoMetric" ADD COLUMN IF NOT EXISTS "totalWatchSec" DOUBLE PRECISION;
ALTER TABLE "ExternalVideoMetric" ADD COLUMN IF NOT EXISTS "engagementRate" DOUBLE PRECISION;
ALTER TABLE "ExternalVideoMetric" ADD COLUMN IF NOT EXISTS "metricsUpdatedAt" TIMESTAMP(3);
```

- [ ] **Step 3: Do NOT apply the migration by hand**

There is no local database to apply it to: Docker is not running and
`DATABASE_URL` points at `localhost:5432`. Production applies pending
migrations by itself, because `infra/api-entrypoint.sh` runs
`prisma migrate deploy` every time the API container starts. So this migration
lands on the next deploy with no manual step, and running `migrate:deploy` here
would only produce a connection error.

Write the SQL correctly and move on. Do not edit it after it has been deployed
once: Prisma records a checksum and a changed file fails the next startup.

- [ ] **Step 4: Regenerate the client and typecheck**

`prisma generate` reads the schema and needs no database. On Windows it fails
with EPERM while the API or worker holds the client, so close the "Toreroflow
API" and "Toreroflow worker" windows first if they are open.

```bash
pnpm --filter @toreroflow/db generate
pnpm --filter @toreroflow/db typecheck
```

Expected: both succeed, no output from typecheck.

- [ ] **Step 5: Commit**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations/20260811120000_metric_depth/migration.sql
git commit -m "feat: room for the numbers the provider was already sending"
```

---

### Task 3: Capture the fields in the store

**Files:**
- Modify: `packages/db/src/externalStore.ts`
- Test: `packages/db/src/externalStore.check.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks
- Produces: `ExternalVideoRow` gains optional `impressions`, `clicks`, `avgWatchSec`, `totalWatchSec`, `engagementRate`, `metricsUpdatedAt`, `source`. `mapProviderEntry` populates all seven. `upsertExternalVideo` writes them to both tables.

- [ ] **Step 1: Write the failing test**

Append to `packages/db/src/externalStore.check.ts`, above its final
`console.log`:

```ts
/* ---- the fields the app used to discard ---- */

const depthEntry = {
  platformPostId: "ig-depth-1",
  analytics: {
    views: 401,
    impressions: 401,
    reach: 306,
    likes: 20,
    comments: 0,
    shares: 1,
    saves: 2,
    clicks: 0,
    follows: 0,
    igReelsAvgWatchTime: 4948,
    igReelsVideoViewTotalTime: 1652782,
    videoDurationSeconds: 13,
    engagementRate: 5.74,
    lastUpdated: "2026-08-10 21:16:37",
  },
};
const depthPost = { publishedAt: "2026-08-01T00:00:00.000Z", content: "a reel" };
const depthRow = mapProviderEntry(depthPost, depthEntry, {
  socialAccountId: "acct-1",
  platform: "instagram" as never,
});

assert.ok(depthRow, "the entry maps");
assert.equal(depthRow.impressions, 401, "impressions are carried, not folded into views");
assert.equal(depthRow.clicks, 0, "a reported zero is a zero, not an absence");
assert.equal(depthRow.engagementRate, 5.74, "the provider figure is stored for comparison");

/*
 * Milliseconds to seconds, exactly once, here. 4948 ms on a 13 second video is
 * 4.9 seconds and 38% retention. A missed conversion renders as 4,948 seconds,
 * which is a 6,340% retention figure on a client's report.
 */
assert.equal(depthRow.avgWatchSec, 4.948, "average watch converts ms to seconds");
assert.equal(depthRow.totalWatchSec, 1652.782, "total watch converts ms to seconds");
assert.ok(
  depthRow.metricsUpdatedAt instanceof Date && !Number.isNaN(depthRow.metricsUpdatedAt.getTime()),
  "lastUpdated parses to a real date",
);
assert.equal(depthRow.source, "zernio", "a provider entry is labelled as one");

/*
 * Absent is not zero. A platform that never sends the field must yield null,
 * because a 0 would be displayed as a measurement.
 */
const bareEntry = { platformPostId: "tt-1", analytics: { views: 900, likes: 12 } };
const bareRow = mapProviderEntry(depthPost, bareEntry, {
  socialAccountId: "acct-2",
  platform: "tiktok" as never,
});
assert.ok(bareRow, "the tiktok entry maps");
assert.equal(bareRow.impressions, null, "tiktok sends no impressions, so null not 0");
assert.equal(bareRow.clicks, null, "tiktok sends no clicks");
assert.equal(bareRow.avgWatchSec, null, "tiktok sends no watch time");
assert.equal(bareRow.totalWatchSec, null, "tiktok sends no total watch time");
assert.equal(bareRow.engagementRate, null, "absent engagement rate is null");
assert.equal(bareRow.metricsUpdatedAt, null, "absent timestamp is null");
```

- [ ] **Step 2: Run the check to verify it fails**

```bash
pnpm --filter @toreroflow/db exec tsx src/externalStore.check.ts
```

Expected: FAIL, `depthRow.impressions` is `undefined` rather than `401`.

- [ ] **Step 3: Write the implementation**

In `packages/db/src/externalStore.ts`, add to the `ExternalVideoRow` interface,
after `follows?: number;`:

```ts
  /** Null when the platform does not report it. Never coerce to 0. */
  impressions?: number | null;
  clicks?: number | null;
  /** Seconds. Converted from the provider's milliseconds in mapProviderEntry. */
  avgWatchSec?: number | null;
  totalWatchSec?: number | null;
  engagementRate?: number | null;
  metricsUpdatedAt?: Date | null;
  /** zernio or youtube. Defaults to zernio at the database. */
  source?: string;
```

Add this helper directly below the existing `num` function:

```ts
/** The provider's "2026-08-10 21:16:37" to a Date, or null. */
function providerDate(v: unknown): Date | null {
  if (typeof v !== "string" || !v.trim()) return null;
  const d = new Date(v.replace(" ", "T") + (/[Zz]|[+-]\d\d:?\d\d$/.test(v) ? "" : "Z"));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Milliseconds to seconds, or null. The one place this conversion happens. */
function msToSec(ms: number | null): number | null {
  return ms != null && ms > 0 ? ms / 1000 : null;
}
```

In `mapProviderEntry`, add these seven properties to the returned object, after
`follows`.

These read `num(em, ...)` directly rather than going through the `metric()`
helper defined just above them. That helper falls back to the post total and an
even split across entries, which is right for a figure every platform reports
and wrong for one only some do: splitting an Instagram watch time across a
cross-post's TikTok sibling would invent a number TikTok never measured.

```ts
    impressions: num(em, "impressions"),
    clicks: num(em, "clicks"),
    avgWatchSec: msToSec(num(em, "igReelsAvgWatchTime")),
    totalWatchSec: msToSec(num(em, "igReelsVideoViewTotalTime")),
    engagementRate: num(em, "engagementRate"),
    metricsUpdatedAt: providerDate(em.lastUpdated ?? pm.lastUpdated),
    source: "zernio",
```

In `upsertExternalVideo`, replace the `data` object with:

```ts
  const data = {
    ...rest,
    mediaType: row.mediaType ?? "video",
    shares: row.shares ?? 0,
    saves: row.saves ?? 0,
    reach: row.reach ?? 0,
    follows: row.follows ?? 0,
    // The nullable set passes through untouched. No ?? 0 here, ever: that
    // would turn "this platform does not report it" into "it was zero".
    impressions: row.impressions ?? null,
    clicks: row.clicks ?? null,
    avgWatchSec: row.avgWatchSec ?? null,
    totalWatchSec: row.totalWatchSec ?? null,
    engagementRate: row.engagementRate ?? null,
    metricsUpdatedAt: row.metricsUpdatedAt ?? null,
    source: row.source ?? "zernio",
    fetchedAt: now,
  };
```

and replace the `metrics` object with:

```ts
  // ExternalVideoMetric has no source column: a day row is a measurement, and
  // which pipe delivered it is a property of the video, not of the day.
  const metrics = {
    views: data.views,
    likes: data.likes,
    comments: data.comments,
    shares: data.shares,
    saves: data.saves,
    reach: data.reach,
    follows: data.follows,
    impressions: data.impressions,
    clicks: data.clicks,
    avgWatchSec: data.avgWatchSec,
    totalWatchSec: data.totalWatchSec,
    engagementRate: data.engagementRate,
    metricsUpdatedAt: data.metricsUpdatedAt,
  };
```

Finally, in `apps/api/src/analytics/youtubeSync.ts` and in the
`upsertExternalVideo` call at `apps/worker/src/index.ts:189`, add
`source: "youtube",` to the object literal so YouTube rows label themselves.

- [ ] **Step 4: Run the check to verify it passes**

```bash
pnpm --filter @toreroflow/db test
```

Expected: PASS, all three db checks report ok.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/externalStore.ts packages/db/src/externalStore.check.ts apps/api/src/analytics/youtubeSync.ts apps/worker/src/index.ts
git commit -m "feat: stop throwing away the watch time the provider sends"
```

---

### Task 4: Carry the fields through the merge

**Files:**
- Modify: `apps/api/src/analytics/mergedPosts.ts`
- Test: `apps/api/src/analytics/mergedPosts.check.ts`

**Interfaces:**
- Consumes: `ExternalVideo` columns from Task 2
- Produces: `MergedPost` gains `impressions: number | null`, `clicks: number | null`, `totalWatchSec: number | null`, `metricsUpdatedAt: string | null`. `byPlatform` entries widen from `{ platform, views, accountId? }` to additionally carry `likes`, `comments`, `shares`, `saves`, `reach`, `impressions`, `clicks`, `avgWatchSec`, `totalWatchSec`, all `number | null` except `views`. `avgWatchSec` gains a stored fallback.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/src/analytics/mergedPosts.check.ts`, above its final
`console.log`:

```ts
/* ---- a stored row keeps the watch time it was captured with ---- */

import { storedWatchSec } from "./mergedPosts";

assert.equal(
  storedWatchSec(12.5, null),
  12.5,
  "the live figure wins while the post is still inside the provider window",
);
assert.equal(
  storedWatchSec(null, 9.25),
  9.25,
  "a post that has aged out of the window keeps the watch time captured when it was visible",
);
assert.equal(storedWatchSec(null, null), null, "neither source measured it, so nothing is shown");
assert.equal(storedWatchSec(0, 9.25), 9.25, "a zero live figure is not a measurement, so the store wins");
```

- [ ] **Step 2: Run the check to verify it fails**

```bash
pnpm --filter @toreroflow/api exec tsx src/analytics/mergedPosts.check.ts
```

Expected: FAIL, `storedWatchSec` is not exported from `./mergedPosts`.

- [ ] **Step 3: Write the implementation**

In `apps/api/src/analytics/mergedPosts.ts`, add after `keepStoredRow`:

```ts
/**
 * The watch time for a post, preferring the live provider figure.
 *
 * Watch time used to be read only off the live post, so an Instagram video
 * that aged out of the provider's rolling window lost it permanently. The
 * store now captures it, and this is the one rule that decides between them:
 * live is fresher, the store covers what live no longer reaches. A zero counts
 * as unmeasured, because no video anyone published was watched for zero
 * seconds by every viewer.
 */
export function storedWatchSec(live: number | null, stored: number | null): number | null {
  if (live != null && live > 0) return live;
  if (stored != null && stored > 0) return stored;
  return null;
}
```

Add to the `MergedPost` interface, after `follows`:

```ts
  /** Null when no platform on this post reports it. Never 0 as a stand-in. */
  impressions: number | null;
  clicks: number | null;
  /** Total seconds watched across all viewers, measured rather than derived. */
  totalWatchSec: number | null;
  /** When the provider last refreshed these figures, ISO, or null. */
  metricsUpdatedAt: string | null;
```

Replace the `byPlatform` field declaration with:

```ts
  /**
   * One entry per platform this post went to, carrying that platform's own
   * figures rather than just its view count. A cross-posted video can now show
   * what each platform actually did with it, and each entry is filtered
   * through the capability matrix by its consumer.
   */
  byPlatform: Array<{
    platform: string;
    views: number;
    accountId?: string;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    saves: number | null;
    reach: number | null;
    impressions: number | null;
    clicks: number | null;
    avgWatchSec: number | null;
    totalWatchSec: number | null;
  }>;
```

Replace the `byPlatform` construction inside the live loop with:

```ts
    const byPlatform = use.map((e) => {
      const em = (e.analytics ?? {}) as Record<string, unknown>;
      const entryViews = num(em, "views", "impressions", "plays");
      const platform =
        accountPlatform.get(e.accountId as string) ??
        (typeof e.platform === "string" ? e.platform : "unknown");
      const rowId = accountRowId.get(e.accountId as string);
      const ms = (name: string): number | null => {
        const v = num(em, name);
        return v != null && v > 0 ? v / 1000 : null;
      };
      return {
        platform,
        views: entryViews ?? (use.length === 1 ? views : Math.round(views / use.length)),
        ...(rowId ? { accountId: rowId } : {}),
        likes: num(em, "likes", "likeCount"),
        comments: num(em, "comments", "commentCount"),
        shares: num(em, "shares", "shareCount"),
        saves: num(em, "saves", "saved", "savedCount"),
        reach: num(em, "reach"),
        impressions: num(em, "impressions"),
        clicks: num(em, "clicks"),
        avgWatchSec: ms("igReelsAvgWatchTime"),
        totalWatchSec: ms("igReelsVideoViewTotalTime"),
      };
    });
```

Add to the live `posts.push({...})` literal, after `follows`:

```ts
      impressions: num(m, "impressions"),
      clicks: num(m, "clicks"),
      totalWatchSec: (() => {
        const t = num(m, "igReelsVideoViewTotalTime");
        return t != null && t > 0 ? t / 1000 : null;
      })(),
      metricsUpdatedAt:
        typeof m.lastUpdated === "string" && m.lastUpdated
          ? new Date(m.lastUpdated.replace(" ", "T") + "Z").toISOString()
          : null,
```

Extend the `external` query result type with the new columns:

```ts
    impressions: number | null;
    clicks: number | null;
    avgWatchSec: number | null;
    totalWatchSec: number | null;
    metricsUpdatedAt: Date | null;
```

and replace the stored-row mapping's `avgWatchSec: null,` line and add the rest:

```ts
        avgWatchSec: storedWatchSec(null, v.avgWatchSec),
        impressions: v.impressions,
        clicks: v.clicks,
        totalWatchSec: v.totalWatchSec,
        metricsUpdatedAt: v.metricsUpdatedAt ? v.metricsUpdatedAt.toISOString() : null,
```

and replace its `byPlatform` line with:

```ts
        byPlatform: [
          {
            platform: v.platform,
            views: v.views,
            accountId: v.socialAccountId,
            likes: v.likes,
            comments: v.comments,
            shares: v.shares,
            saves: v.saves,
            reach: v.reach,
            impressions: v.impressions,
            clicks: v.clicks,
            avgWatchSec: v.avgWatchSec,
            totalWatchSec: v.totalWatchSec,
          },
        ],
```

- [ ] **Step 4: Run the check and typecheck**

```bash
pnpm --filter @toreroflow/api test
pnpm --filter @toreroflow/api typecheck
```

Expected: both PASS. If typecheck complains about `byPlatform` consumers, the
Analytics screen reads `b.views` only and needs no change yet.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/analytics/mergedPosts.ts apps/api/src/analytics/mergedPosts.check.ts
git commit -m "feat: a cross-posted video can say what each platform did with it"
```

---

### Task 5: The daily series math

**Files:**
- Create: `packages/core/src/metricSeries.ts`
- Test: `packages/core/src/metricSeries.check.ts`
- Modify: `packages/core/src/index.ts`, `packages/core/package.json`

**Interfaces:**
- Consumes: nothing
- Produces: `interface DayPoint { capturedOn: string; views: number }`, `interface SeriesSummary { points: DayPoint[]; added: number | null; sinceTracking: boolean }`, `seriesSummary(rows: readonly DayPoint[], publishedAt: string, from: string, to: string): SeriesSummary`.

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/metricSeries.check.ts`:

```ts
import assert from "node:assert/strict";
import { seriesSummary } from "./metricSeries";

const rows = [
  { capturedOn: "2026-08-02", views: 100 },
  { capturedOn: "2026-08-04", views: 260 },
  { capturedOn: "2026-08-06", views: 310 },
];

/* ---- the delta ---- */

const s = seriesSummary(rows, "2026-08-01", "2026-08-01", "2026-08-31");
assert.equal(s.added, 210, "last captured day minus first, 310 - 100");
assert.equal(s.points.length, 3, "every captured day inside the window is a point");

/*
 * Fewer than two days is not a trend. One point cannot produce a delta, and
 * drawing a line through it would suggest a measurement that does not exist.
 */
assert.equal(seriesSummary([rows[0]!], "2026-08-01", "2026-08-01", "2026-08-31").added, null);
assert.equal(seriesSummary([], "2026-08-01", "2026-08-01", "2026-08-31").added, null);

/* ---- the window ---- */

const clipped = seriesSummary(rows, "2026-08-01", "2026-08-03", "2026-08-31");
assert.equal(clipped.added, 50, "only days inside the window count, 310 - 260");
assert.equal(clipped.points.length, 2, "the 08-02 row is outside the window");

/*
 * The honesty rule. Daily capture began after most videos were published, so
 * for those the delta is views since we started watching, not views since it
 * went up. The flag drives a different label, so the number is never read as
 * lifetime growth.
 */
assert.equal(
  seriesSummary(rows, "2026-07-01", "2026-08-01", "2026-08-31").sinceTracking,
  true,
  "published before the first captured day, so this is growth since tracking began",
);
assert.equal(
  seriesSummary(rows, "2026-08-02", "2026-08-01", "2026-08-31").sinceTracking,
  false,
  "captured from the day it was published, so the delta is the real lifetime growth",
);

/* ---- ordering is not assumed ---- */

const shuffled = [rows[2]!, rows[0]!, rows[1]!];
assert.equal(
  seriesSummary(shuffled, "2026-08-01", "2026-08-01", "2026-08-31").added,
  210,
  "rows arrive in whatever order the query returned them",
);

console.log("metricSeries.check.ts: ok");
```

- [ ] **Step 2: Run the check to verify it fails**

```bash
pnpm --filter @toreroflow/core exec tsx src/metricSeries.check.ts
```

Expected: FAIL, cannot find module `./metricSeries`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/metricSeries.ts`:

```ts
/**
 * Reading the daily metric history.
 *
 * ExternalVideoMetric has written one row per video per UTC day since it
 * shipped, and nothing has ever read it. This is the first reader: it turns
 * those rows into a line to draw and a "views added this period" figure, which
 * is a genuinely different fact from the lifetime total the cards have always
 * shown.
 */

/** One captured day. `capturedOn` is a YYYY-MM-DD UTC date. */
export interface DayPoint {
  capturedOn: string;
  views: number;
}

export interface SeriesSummary {
  /** Captured days inside the window, oldest first. */
  points: DayPoint[];
  /** Views gained across the window, or null with fewer than two days. */
  added: number | null;
  /**
   * True when the video was published before its first captured day, so the
   * delta measures growth since tracking began rather than since publication.
   * Callers label it differently, so the number is never read as lifetime.
   */
  sinceTracking: boolean;
}

/**
 * Summarise a video's captured days inside a window.
 *
 * Fewer than two points yields a null delta rather than zero: one measurement
 * is not a trend, and a zero would read as "this video stopped growing".
 */
export function seriesSummary(
  rows: readonly DayPoint[],
  publishedAt: string,
  from: string,
  to: string,
): SeriesSummary {
  const day = (iso: string) => iso.slice(0, 10);
  const lo = day(from);
  const hi = day(to);
  const points = rows
    .filter((r) => r.capturedOn >= lo && r.capturedOn <= hi)
    .slice()
    .sort((a, b) => (a.capturedOn < b.capturedOn ? -1 : 1));

  if (points.length < 2) {
    return { points, added: null, sinceTracking: false };
  }
  const first = points[0]!;
  const last = points[points.length - 1]!;
  return {
    points,
    added: last.views - first.views,
    sinceTracking: day(publishedAt) < first.capturedOn,
  };
}
```

- [ ] **Step 4: Register and run**

Add to `packages/core/src/index.ts`:

```ts
export * from "./metricSeries";
```

Append ` && tsx src/metricSeries.check.ts` to the `test` script in
`packages/core/package.json`.

```bash
pnpm --filter @toreroflow/core test
```

Expected: PASS, every core check reports ok including `metricSeries.check.ts: ok`.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/metricSeries.ts packages/core/src/metricSeries.check.ts packages/core/src/index.ts packages/core/package.json
git commit -m "feat: the daily history finally gets a reader"
```

---

### Task 6: The report's per-video data

**Files:**
- Modify: `apps/api/src/reports/buildReportData.ts`
- Create: `apps/api/src/reports/loadSeries.ts`
- Modify: `apps/api/src/routes/reports.ts:156` and `:211`

**Interfaces:**
- Consumes: `reportsMetric` and `MetricName` from Task 1, `seriesSummary` and `DayPoint` from Task 5, the widened `MergedPost` from Task 4
- Produces: `ReportPost` gains `platformKey?: string | null`, `impressions?: number | null`, `clicks?: number | null`, `totalWatchSec?: number | null`, and its `byPlatform` widens to the `MergedPost` shape. `BuildReportInput` gains `series?: Map<string, DayPoint[]>`. `ReportVideo` gains `reach`, `impressions`, `clicks`, `totalWatch` (all `string | null`), `viewsAdded: string | null`, `viewsAddedLabel: string`, `spark: number[]`, and `byPlatform: Array<{ platform: string; stats: Array<{ label: string; value: string }> }>`. `loadSeries(prisma, clientId): Promise<Map<string, DayPoint[]>>`.

**Note on shape:** `buildReportData` is synchronous and has no database access,
which is what makes it testable. That property is kept. The series is loaded by
the route and passed in, rather than queried inside.

- [ ] **Step 1: Widen ReportPost and the input**

In `apps/api/src/reports/buildReportData.ts`, replace the `byPlatform` line of
`ReportPost` and add the new optional fields:

```ts
  /** "platform:platformPostId", which is how a card finds its captured series. */
  platformKey?: string | null;
  /** Null when no platform on this post reports it. Never 0 as a stand-in. */
  impressions?: number | null;
  clicks?: number | null;
  /** Total seconds watched across all viewers, measured rather than derived. */
  totalWatchSec?: number | null;
  byPlatform: Array<{
    platform: string;
    views: number;
    accountId?: string;
    likes: number | null;
    comments: number | null;
    shares: number | null;
    saves: number | null;
    reach: number | null;
    impressions: number | null;
    clicks: number | null;
    avgWatchSec: number | null;
    totalWatchSec: number | null;
  }>;
```

Add to `BuildReportInput`, after `generatedAt?: Date;`:

```ts
  /**
   * Captured daily history, keyed "platform:platformPostId". Loaded by the
   * caller with loadSeries so this function stays synchronous and pure.
   * Absent means no series, which every card handles by drawing nothing.
   */
  series?: Map<string, DayPoint[]>;
```

and destructure it in the function body with a default:

```ts
  const series = input.series ?? new Map<string, DayPoint[]>();
```

- [ ] **Step 2: Add the fields to the ReportVideo interface**

In `apps/api/src/reports/buildReportData.ts`, replace the `ReportVideo`
interface docblock and body with:

```ts
/**
 * One card per video for the report's Video breakdown tab.
 *
 * Everything here is either measured or absent. A metric the card's platforms
 * do not report is null and renders as nothing at all: not a zero, and no
 * longer a sentence explaining the absence. The explanations were on every
 * card of every report and taught a client nothing.
 *
 * "Retention" is average watch over the video's length, which is the only
 * retention any platform we can reach reports. There is no per-second curve to
 * draw, so none is drawn.
 */
export interface ReportVideo {
  title: string;
  date: string;
  platforms: string[];
  thumb: string | null;
  url: string | null;
  views: string;
  likes: string;
  comments: string;
  /** Shares and reposts as the platforms report them: one number. */
  shares: string;
  /** Null when no platform on this post has a save button that reports. */
  saves: string | null;
  /** Null when no platform on this post reports it. */
  reach: string | null;
  impressions: string | null;
  clicks: string | null;
  /** Total time watched across all viewers, e.g. "27m 32s". */
  totalWatch: string | null;
  /** Engagement as a percentage of views, e.g. "4.2%". Null below 1 view. */
  engagement: string | null;
  /** 0-100, average watch over length. Null when either side is unreported. */
  watchPct: number | null;
  avgWatch: string;
  /** Views gained across the report window. Null with under two captured days. */
  viewsAdded: string | null;
  /** "this period" or "since we started tracking", per seriesSummary. */
  viewsAddedLabel: string;
  /** Raw view counts for the inline sparkline. Empty when there is no series. */
  spark: number[];
  /** One row per platform, for a video that went to more than one. */
  byPlatform: Array<{ platform: string; stats: Array<{ label: string; value: string }> }>;
  tips: string[];
}
```

- [ ] **Step 3: Write the per-video builder**

Replace the whole `buildVideos` function with:

```ts
/** Seconds to "27m 32s", or "1m 05s", or "9s". */
function fmtWatchTotal(sec: number): string {
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return `${m}m ${String(r).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/**
 * One metric on a card, or null when this post's platforms do not report it.
 *
 * Every optional figure goes through here, so the rule that an unmeasured
 * metric is absent rather than zero is applied in one place rather than at
 * each call site.
 */
function measured(
  metric: MetricName,
  platforms: readonly string[],
  value: number | null,
): string | null {
  if (!reportsMetric(metric, platforms)) return null;
  if (value == null) return null;
  return fmt(value);
}

/** The per-platform rows on a cross-posted video's card. */
function platformRows(p: ReportPost): ReportVideo["byPlatform"] {
  if (!p.byPlatform || p.byPlatform.length < 2) return [];
  return p.byPlatform.map((b) => {
    const only = [b.platform];
    const stats: Array<{ label: string; value: string }> = [
      { label: "Views", value: fmt(b.views) },
    ];
    const add = (label: string, metric: MetricName, value: number | null) => {
      const v = measured(metric, only, value);
      if (v) stats.push({ label, value: v });
    };
    add("Likes", "likes", b.likes);
    add("Comments", "comments", b.comments);
    add("Shares", "shares", b.shares);
    add("Saves", "saves", b.saves);
    add("Reach", "reach", b.reach);
    add("Impressions", "impressions", b.impressions);
    add("Clicks", "clicks", b.clicks);
    if (reportsMetric("totalWatch", only) && b.totalWatchSec != null) {
      stats.push({ label: "Watched", value: fmtWatchTotal(b.totalWatchSec) });
    }
    return { platform: PLATFORM_NAME[b.platform] ?? b.platform, stats };
  });
}

/** The Video breakdown tab: one card per video this period. */
function buildVideos(
  current: ReportPost[],
  series: Map<string, DayPoint[]>,
  from: string,
  to: string,
): ReportVideo[] {
  // Videos only: carousels have their own card and a still image has no
  // watch time for a "Video Breakdown" to break down.
  const vids = current.filter((p) => p.mediaType !== "carousel" && p.mediaType !== "image");
  const medViews = median(vids.map((p) => p.views));
  const engs = vids
    .filter((p) => p.views > 0)
    .map((p) => ((p.likes + p.comments + p.shares) / p.views) * 100);
  const avgEng = engs.length ? engs.reduce((a, b) => a + b, 0) / engs.length : 0;

  return [...vids]
    .sort((a, b) => b.views - a.views)
    .map((p) => {
      const eng = p.views > 0 ? ((p.likes + p.comments + p.shares) / p.views) * 100 : null;
      const watchPct =
        p.avgWatchSec && p.durationSec && p.durationSec > 0
          ? Math.min(100, Math.round((p.avgWatchSec / p.durationSec) * 100))
          : null;
      const sum = seriesSummary(series.get(p.platformKey ?? "") ?? [], p.publishedAt, from, to);
      return {
        title: p.title,
        date: new Date(p.publishedAt).toLocaleDateString("en-US", {
          month: "short",
          day: "numeric",
        }),
        platforms: p.platforms.map((x) => PLATFORM_NAME[x] ?? x),
        thumb: p.thumbnailUrl ?? null,
        url: p.url ?? null,
        views: fmt(p.views),
        likes: fmt(p.likes),
        comments: fmt(p.comments),
        shares: fmt(p.shares),
        saves: measured("saves", p.platforms, p.saves),
        reach: measured("reach", p.platforms, p.reach),
        impressions: measured("impressions", p.platforms, p.impressions ?? null),
        clicks: measured("clicks", p.platforms, p.clicks ?? null),
        totalWatch:
          reportsMetric("totalWatch", p.platforms) && p.totalWatchSec != null
            ? fmtWatchTotal(p.totalWatchSec)
            : null,
        engagement: eng != null ? `${eng.toFixed(1)}%` : null,
        watchPct,
        avgWatch: fmtDur(p.avgWatchSec),
        viewsAdded: sum.added != null ? fmt(sum.added) : null,
        viewsAddedLabel: sum.sinceTracking ? "since we started tracking" : "this period",
        spark: sum.points.map((pt) => pt.views),
        byPlatform: platformRows(p),
        tips: videoTips(p, medViews, avgEng),
      };
    });
}
```

- [ ] **Step 4: Wire the builder in**

Add `reportsMetric`, `seriesSummary`, `type MetricName` and `type DayPoint` to
the existing `@toreroflow/core` import at the top of the file. Do not add a
second import statement.

Change the call site inside the returned object literal from
`videos: buildVideos(current),` to:

```ts
    videos: buildVideos(current, series, periodStart.toISOString(), periodEnd.toISOString()),
```

- [ ] **Step 5: Write the series loader**

Create `apps/api/src/reports/loadSeries.ts`:

```ts
import type { DayPoint } from "@toreroflow/core";

/**
 * A client's captured daily history, keyed "platform:platformPostId".
 *
 * That key is the same one buildMergedPosts puts on every post, so a report
 * card finds its own series by identity rather than by matching titles or
 * dates. One query per report rather than one per card.
 *
 * ExternalVideoMetric has been accumulating a row per video per UTC day since
 * it shipped and this is its first reader.
 */
export async function loadSeries(
  prisma: {
    externalVideoMetric: { findMany(args: unknown): Promise<unknown[]> };
  },
  clientId: string,
): Promise<Map<string, DayPoint[]>> {
  const rows = (await prisma.externalVideoMetric.findMany({
    where: { externalVideo: { socialAccount: { clientId, deletedAt: null } } },
    select: {
      views: true,
      capturedOn: true,
      externalVideo: { select: { platform: true, platformVideoId: true } },
    },
    orderBy: { capturedOn: "asc" },
  })) as Array<{
    views: number;
    capturedOn: Date;
    externalVideo: { platform: string; platformVideoId: string };
  }>;

  const series = new Map<string, DayPoint[]>();
  for (const r of rows) {
    const key = `${r.externalVideo.platform}:${r.externalVideo.platformVideoId}`;
    const list = series.get(key) ?? [];
    list.push({ capturedOn: r.capturedOn.toISOString().slice(0, 10), views: r.views });
    series.set(key, list);
  }
  return series;
}
```

- [ ] **Step 6: Pass it from both route call sites**

In `apps/api/src/routes/reports.ts`, add `import { loadSeries } from "../reports/loadSeries";`
to the existing import block. Before each of the two `buildReportData({` calls
(around lines 156 and 211), add:

```ts
    const series = await loadSeries(prisma, client.id);
```

using whatever the surrounding scope already calls the Prisma instance and the
client row, and add `series,` to each `buildReportData({ ... })` object literal.

Also confirm the mapping from `MergedPost` to `ReportPost` in this file carries
the new fields through. If the route spreads the merged post directly, nothing
is needed. If it picks fields explicitly, add `platformKey`, `impressions`,
`clicks`, `totalWatchSec` and the widened `byPlatform` to the picked set.

- [ ] **Step 7: Typecheck**

```bash
pnpm --filter @toreroflow/api typecheck
pnpm --filter @toreroflow/api test
```

Expected: both clean.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/reports/buildReportData.ts apps/api/src/reports/loadSeries.ts apps/api/src/routes/reports.ts
git commit -m "feat: a report card carries every number its platforms measured"
```

---

### Task 7: The report template

**Files:**
- Modify: `assets/report-template.html`

**Interfaces:**
- Consumes: the `ReportVideo` shape from Task 6
- Produces: rendered cards. No exports.

- [ ] **Step 1: Delete the two placeholder blocks**

Replace `dialHTML` at line 765 so an unmeasured retention renders nothing:

```js
  /* The watch ring, when a platform measured it. Nothing at all when none did:
     a sentence explaining the absence appeared on every card of every report
     and told a client nothing they could act on. */
  function dialHTML(v) {
    if (v.watchPct == null) return '';
    var r = 26, c = 2 * Math.PI * r;
    var off = c * (1 - v.watchPct / 100);
    return '<div class="vdial">' +
      '<svg width="68" height="68" viewBox="0 0 68 68">' +
      '<circle cx="34" cy="34" r="' + r + '" fill="none" stroke="rgba(255,255,255,0.12)" stroke-width="7"/>' +
      '<circle cx="34" cy="34" r="' + r + '" fill="none" stroke="var(--coral)" stroke-width="7" stroke-linecap="round" ' +
      'stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '" transform="rotate(-90 34 34)"/>' +
      '<text x="34" y="39" text-anchor="middle" fill="#fff" font-size="15" font-weight="700">' + v.watchPct + '%</text>' +
      '</svg>' +
      '<div class="dtxt"><b>Retention.</b> The average viewer watched <b>' + v.watchPct + '%</b> of this video (' + v.avgWatch + ' of it), measured by the platforms themselves.</div>' +
      '</div>';
  }
```

- [ ] **Step 2: Rebuild the pills, the sparkline and the platform split**

Replace `videoCardHTML` entirely:

```js
  /* A metric pill, or nothing. Null means no platform on this post reports the
     number, and an absent pill is the honest rendering of that. */
  function pill(label, value) {
    return value == null || value === '' ? ''
      : '<div class="vpill"><b>' + esc(value) + '</b><span>' + esc(label) + '</span></div>';
  }

  /* Views over time, from the daily capture. Two points is the minimum that
     can honestly be called a line. */
  function sparkHTML(v) {
    var pts = v.spark || [];
    if (pts.length < 2) return '';
    var w = 100, h = 26;
    var lo = Math.min.apply(null, pts), hi = Math.max.apply(null, pts);
    var span = hi - lo || 1;
    var d = pts.map(function (p, i) {
      var x = (i / (pts.length - 1)) * w;
      var y = h - ((p - lo) / span) * h;
      return (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1);
    }).join(' ');
    var added = v.viewsAdded != null
      ? '<div class="sparklabel"><b>+' + esc(v.viewsAdded) + '</b> views ' + esc(v.viewsAddedLabel) + '</div>'
      : '';
    return '<div class="vspark">' +
      '<svg viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
      '<path d="' + d + '" fill="none" stroke="var(--coral)" stroke-width="2" ' +
      'vector-effect="non-scaling-stroke" stroke-linecap="round" stroke-linejoin="round"/>' +
      '</svg>' + added + '</div>';
  }

  /* One row per platform, only when the video went to more than one. */
  function splitHTML(v) {
    var rows = v.byPlatform || [];
    if (!rows.length) return '';
    return '<div class="vsplit"><div class="tt">Per platform</div>' +
      rows.map(function (r) {
        return '<div class="vsrow"><div class="vsname">' + esc(r.platform) + '</div>' +
          '<div class="vsstats">' + r.stats.map(function (s) {
            return '<span><b>' + esc(s.value) + '</b> ' + esc(s.label) + '</span>';
          }).join('') + '</div></div>';
      }).join('') + '</div>';
  }

  function videoCardHTML(v, i) {
    var pills =
      '<div class="vpills">' +
      pill('Views', v.views) +
      pill('Engagement', v.engagement) +
      pill('Likes', v.likes) +
      pill('Comments', v.comments) +
      pill('Shares & reposts', v.shares) +
      pill('Saves', v.saves) +
      pill('Reach', v.reach) +
      pill('Impressions', v.impressions) +
      pill('Link clicks', v.clicks) +
      pill('Total watched', v.totalWatch) +
      '</div>';
    var tips = v.tips && v.tips.length
      ? '<div class="vtips"><div class="tt">How to beat this one</div><ul>' +
        v.tips.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul></div>'
      : '';
    return '<div class="vcard" data-vi="' + i + '">' +
      (v.thumb ? '<div class="vbg" style="background-image:url(\'' + v.thumb + '\')"></div>' : '') +
      '<div class="vfrost"></div><div class="vtint"></div>' +
      '<div class="vbody">' +
      '<div class="vname">' + esc(v.title) + '</div>' +
      '<div class="vmeta">' + esc(v.date) + ' · ' + esc((v.platforms || []).join(', ')) + '</div>' +
      '<button type="button" class="vbtn">Expand</button>' +
      '</div>' +
      '<div class="vstats">' + pills + sparkHTML(v) + dialHTML(v) + splitHTML(v) + tips + '</div>' +
      '</div>';
  }
```

The `pill` helper escapes both label and value, which is why the label reads
`'Shares & reposts'` in plain text here rather than carrying an `&amp;` entity
that would double-escape into `&amp;amp;`.

- [ ] **Step 3: Add the styles**

After the `.vpill b{...}` rule near line 418, add:

```css
.vspark{margin-top:12px;}
.vspark svg{width:100%;height:26px;display:block;}
.vspark .sparklabel{font-size:10.5px;color:rgba(255,255,255,.72);margin-top:5px;}
.vspark .sparklabel b{color:#fff;font-weight:700;}
.vsplit{margin-top:14px;}
.vsplit .tt{font-size:10px;text-transform:uppercase;letter-spacing:.14em;
  color:rgba(255,255,255,.55);margin-bottom:7px;}
.vsrow{display:flex;gap:10px;align-items:baseline;padding:6px 0;
  border-top:1px solid rgba(255,255,255,.08);}
.vsname{flex:0 0 74px;font-size:11.5px;font-weight:600;color:#fff;}
.vsstats{display:flex;flex-wrap:wrap;gap:4px 12px;font-size:10.5px;
  color:rgba(255,255,255,.7);}
.vsstats b{color:#fff;font-weight:700;}
```

- [ ] **Step 4: Verify against a real report**

```bash
pnpm --filter @toreroflow/api test
```

Then regenerate one client report from the Reports screen and open the built
page. Confirm by eye: no "Not shared by any platform" pill anywhere, no
"do not report watch time" sentence anywhere, a TikTok-only card shows four or
five pills with no empty slots, an Instagram card shows saves, reach, total
watched and the ring.

- [ ] **Step 5: Commit**

```bash
git add assets/report-template.html
git commit -m "feat: video cards show what was measured and say nothing about what was not"
```

---

### Task 8: The Analytics tab

**Files:**
- Create: `apps/desktop/src/lib/watchTime.ts`
- Test: `apps/desktop/src/lib/watchTime.check.ts`
- Modify: `apps/desktop/src/screens/AnalyticsScreen.tsx:307-352`, `apps/desktop/package.json`

**Interfaces:**
- Consumes: `reportsMetric`, `metricMeasurable` from Task 1; the widened `MergedPost` from Task 4
- Produces: `watchHours(posts): number | null` in `apps/desktop/src/lib/watchTime.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/src/lib/watchTime.check.ts`:

```ts
import assert from "node:assert/strict";
import { watchHours } from "./watchTime";

const IG = {
  platforms: ["instagram"],
  views: 400,
  avgWatchSec: 5,
  totalWatchSec: 1800,
};
const TT = { platforms: ["tiktok"], views: 10000, avgWatchSec: null, totalWatchSec: null };

/*
 * The measured total wins. The screen used to compute views x avgWatchSec,
 * which is an estimate, while igReelsVideoViewTotalTime arrived on 274 of 279
 * Instagram posts and was discarded.
 */
assert.equal(watchHours([IG]), 0.5, "1800 measured seconds is half an hour");

/*
 * The bug this fixes. TikTok reports no watch time at all, and the old code
 * substituted the account-wide average, so 10,000 TikTok views inherited an
 * Instagram average and invented hours nobody measured.
 */
assert.equal(watchHours([TT]), null, "a platform that measures nothing contributes nothing");
assert.equal(
  watchHours([IG, TT]),
  0.5,
  "a mixed period counts only the posts whose platform measured it",
);

// Falls back to the estimate only when the post reports its own average.
assert.equal(
  watchHours([{ platforms: ["instagram"], views: 720, avgWatchSec: 10, totalWatchSec: null }]),
  2,
  "720 views x 10s is 7200 seconds, two hours",
);
assert.equal(watchHours([]), null, "an empty period measures nothing");

console.log("watchTime.check.ts: ok");
```

- [ ] **Step 2: Run the check to verify it fails**

```bash
pnpm --filter @toreroflow/desktop exec tsx src/lib/watchTime.check.ts
```

Expected: FAIL, cannot find module `./watchTime`.

- [ ] **Step 3: Write the implementation**

Create `apps/desktop/src/lib/watchTime.ts`:

```ts
import { reportsMetric } from "@toreroflow/core";

interface WatchPost {
  platforms: readonly string[];
  views: number;
  avgWatchSec: number | null;
  totalWatchSec: number | null;
}

/**
 * Hours watched across a set of posts, or null when nothing measured it.
 *
 * The previous version multiplied views by an average and, for any post
 * reporting no watch time, substituted the account-wide average. TikTok and
 * YouTube report none, so their views inherited an Instagram figure and the
 * KPI counted hours nobody ever measured.
 *
 * Now: the measured total where the platform reports one, the post's own
 * average times its views where it reports that instead, and nothing at all
 * otherwise. This makes the number smaller. The old one was wrong.
 */
export function watchHours(posts: readonly WatchPost[]): number | null {
  let seconds = 0;
  let measured = false;
  for (const p of posts) {
    if (reportsMetric("totalWatch", p.platforms) && p.totalWatchSec != null && p.totalWatchSec > 0) {
      seconds += p.totalWatchSec;
      measured = true;
      continue;
    }
    if (reportsMetric("avgWatch", p.platforms) && p.avgWatchSec != null && p.avgWatchSec > 0) {
      seconds += p.views * p.avgWatchSec;
      measured = true;
    }
  }
  return measured ? seconds / 3600 : null;
}
```

- [ ] **Step 4: Wire it into the screen**

In `apps/desktop/src/screens/AnalyticsScreen.tsx`, replace lines 308 to 312
(`fallbackWatch`, `watchSecKnown`, `watchHours`) with:

```tsx
  const hoursWatched = watchHours(all);
```

Update the KPI entry:

```tsx
    { label: "Watch time · hrs", value: hoursWatched != null ? fmt(hoursWatched) : "-" },
```

Replace the reach line so an unmeasurable period dashes rather than showing a
sum of zeros, and add the two new engagement figures:

```tsx
  const totalReach = all.reduce((s, p) => s + p.reach, 0);
  const reachMeasurable = metricMeasurable("reach", all);
  const totalImpressions = all.reduce((s, p) => s + (p.impressions ?? 0), 0);
  const impressionsMeasurable = metricMeasurable("impressions", all);
  const totalClicks = all.reduce((s, p) => s + (p.clicks ?? 0), 0);
  const clicksMeasurable = metricMeasurable("clicks", all);

  const engagement = [
    { label: "Saves", value: savablePosts.length ? fmt(totalSaves) : "-" },
    { label: "Comments", value: fmt(totalComments) },
    { label: "Shares", value: fmt(totalShares) },
    { label: "Reach", value: reachMeasurable ? fmt(totalReach) : "-" },
    { label: "Impressions", value: impressionsMeasurable ? fmt(totalImpressions) : "-" },
    { label: "Link clicks", value: clicksMeasurable ? fmt(totalClicks) : "-" },
  ];
```

Add `metricMeasurable` to the existing `@toreroflow/core` import on line 2, and
`import { watchHours } from "../lib/watchTime";` alongside the other lib imports.

- [ ] **Step 5: Run and commit**

Append ` && tsx src/lib/watchTime.check.ts` to the `test` script in
`apps/desktop/package.json`.

```bash
pnpm --filter @toreroflow/desktop test
pnpm --filter @toreroflow/desktop typecheck
```

Expected: both clean.

```bash
git add apps/desktop/src/lib/watchTime.ts apps/desktop/src/lib/watchTime.check.ts apps/desktop/src/screens/AnalyticsScreen.tsx apps/desktop/package.json
git commit -m "fix: watch time stops counting hours nobody measured"
```

---

## Final verification

- [ ] **All checks pass**

```bash
pnpm -r test
```

- [ ] **All seven projects typecheck**

```bash
pnpm -r typecheck
```

- [ ] **Live walk, after deploy**

The app is cloud-backed and there is no local stack, so this happens once the
branch is deployed and the API container has applied the migration on startup.
Until then the daily capture has written no rows for the new columns, so the
sparkline and the period delta will correctly render as nothing.

Confirm on the Analytics tab that Watch time shows a smaller number than before
and that a TikTok-only brand shows a dash rather than invented hours. Then
regenerate one client report and open the Video Breakdown: no placeholder copy
anywhere, an Instagram card dense with measured figures, a TikTok card sparse
but with no empty slots, and a cross-posted video showing its per-platform
split.

- [ ] **Tell Tyrone the watch time number dropped, and why.** It was overstated
  before. Finding that out from a client is worse than being told.
