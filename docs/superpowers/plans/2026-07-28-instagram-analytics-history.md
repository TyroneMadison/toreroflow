# Instagram Analytics History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pull Zernio's full analytics history (year-windowed `fromDate`/`toDate`), keep a permanent rolling store of every provider-discovered post plus a daily per-video metric row, and feed the existing all-time view-tier boards through the one shared merge.

**Architecture:** The Zernio client learns date windows and a history walk. A new shared write helper in `packages/db` upserts `ExternalVideo` rows plus a new `ExternalVideoMetric` day row; the worker's daily ingest persists everything it fetches through it, and both YouTube writers switch to it. The read side gets a platform-aware supersede rule and the duplicated merge in `clients.ts` collapses onto `buildMergedPosts`. No UI changes.

**Tech Stack:** TypeScript, pnpm workspace, Prisma + PostgreSQL, BullMQ worker, Fastify API, `tsx`-run `.check.ts` files (no test framework, never add one).

**Spec:** `docs/superpowers/specs/2026-07-28-instagram-analytics-history-design.md`

## Global Constraints

- No em dashes anywhere: code, comments, docs, commit messages. Use commas, periods, or hyphens.
- Commits are local only, never push. No AI attribution: no `Co-Authored-By`, no "Generated with" lines. Tyrone Madison is the only author.
- No new runtime dependencies. The only package.json changes allowed are wiring existing workspace tools (`tsx`, `@types/node`, `@toreroflow/core`) into `packages/db` and extending `test` scripts.
- No test framework. Checks are `assert`-style `.check.ts` files run with `tsx`, ending with `console.log("<name>: all checks passed")`.
- `prisma migrate dev` does not work here (non-interactive). Migrations are hand-written SQL applied with `pnpm --filter @toreroflow/db migrate:deploy`.
- `prisma generate` fails with EPERM on Windows while the API or worker runs. Kill their windows first (commands in Task 1).
- Match surrounding code style: two-space indent, doc comments explaining why, defensive normalization of Zernio fields.
- The Zernio `GET /v1/analytics` date params are `fromDate` and `toDate`, plain `YYYY-MM-DD`, max 366-day inclusive range per request.

---

### Task 1: `ExternalVideoMetric` model and migration

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (the `ExternalVideo` model ends near line 424)
- Create: `packages/db/prisma/migrations/20260728120000_external_video_metric/migration.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: Prisma model `ExternalVideoMetric` with delegate `prisma.externalVideoMetric`, unique key `externalVideoId_capturedOn`, fields `{ id, externalVideoId, capturedOn (DATE), views, likes, comments, createdAt, updatedAt }`. Task 3 upserts through it.

- [ ] **Step 1: Add the model to the schema**

In `packages/db/prisma/schema.prisma`, add inside the `ExternalVideo` model, after its `socialAccount` relation line:

```prisma
  metrics ExternalVideoMetric[]
```

Then add this model directly below the `ExternalVideo` model:

```prisma
/// One row per external video per UTC day. Nothing reads this yet, on
/// purpose: it is the rolling history future views-over-time charts and
/// the site view counter draw from, accumulating from ship day.
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

- [ ] **Step 2: Write the migration SQL**

Create `packages/db/prisma/migrations/20260728120000_external_video_metric/migration.sql`:

```sql
-- Additive only: one metrics row per external video per UTC day, the
-- rolling view-count history that outlives Zernio's one-year window.
CREATE TABLE "ExternalVideoMetric" (
    "id" TEXT NOT NULL,
    "externalVideoId" TEXT NOT NULL,
    "capturedOn" DATE NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "comments" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalVideoMetric_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExternalVideoMetric_externalVideoId_capturedOn_key" ON "ExternalVideoMetric"("externalVideoId", "capturedOn");

ALTER TABLE "ExternalVideoMetric" ADD CONSTRAINT "ExternalVideoMetric_externalVideoId_fkey" FOREIGN KEY ("externalVideoId") REFERENCES "ExternalVideo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

- [ ] **Step 3: Apply the migration**

Postgres must be running (`docker ps` should show the postgres container; if the stack is down, run `start.cmd` from the repo root first, or bring up just Docker).

Run: `pnpm --filter @toreroflow/db migrate:deploy`
Expected: output ends with the new migration name and "applied".

- [ ] **Step 4: Regenerate the Prisma client**

The API and worker hold the client DLL open on Windows. Kill their windows first (each command may report no matching tasks; that is fine):

```bash
taskkill //F //T //FI "WINDOWTITLE eq Toreroflow API*"
taskkill //F //T //FI "WINDOWTITLE eq Toreroflow worker*"
```

(In PowerShell use single slashes: `taskkill /F /T /FI "WINDOWTITLE eq Toreroflow API*"`.)

Run: `pnpm --filter @toreroflow/db generate`
Expected: "Generated Prisma Client" with no EPERM. If EPERM persists, a node process still holds it: `taskkill //F //IM node.exe` is the sledgehammer, then regenerate.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @toreroflow/db typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations/20260728120000_external_video_metric/migration.sql
git commit -m "feat: external video metric model, one row per video per day"
```

---

### Task 2: Zernio windowed history fetch

**Files:**
- Modify: `packages/publishers/src/zernio.ts` (the `analytics()` method is at lines 110-129)
- Create: `packages/publishers/src/zernio.check.ts`
- Modify: `packages/publishers/package.json` (test script)

**Interfaces:**
- Consumes: nothing new.
- Produces: `historyWindows(today: Date, maxWindows?: number): Array<{ fromDate: string; toDate: string }>` (exported at module level, newest first, plain `YYYY-MM-DD` strings); `ZernioProvider.analytics(max?: number, fromDate?: string, toDate?: string)`; `ZernioProvider.analyticsHistory(maxWindows?: number): Promise<Array<Record<string, unknown>>>`. Task 5 calls `analyticsHistory()`.

- [ ] **Step 1: Write the failing check**

Create `packages/publishers/src/zernio.check.ts`:

```ts
// Guards the Zernio history windowing: a window over 366 days would be
// rejected by the API, a gap between windows would silently lose posts,
// and an unbounded walk would hammer the provider forever.
import assert from "node:assert/strict";
import { historyWindows } from "./zernio";

{
  const today = new Date(Date.UTC(2026, 6, 28)); // 2026-07-28
  const w = historyWindows(today);

  assert.equal(w.length, 10); // default cap
  assert.deepEqual(w[0], { fromDate: "2025-07-28", toDate: "2026-07-28" });

  // Contiguous: each window ends the day before the newer one starts.
  assert.equal(w[1].toDate, "2025-07-27");
  assert.equal(w[1].fromDate, "2024-07-27");

  const DAY = 86_400_000;
  for (const win of w) {
    const from = new Date(`${win.fromDate}T00:00:00.000Z`).getTime();
    const to = new Date(`${win.toDate}T00:00:00.000Z`).getTime();
    const inclusiveDays = (to - from) / DAY + 1;
    assert.ok(
      inclusiveDays <= 366,
      `window ${win.fromDate}..${win.toDate} spans ${inclusiveDays} days`,
    );
    assert.ok(from < to, "window must run forwards");
  }

  // Newest first, walking backwards.
  assert.ok(w[0].toDate > w[1].toDate);

  // Cap honored.
  assert.equal(historyWindows(today, 3).length, 3);
}

console.log("zernio.check: all checks passed");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @toreroflow/publishers exec tsx src/zernio.check.ts`
Expected: FAIL, `historyWindows` is not exported.

- [ ] **Step 3: Implement**

In `packages/publishers/src/zernio.ts`, add above the `ZernioProvider` class (after the `zernioProfileId` function):

```ts
export interface HistoryWindow {
  fromDate: string;
  toDate: string;
}

const DAY_MS = 86_400_000;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * Contiguous 366-day windows walking backwards from `today`, newest
 * first. Zernio's /analytics accepts at most a 366-day fromDate..toDate
 * range and defaults to 90 days when the params are omitted, so deep
 * history is fetched one window at a time.
 */
export function historyWindows(today: Date, maxWindows = 10): HistoryWindow[] {
  const windows: HistoryWindow[] = [];
  let to = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  for (let i = 0; i < maxWindows; i++) {
    const from = new Date(to.getTime() - 365 * DAY_MS);
    windows.push({ fromDate: isoDate(from), toDate: isoDate(to) });
    to = new Date(from.getTime() - DAY_MS);
  }
  return windows;
}
```

Replace the `analytics` method (lines 110-129) with:

```ts
  /**
   * Performance data across connected accounts. Zernio's docs leave the item
   * shape loose, so callers normalize field names defensively and keep raw.
   * Without dates Zernio serves its 90-day default window.
   */
  async analytics(
    max = 500,
    fromDate?: string,
    toDate?: string,
  ): Promise<Array<Record<string, unknown>>> {
    // Zernio caps limit at 100 and paginates via ?page=N.
    const pageSize = 100;
    const range =
      (fromDate ? `&fromDate=${fromDate}` : "") + (toDate ? `&toDate=${toDate}` : "");
    const out: Array<Record<string, unknown>> = [];
    for (let page = 1; out.length < max && page <= 10; page++) {
      const data = await this.request<Record<string, unknown>>(
        "GET",
        `/analytics?limit=${pageSize}&page=${page}${range}`,
      );
      const arr = (data.analytics ?? data.posts ?? data.data ?? data) as unknown;
      const items = Array.isArray(arr) ? (arr as Array<Record<string, unknown>>) : [];
      out.push(...items);
      if (items.length < pageSize) break;
    }
    return out;
  }

  /**
   * Everything Zernio can serve, walking historyWindows newest-first and
   * stopping at the first empty window. A window that fails after the
   * first stops the walk and returns what was already fetched; callers
   * upsert, so a short pull refreshes less rather than losing anything.
   * A first-window failure throws so total outages stay loud.
   */
  async analyticsHistory(maxWindows = 10): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    for (const w of historyWindows(new Date(), maxWindows)) {
      let items: Array<Record<string, unknown>>;
      try {
        items = await this.analytics(1000, w.fromDate, w.toDate);
      } catch (error) {
        if (!out.length) throw error;
        break;
      }
      if (!items.length) break;
      out.push(...items);
    }
    return out;
  }
```

- [ ] **Step 4: Run the check to verify it passes**

Run: `pnpm --filter @toreroflow/publishers exec tsx src/zernio.check.ts`
Expected: `zernio.check: all checks passed`

- [ ] **Step 5: Wire the check into the package test script**

In `packages/publishers/package.json`, change:

```json
    "test": "tsx src/options.check.ts",
```

to:

```json
    "test": "tsx src/options.check.ts && tsx src/zernio.check.ts",
```

- [ ] **Step 6: Full package test and typecheck**

Run: `pnpm --filter @toreroflow/publishers test && pnpm --filter @toreroflow/publishers typecheck`
Expected: both checks pass, typecheck exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/publishers/src/zernio.ts packages/publishers/src/zernio.check.ts packages/publishers/package.json
git commit -m "feat: zernio history fetch in year windows via fromDate and toDate"
```

---

### Task 3: The shared external store

**Files:**
- Create: `packages/db/src/externalStore.ts`
- Create: `packages/db/src/externalStore.check.ts`
- Modify: `packages/db/src/index.ts` (11 lines total, re-export)
- Modify: `packages/db/package.json` (deps and test script)

**Interfaces:**
- Consumes: `prisma.externalVideo` upsert on `socialAccountId_platformVideoId` (existing) and `prisma.externalVideoMetric` upsert on `externalVideoId_capturedOn` (Task 1).
- Produces, all re-exported from `@toreroflow/db`:
  - `interface ExternalVideoRow { socialAccountId: string; platform: Platform; platformVideoId: string; title: string; thumbnailUrl: string | null; url: string | null; publishedAt: Date; views: number; likes: number; comments: number; durationSec: number | null }`
  - `utcDay(d: Date): Date`
  - `mapProviderEntry(post: Record<string, unknown>, entry: Record<string, unknown>, account: { socialAccountId: string; platform: Platform }): ExternalVideoRow | null`
  - `upsertExternalVideo(prisma: PrismaClient, row: ExternalVideoRow, now?: Date): Promise<void>`
  - `persistProviderPosts(prisma: PrismaClient, posts: Array<Record<string, unknown>>, accountsByProviderId: Map<string, { socialAccountId: string; platform: Platform }>): Promise<number>` (returns rows written)

  Tasks 4 and 5 call `upsertExternalVideo` and `persistProviderPosts`.

- [ ] **Step 1: Wire the package**

In `packages/db/package.json`:
- Add to `"dependencies"`: `"@toreroflow/core": "workspace:*"`
- Add to `"devDependencies"`: `"tsx": "^4.23.1"` and `"@types/node": "^22.10.0"`
- Add to `"scripts"`: `"test": "tsx src/externalStore.check.ts"`

Then run: `pnpm install`
Expected: exit 0, lockfile updated.

- [ ] **Step 2: Write the failing check**

Create `packages/db/src/externalStore.check.ts`:

```ts
// Guards the provider-to-store mapping: a wrong field pick here writes a
// wrong lifetime number into every board and report, and a broken day
// bucket would either duplicate history or overwrite yesterday.
import assert from "node:assert/strict";
import { mapProviderEntry, utcDay } from "./externalStore";

/* utcDay: any time of day collapses to that UTC date at midnight. */
{
  const morning = utcDay(new Date("2026-07-28T00:00:01.000Z"));
  const night = utcDay(new Date("2026-07-28T23:59:59.999Z"));
  assert.equal(morning.getTime(), night.getTime());
  assert.equal(morning.toISOString(), "2026-07-28T00:00:00.000Z");
  const nextDay = utcDay(new Date("2026-07-29T00:00:00.000Z"));
  assert.notEqual(morning.getTime(), nextDay.getTime());
}

/* The full mapping: entry analytics preferred, post-level fallback. */
{
  const post = {
    _id: "p1",
    content: "Widebody day 3 \\ud83d\\udd25",
    publishedAt: "2026-05-01T15:00:00.000Z",
    thumbnailUrl: "https://cdn.example/t.jpg",
    platformPostUrl: "https://instagram.com/p/abc",
    analytics: { views: 100, likes: 5, comments: 1, duration: 31.5 },
  };
  const entry = {
    accountId: "za1",
    platform: "instagram",
    platformPostId: "18000000000000001",
    analytics: { views: 250000, likes: 1200, comments: 88 },
  };
  const row = mapProviderEntry(post, entry, {
    socialAccountId: "sa1",
    platform: "instagram",
  });
  assert.ok(row, "a complete entry must map");
  assert.equal(row.socialAccountId, "sa1");
  assert.equal(row.platform, "instagram");
  assert.equal(row.platformVideoId, "18000000000000001");
  assert.equal(row.title, "Widebody day 3 \u{1F525}"); // escapes decoded
  assert.equal(row.views, 250000); // entry analytics win over post analytics
  assert.equal(row.likes, 1200);
  assert.equal(row.comments, 88);
  assert.equal(row.durationSec, 31.5); // duration only exists post-level
  assert.equal(row.thumbnailUrl, "https://cdn.example/t.jpg");
  assert.equal(row.url, "https://instagram.com/p/abc");
  assert.equal(row.publishedAt.toISOString(), "2026-05-01T15:00:00.000Z");
}

/* Post-level analytics used when the entry has none of its own. */
{
  const row = mapProviderEntry(
    {
      content: "clip",
      publishedAt: "2026-06-01T00:00:00.000Z",
      analytics: { views: "4200", likes: 7 },
    },
    { accountId: "za1", platformPostId: "pp2" },
    { socialAccountId: "sa1", platform: "tiktok" },
  );
  assert.ok(row);
  assert.equal(row.views, 4200); // string numbers normalize
  assert.equal(row.likes, 7);
  assert.equal(row.comments, 0); // absent metric is 0, matching the merge
}

/* YouTube never persists through this path; the direct sync owns it. */
{
  const row = mapProviderEntry(
    { publishedAt: "2026-06-01T00:00:00.000Z" },
    { accountId: "za2", platformPostId: "yt1" },
    { socialAccountId: "sa2", platform: "youtube" },
  );
  assert.equal(row, null);
}

/* No platform post id, no row: there is nothing to key the upsert on. */
{
  const row = mapProviderEntry(
    { publishedAt: "2026-06-01T00:00:00.000Z" },
    { accountId: "za1" },
    { socialAccountId: "sa1", platform: "instagram" },
  );
  assert.equal(row, null);
}

/* Unparseable publish date, no row. */
{
  const row = mapProviderEntry(
    { content: "x" },
    { accountId: "za1", platformPostId: "pp3" },
    { socialAccountId: "sa1", platform: "instagram" },
  );
  assert.equal(row, null);
}

/* Blank caption falls back like the merge does. */
{
  const row = mapProviderEntry(
    { content: "   ", publishedAt: "2026-06-01T00:00:00.000Z" },
    { accountId: "za1", platformPostId: "pp4" },
    { socialAccountId: "sa1", platform: "instagram" },
  );
  assert.ok(row);
  assert.equal(row.title, "(untitled)");
}

console.log("externalStore.check: all checks passed");
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @toreroflow/db test`
Expected: FAIL, cannot find `./externalStore`.

- [ ] **Step 4: Implement**

Create `packages/db/src/externalStore.ts`:

```ts
import type { Platform, PrismaClient } from "@prisma/client";
import { decodeEscapes } from "@toreroflow/core";

/**
 * The one write path into the rolling store.
 *
 * Zernio only serves about a year of history and told us outright to keep
 * our own copy, so every provider-discovered post lands in ExternalVideo
 * (add or update, never delete) and every write also records that day's
 * numbers in ExternalVideoMetric: one row per video per UTC day, the
 * series future views-over-time charts and the site counter draw from.
 *
 * YouTube rows arrive here too, but through upsertExternalVideo directly
 * from the YouTube catalogue sync. mapProviderEntry refuses youtube on
 * purpose: Zernio's YouTube copy is capped and staler than the Data API,
 * and letting both write the same key would have them fight.
 */

export interface ExternalVideoRow {
  socialAccountId: string;
  platform: Platform;
  platformVideoId: string;
  title: string;
  thumbnailUrl: string | null;
  url: string | null;
  publishedAt: Date;
  views: number;
  likes: number;
  comments: number;
  durationSec: number | null;
}

/** First numeric value among several possible provider field names. */
function num(item: Record<string, unknown>, ...names: string[]): number | null {
  for (const n of names) {
    const v = item[n];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v !== "" && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

/** The UTC calendar day a timestamp falls on, at midnight UTC. */
export function utcDay(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/**
 * One Zernio analytics post entry to one store row, or null when the
 * entry cannot be keyed (no platformPostId), cannot be dated, or belongs
 * to YouTube. Field picks mirror the merge in mergedPosts.ts so a stored
 * number can never differ from what the screen computed live.
 */
export function mapProviderEntry(
  post: Record<string, unknown>,
  entry: Record<string, unknown>,
  account: { socialAccountId: string; platform: Platform },
): ExternalVideoRow | null {
  if (account.platform === "youtube") return null;

  const platformVideoId =
    typeof entry.platformPostId === "string" && entry.platformPostId ? entry.platformPostId : null;
  if (!platformVideoId) return null;

  const publishedAt = new Date(String(post.publishedAt ?? post.scheduledFor ?? ""));
  if (Number.isNaN(publishedAt.getTime())) return null;

  const em = (entry.analytics ?? {}) as Record<string, unknown>;
  const pm = (post.analytics ?? {}) as Record<string, unknown>;
  const pick = (...names: string[]) => num(em, ...names) ?? num(pm, ...names);

  return {
    socialAccountId: account.socialAccountId,
    platform: account.platform,
    platformVideoId,
    title:
      typeof post.content === "string" && post.content.trim()
        ? decodeEscapes(post.content.trim())
        : "(untitled)",
    thumbnailUrl: typeof post.thumbnailUrl === "string" ? post.thumbnailUrl : null,
    url: typeof post.platformPostUrl === "string" ? post.platformPostUrl : null,
    publishedAt,
    views: pick("views", "impressions", "plays") ?? 0,
    likes: pick("likes", "likeCount") ?? 0,
    comments: pick("comments", "commentCount") ?? 0,
    durationSec: num(pm, "duration", "videoDuration", "durationSec", "mediaDuration"),
  };
}

/**
 * Upsert one store row and its metric row for `now`'s UTC day. A second
 * run the same day overwrites the day's numbers instead of duplicating,
 * which is what makes boot catch-up plus the daily job plus manual
 * refreshes safe to stack.
 */
export async function upsertExternalVideo(
  prisma: PrismaClient,
  row: ExternalVideoRow,
  now = new Date(),
): Promise<void> {
  const { socialAccountId, platformVideoId, ...rest } = row;
  const data = { ...rest, fetchedAt: now };
  const video = await prisma.externalVideo.upsert({
    where: { socialAccountId_platformVideoId: { socialAccountId, platformVideoId } },
    create: { socialAccountId, platformVideoId, ...data },
    update: data,
  });

  const capturedOn = utcDay(now);
  const metrics = { views: row.views, likes: row.likes, comments: row.comments };
  await prisma.externalVideoMetric.upsert({
    where: { externalVideoId_capturedOn: { externalVideoId: video.id, capturedOn } },
    create: { externalVideoId: video.id, capturedOn, ...metrics },
    update: metrics,
  });
}

/**
 * Persist every mappable entry of a provider analytics pull. Entries whose
 * accountId is not one of ours are skipped, so one global pull can be
 * attributed across every connected account in a single pass. Returns the
 * number of rows written.
 */
export async function persistProviderPosts(
  prisma: PrismaClient,
  posts: Array<Record<string, unknown>>,
  accountsByProviderId: Map<string, { socialAccountId: string; platform: Platform }>,
): Promise<number> {
  let written = 0;
  for (const post of posts) {
    const entries = Array.isArray(post.platforms)
      ? (post.platforms as Array<Record<string, unknown>>)
      : [];
    for (const entry of entries) {
      const accountId = typeof entry.accountId === "string" ? entry.accountId : null;
      const account = accountId ? accountsByProviderId.get(accountId) : undefined;
      if (!account) continue;
      const row = mapProviderEntry(post, entry, account);
      if (!row) continue;
      await upsertExternalVideo(prisma, row);
      written++;
    }
  }
  return written;
}
```

Append to `packages/db/src/index.ts`:

```ts
export * from "./externalStore";
```

- [ ] **Step 5: Run the check to verify it passes**

Run: `pnpm --filter @toreroflow/db test`
Expected: `externalStore.check: all checks passed`

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @toreroflow/db typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/externalStore.ts packages/db/src/externalStore.check.ts packages/db/src/index.ts packages/db/package.json pnpm-lock.yaml
git commit -m "feat: shared external store writes the row and its daily metric together"
```

---

### Task 4: YouTube writers go through the store

**Files:**
- Modify: `apps/api/src/analytics/youtubeSync.ts:42-69` (the per-video upsert loop)
- Modify: `apps/worker/src/index.ts:199-222` (the same loop inside `refreshYouTubeCatalogues`)

**Interfaces:**
- Consumes: `upsertExternalVideo(prisma, row)` from `@toreroflow/db` (Task 3).
- Produces: nothing new; YouTube videos now gain daily `ExternalVideoMetric` rows.

- [ ] **Step 1: Swap the API-side sync**

In `apps/api/src/analytics/youtubeSync.ts`, add to the imports at the top:

```ts
import { upsertExternalVideo } from "@toreroflow/db";
```

(keep the existing `import type { PrismaClient } from "@toreroflow/db";` line as is).

Replace the body of the per-video loop (lines 42-68, the `const data = {...}` through `await deps.prisma.externalVideo.upsert({...});`) with:

```ts
      for (const v of videos) {
        await upsertExternalVideo(deps.prisma, {
          socialAccountId: account.id,
          platform: "youtube",
          platformVideoId: v.platformVideoId,
          title: v.title,
          thumbnailUrl: v.thumbnailUrl,
          url: v.url,
          publishedAt: new Date(v.publishedAt),
          views: v.views,
          likes: v.likes,
          comments: v.comments,
          durationSec: v.durationSec,
        });
      }
```

Also update the file's doc comment, second paragraph: after "Rows are upserted, so repeat runs refresh view counts rather than duplicating them." add "Every write also records the day's numbers through the shared store."

- [ ] **Step 2: Swap the worker-side refresh**

In `apps/worker/src/index.ts`, change the db import (line 7) from:

```ts
import { getPrisma, Prisma } from "@toreroflow/db";
```

to:

```ts
import { getPrisma, Prisma, persistProviderPosts, upsertExternalVideo } from "@toreroflow/db";
```

(`persistProviderPosts` is used in Task 5; importing both now avoids touching the line twice.)

In `refreshYouTubeCatalogues`, replace the per-video loop (lines 199-222, `const data = {...}` through the `await prisma.externalVideo.upsert({...});` and its closing brace) with:

```ts
      const { videos } = await youtube.allVideosForChannel(account.handle);
      for (const v of videos) {
        await upsertExternalVideo(prisma, {
          socialAccountId: account.id,
          platform: "youtube",
          platformVideoId: v.platformVideoId,
          title: v.title,
          thumbnailUrl: v.thumbnailUrl,
          url: v.url,
          publishedAt: new Date(v.publishedAt),
          views: v.views,
          likes: v.likes,
          comments: v.comments,
          durationSec: v.durationSec,
        });
      }
      total += videos.length;
```

Note Task 5 also edits this file; if executing out of order, re-read the file first.

- [ ] **Step 3: Typecheck and test both projects**

Run: `pnpm --filter @toreroflow/api typecheck && pnpm --filter @toreroflow/worker typecheck && pnpm --filter @toreroflow/api test && pnpm --filter @toreroflow/db test`

Expected: all pass. (Worker has no test script; typecheck is its gate. If the import of `persistProviderPosts` trips an unused-import error at this point, it means Task 5 has not landed yet and the tsconfig forbids unused imports; in that case import only `upsertExternalVideo` here and let Task 5 extend the line.)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/analytics/youtubeSync.ts apps/worker/src/index.ts
git commit -m "refactor: youtube catalogue writers go through the shared store"
```

---

### Task 5: The worker ingests full history and persists it

**Files:**
- Modify: `apps/worker/src/index.ts:441-451` (the fetch inside `ingestAnalytics`)

**Interfaces:**
- Consumes: `zernio.analyticsHistory()` (Task 2), `persistProviderPosts` (Task 3, import added in Task 4).
- Produces: every daily/boot/refresh-triggered ingest now writes the rolling store before its existing rollups.

- [ ] **Step 1: Switch the fetch to full history**

In `apps/worker/src/index.ts` inside `ingestAnalytics()`, change:

```ts
    [posts, remoteAccounts] = await Promise.all([
      zernio.analytics(500),
      zernio.listAccounts(),
    ]);
```

to:

```ts
    [posts, remoteAccounts] = await Promise.all([
      zernio.analyticsHistory(),
      zernio.listAccounts(),
    ]);
```

- [ ] **Step 2: Persist before any trimming**

Directly after the closing brace of that fetch's `catch` block (currently `console.error("[worker] analytics pull failed:", error); return;` ends at line 451) and before the `const horizon = ...` line, insert:

```ts
  // The rolling store: every provider post persists before the horizon
  // trim below, so all-time boards outlive Zernio's one-year window. The
  // 200-day horizon only concerns MetricSnapshot day-bucketing.
  const byProviderId = new Map(
    accounts
      .filter((a) => a.providerAccountId)
      .map((a) => [
        a.providerAccountId as string,
        { socialAccountId: a.id, platform: a.platform },
      ]),
  );
  try {
    const written = await persistProviderPosts(prisma, posts, byProviderId);
    console.log(`[worker] provider history persisted: ${written} rows`);
  } catch (error) {
    console.error("[worker] provider history persist failed:", error);
  }
```

- [ ] **Step 3: Update the ingest doc comment**

The comment block above `ingestAnalytics` (lines 421-426) explains the day-bucket attribution. Add one sentence at its end: "The pull is the full windowed history, and every post lands in the external store before the 200-day horizon trims anything."

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @toreroflow/worker typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/worker/src/index.ts
git commit -m "feat: ingest pulls the full zernio history and persists the rolling store"
```

---

### Task 6: Platform-aware merge preference

**Files:**
- Modify: `apps/api/src/analytics/mergedPosts.ts:176-218` (the external supersede block)
- Create: `apps/api/src/analytics/mergedPosts.check.ts`
- Modify: `apps/api/package.json` (test script)

**Interfaces:**
- Consumes: nothing new.
- Produces: `keepStoredRow(platform: string, hasLiveMatch: boolean): boolean` exported from `mergedPosts.ts`. The merged output now prefers live provider posts over stored rows for every platform except YouTube.

- [ ] **Step 1: Write the failing check**

Create `apps/api/src/analytics/mergedPosts.check.ts`:

```ts
// Guards the merge preference. YouTube's stored rows are the platform's
// own lifetime numbers and must always win. Every other platform's stored
// rows are yesterday's copy of the same provider feed: the live post is
// fresher and carries shares and watch time the store does not, so a
// stored row that shadowed it would silently degrade the screen.
import assert from "node:assert/strict";
import { keepStoredRow } from "./mergedPosts";

assert.equal(keepStoredRow("youtube", true), true);
assert.equal(keepStoredRow("youtube", false), true);
assert.equal(keepStoredRow("instagram", true), false);
assert.equal(keepStoredRow("instagram", false), true);
assert.equal(keepStoredRow("tiktok", true), false);
assert.equal(keepStoredRow("facebook", false), true);

console.log("mergedPosts.check: all checks passed");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @toreroflow/api exec tsx src/analytics/mergedPosts.check.ts`
Expected: FAIL, `keepStoredRow` is not exported.

- [ ] **Step 3: Implement**

In `apps/api/src/analytics/mergedPosts.ts`, add below the `num` helper (after line 46):

```ts
/**
 * Whether a stored ExternalVideo row survives the merge when the provider
 * also returned the same video live. YouTube's stored rows come straight
 * from YouTube's own API and stay authoritative. Every other platform's
 * stored rows are a previous pull of the same provider data, so the live
 * post wins and the store only covers what the live window no longer
 * reaches.
 */
export function keepStoredRow(platform: string, hasLiveMatch: boolean): boolean {
  return platform === "youtube" || !hasLiveMatch;
}
```

Then replace the supersede block (starting at the `if (external.length) {` after the `externalVideo.findMany`, through its closing `}`) with:

```ts
  if (external.length) {
    const liveKeys = new Set(
      posts.map((p) => p.platformKey).filter((k): k is string => k !== null),
    );
    const keptExternal = external.filter((v) =>
      keepStoredRow(v.platform, liveKeys.has(`${v.platform}:${v.platformVideoId}`)),
    );
    const seen = new Set(keptExternal.map((v) => `${v.platform}:${v.platformVideoId}`));
    const kept = posts.filter((p) => !p.platformKey || !seen.has(p.platformKey));
    posts.length = 0;
    posts.push(
      ...kept,
      ...keptExternal.map((v) => ({
        id: `ext:${v.id}`,
        platformKey: `${v.platform}:${v.platformVideoId}`,
        title: v.title,
        publishedAt: v.publishedAt.toISOString(),
        thumbnailUrl: v.thumbnailUrl,
        url: v.url,
        platforms: [v.platform],
        views: v.views,
        likes: v.likes,
        comments: v.comments,
        shares: 0,
        avgWatchSec: null,
        durationSec: v.durationSec,
        byPlatform: [{ platform: v.platform, views: v.views }],
        lifetime: true,
      })),
    );
  }
```

Also update the file's top doc comment: the sentence "Where a video appears in both, the platform's own numbers win and the provider's copy is dropped, so nothing is double counted." becomes "Where a video appears in both, YouTube's own numbers win and the provider's copy is dropped; on every other platform the live provider post wins and the stored copy is dropped, so nothing is double counted either way."

- [ ] **Step 4: Run the check to verify it passes**

Run: `pnpm --filter @toreroflow/api exec tsx src/analytics/mergedPosts.check.ts`
Expected: `mergedPosts.check: all checks passed`

- [ ] **Step 5: Wire into the api test script**

In `apps/api/package.json`, change:

```json
    "test": "tsx src/financials/month.check.ts && tsx src/financials/taxExport.check.ts && tsx src/financials/summary.check.ts",
```

to:

```json
    "test": "tsx src/financials/month.check.ts && tsx src/financials/taxExport.check.ts && tsx src/financials/summary.check.ts && tsx src/analytics/mergedPosts.check.ts",
```

- [ ] **Step 6: Full test and typecheck**

Run: `pnpm --filter @toreroflow/api test && pnpm --filter @toreroflow/api typecheck`
Expected: all four checks pass, typecheck exit 0.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/analytics/mergedPosts.ts apps/api/src/analytics/mergedPosts.check.ts apps/api/package.json
git commit -m "feat: live provider posts win the merge everywhere except youtube"
```

---

### Task 7: Collapse the duplicated merge in clients.ts

**Files:**
- Modify: `apps/api/src/routes/clients.ts` (the `/clients/:id/analytics/posts` route, lines 762-924, plus the orphaned `num` helper at lines 35-41)

**Interfaces:**
- Consumes: `buildMergedPosts(deps, clientId, agencyId)` from `../analytics/mergedPosts` (existing; the deps object is `{ prisma: prisma as never, zernio, log }`, matching the call in `reports.ts:113`).
- Produces: same route, same `{ posts }` response shape, same 5-minute cache; the hand-copied merge (about 150 lines) is gone.

- [ ] **Step 1: Replace the route**

In `apps/api/src/routes/clients.ts`, add to the imports:

```ts
import { buildMergedPosts } from "../analytics/mergedPosts";
```

Replace the entire `/clients/:id/analytics/posts` route registration (from its doc comment near line 762 down to the closing `);` at line 924, ending just before the `/** Branded PDF report...` comment) with:

```ts
  /**
   * Live per-post analytics for the Analytics screen: every provider post
   * (including pre-existing platform content) belonging to this client's
   * profile, with title, thumbnail, publish date, and metrics. Cached
   * briefly so brand switches don't hammer the provider. The merge lives
   * in buildMergedPosts, shared with the client reports, so the screen
   * and a PDF can never disagree.
   */
  app.get<{ Params: { id: string } }>(
    "/clients/:id/analytics/posts",
    async (request, reply) => {
      const client = await prisma.client.findFirst({
        where: { id: request.params.id, agencyId: request.user.agencyId, deletedAt: null },
        select: { id: true },
      });
      if (!client) return reply.status(404).send(NOT_FOUND);

      const cached = postsCache.get(client.id);
      if (cached && Date.now() - cached.at < POSTS_TTL_MS) return { posts: cached.posts };

      const posts = await buildMergedPosts(
        { prisma: prisma as never, zernio, log: request.log },
        client.id,
        request.user.agencyId,
      );
      if (!posts) return reply.status(404).send(NOT_FOUND);

      postsCache.set(client.id, { at: Date.now(), posts });
      return { posts };
    },
  );
```

- [ ] **Step 2: Delete the orphaned helper**

The `num` function at `clients.ts:35-41` was only used by the deleted inline merge (verify with a search for `num(` in the file; the remaining hits must all be inside the block you removed). Delete the function and its doc comment line.

- [ ] **Step 3: Typecheck and test**

Run: `pnpm --filter @toreroflow/api typecheck && pnpm --filter @toreroflow/api test`
Expected: exit 0, all checks pass. If typecheck flags anything else now unused (imports used only by the deleted block), delete those too.

- [ ] **Step 4: Typecheck the whole workspace**

Run: `pnpm -r typecheck`
Expected: all seven projects pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/clients.ts
git commit -m "refactor: analytics posts route reads the one shared merge"
```

---

### Task 8: Live verification walk (orchestrator, not a subagent)

No files. Run after all tasks and the whole-branch review.

- [ ] **Step 1: Start the stack**

From the repo root run `start.cmd` (Docker Postgres/Redis, API window, worker window). The worker's boot catch-up runs the new ingest immediately; watch the worker window for `provider history persisted: N rows` with N in the hundreds, and no persist-failed line.

- [ ] **Step 2: Confirm the store**

Query Postgres (creds are in `.env` `DATABASE_URL`; use `docker exec <postgres-container> psql -U <user> -d <db> -c "..."`):

- `SELECT platform, COUNT(*) FROM "ExternalVideo" GROUP BY platform;` Expect an `instagram` row near 452 alongside the existing `youtube` rows near 203... note the YouTube direct sync holds 481.
- `SELECT COUNT(*) FROM "ExternalVideoMetric";` Expect roughly one row per stored video.
- Trigger Refresh in the app's Analytics screen, wait for the worker to finish, re-run the count: it must NOT grow on the same day (same-day upsert proof).

- [ ] **Step 3: The screen**

In the installed app (no rebuild needed; nothing in the desktop changed), Analytics for Northstar, Videos area: the Instagram population should be around 452 rather than 136, tier boards hold all-time rankings, the 30/60/90/All chips filter the non-board sections, platform tabs scope the boards.

- [ ] **Step 4: Reports agreement**

Update a client report and compare its top-video numbers with the screen's for the same period; they must match (the collapsed merge is the only source).

- [ ] **Step 5: Checks and ledger**

`pnpm --filter @toreroflow/publishers test`, `--filter @toreroflow/api test`, `--filter @toreroflow/db test`, `--filter @toreroflow/desktop test`, `pnpm -r typecheck`. Then update `.superpowers/sdd/progress.md` and mark item 5 complete in the improvement list only after Tyrone's phrase.
