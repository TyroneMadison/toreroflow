# Instagram Upload Options Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver `docs/superpowers/specs/2026-07-28-instagram-upload-options-design.md`: per-video cover editing applied on every platform that accepts one, an Instagram options section at schedule time (trial reel, collaborators, audio name, share to feed, first comment, AI label), an options pipeline from modal to Zernio, explicit reels content type, and the truthful YouTube title/description mapping.

**Architecture:** A new `PostTarget.options Json?` column carries per-target options; `MediaAsset` gains `coverOffsetMs`/`coverKey`. A pure `buildPostExtras` function in packages/publishers maps (platform, format, cover, options) to Zernio's `platformSpecificData`, top-level `tiktokSettings`, and `mediaItems[].thumbnail`, with a runnable check. The worker uploads the cover image via the existing presign path and passes the built extras into a widened `createPost`; the dry-run publisher logs them. Desktop gains a CoverModal (frame scrubber or image upload) and an Instagram options group in ScheduleModal.

**Tech Stack:** Prisma/PostgreSQL, Fastify, BullMQ worker, React 18 desktop, tsx checks. No new external dependencies (tsx and @toreroflow/media appear as workspace-internal additions following existing patterns).

## Global Constraints

- Direct commits to main, lowercase `fix:`/`feat:` prefixes, no AI attribution or Co-Authored-By trailers, no em dashes anywhere.
- No test framework; checks are `.check.ts` under tsx wired into package `test` scripts.
- Prisma on this machine: `prisma migrate dev` does NOT work (non-interactive). Migrations are hand-written SQL dirs under `packages/db/prisma/migrations/` applied with `pnpm --filter @toreroflow/db migrate:deploy`. `prisma generate` fails with EPERM while the API or worker run; they must be stopped first and restarted after.
- Exact Zernio field names (from docs.zernio.com, verbatim): per-entry `platformSpecificData` with `contentType`, `shareToFeed`, `collaborators`, `firstComment`, `audioName`, `instagramThumbnail`, `trialParams { graduationStrategy: "MANUAL" | "SS_PERFORMANCE" }`, `isAiGenerated`, and for YouTube `title`; top-level `tiktokSettings` with `video_cover_image_url`; `mediaItems[]` items may carry `thumbnail` (YouTube regular videos only, never Shorts).
- Collaborators: max 3, typed usernames, leading `@` and whitespace stripped, no lookup API exists.
- Every Instagram video post sends `contentType: "reels"`.
- YouTube mapping: `platformSpecificData.title` = draft title; caption (`content`) = draft description falling back to the title. Only the YouTube target's caption changes; other platforms keep title-as-caption.
- Cover applies to Instagram and TikTok always, YouTube only when `format === "long_form"`.

---

### Task 1: Schema migration for options and covers

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (MediaAsset ~line 238, PostTarget ~line 304)
- Create: `packages/db/prisma/migrations/20260728090000_post_options_and_covers/migration.sql`

**Interfaces:**
- Produces: `PostTarget.options Json?`, `MediaAsset.coverOffsetMs Int?`, `MediaAsset.coverKey String?` available on the Prisma client. Tasks 4, 5 depend on these.

- [ ] **Step 1: Edit the schema**

In `packages/db/prisma/schema.prisma`, inside `model MediaAsset`, after the `revisionOfId String?` line and its comment, add:

```prisma
  /// Millisecond offset of the operator-chosen cover frame, when frame-picked.
  coverOffsetMs Int?
  /// Storage key of the chosen cover image (frame-extracted or uploaded).
  coverKey      String?
```

Inside `model PostTarget`, after `hashtags        String[]         @default([])`, add:

```prisma
  /// Per-platform publish options: { instagram: {...} } or { youtubeTitle }.
  options         Json?
```

- [ ] **Step 2: Hand-write the migration**

Create `packages/db/prisma/migrations/20260728090000_post_options_and_covers/migration.sql`:

```sql
-- Additive only: per-target publish options and the chosen cover.
ALTER TABLE "MediaAsset" ADD COLUMN "coverOffsetMs" INTEGER;
ALTER TABLE "MediaAsset" ADD COLUMN "coverKey" TEXT;
ALTER TABLE "PostTarget" ADD COLUMN "options" JSONB;
```

- [ ] **Step 3: Deploy the migration**

Run from the repo root: `pnpm --filter @toreroflow/db migrate:deploy`
Expected: "1 migration" applied, no errors.

- [ ] **Step 4: Regenerate the Prisma client (API and worker must be stopped)**

In PowerShell:

```powershell
$pid4700 = (Get-NetTCPConnection -LocalPort 4700 -State Listen -ErrorAction SilentlyContinue).OwningProcess | Select-Object -First 1
if ($pid4700) { $root = $pid4700; while ($true) { $parent = (Get-CimInstance Win32_Process -Filter "ProcessId=$root").ParentProcessId; $pcmd = (Get-CimInstance Win32_Process -Filter "ProcessId=$parent" -ErrorAction SilentlyContinue).CommandLine; if ($pcmd -match 'pnpm|tsx') { $root = $parent } else { break } }; taskkill /PID $root /T /F }
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'worker' } | ForEach-Object { taskkill /PID $_.ProcessId /T /F }
```

Then: `pnpm --filter @toreroflow/db generate`
Expected: "Generated Prisma Client".

Restart both, detached:

```powershell
Start-Process cmd -WorkingDirectory 'E:\Claude Stuff\Toreroflow' -ArgumentList '/k', 'title Toreroflow API && pnpm dev:api'
Start-Process cmd -WorkingDirectory 'E:\Claude Stuff\Toreroflow' -ArgumentList '/k', 'title Toreroflow worker && pnpm --filter @toreroflow/worker dev'
```

Wait, then confirm: `Invoke-RestMethod http://localhost:4700/health` returns status ok.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm --filter @toreroflow/db typecheck`
Expected: exit 0.

```bash
git add packages/db/prisma/schema.prisma packages/db/prisma/migrations/20260728090000_post_options_and_covers/migration.sql
git commit -m "feat: post target options column and media cover columns"
```

---

### Task 2: The pure options builder with its check

**Files:**
- Create: `packages/publishers/src/options.ts`
- Create: `packages/publishers/src/options.check.ts`
- Modify: `packages/publishers/src/index.ts` (re-export)
- Modify: `packages/publishers/package.json` (test script + tsx devDependency, matching the workspace pattern)

**Interfaces:**
- Produces:
  - `interface InstagramScheduleOptions { trial?: boolean; graduationStrategy?: "MANUAL" | "SS_PERFORMANCE"; collaborators?: string[]; audioName?: string; shareToFeed?: boolean; firstComment?: string; aiLabel?: boolean }`
  - `interface TargetOptionsInput { platform: Platform; format: string | null; coverUrl: string | null; instagram?: InstagramScheduleOptions | null; youtubeTitle?: string | null }`
  - `interface BuiltPostExtras { platformSpecificData?: Record<string, unknown>; tiktokSettings?: Record<string, unknown>; mediaThumbnail?: string }`
  - `function buildPostExtras(input: TargetOptionsInput): BuiltPostExtras`
- Tasks 3, 5 consume these names verbatim.

- [ ] **Step 1: Write the check first**

`packages/publishers/src/options.check.ts`:

```ts
// Local so the file stays part of the package's typecheck without pulling
// in node's assert types beyond the existing @types/node devDependency.
import assert from "node:assert/strict";
import { buildPostExtras } from "./options";

// Instagram short-form with every option set.
const ig = buildPostExtras({
  platform: "instagram",
  format: "short_form",
  coverUrl: "https://cdn.example/cover.jpg",
  instagram: {
    trial: true,
    graduationStrategy: "SS_PERFORMANCE",
    collaborators: ["northstar", "torerone"],
    audioName: "Torerone Original",
    shareToFeed: false,
    firstComment: "#cars #detroit",
    aiLabel: true,
  },
});
assert.deepEqual(ig.platformSpecificData, {
  contentType: "reels",
  instagramThumbnail: "https://cdn.example/cover.jpg",
  trialParams: { graduationStrategy: "SS_PERFORMANCE" },
  collaborators: ["northstar", "torerone"],
  audioName: "Torerone Original",
  shareToFeed: false,
  firstComment: "#cars #detroit",
  isAiGenerated: true,
});
assert.equal(ig.tiktokSettings, undefined);
assert.equal(ig.mediaThumbnail, undefined);

// Instagram with nothing chosen still declares the reel.
assert.deepEqual(buildPostExtras({ platform: "instagram", format: "short_form", coverUrl: null }), {
  platformSpecificData: { contentType: "reels" },
});

// Trial defaults to manual graduation.
const trial = buildPostExtras({
  platform: "instagram",
  format: "short_form",
  coverUrl: null,
  instagram: { trial: true },
});
assert.deepEqual(trial.platformSpecificData?.trialParams, { graduationStrategy: "MANUAL" });

// Empty collaborator entries are dropped; more than three never pass through.
const collab = buildPostExtras({
  platform: "instagram",
  format: "short_form",
  coverUrl: null,
  instagram: { collaborators: ["a", "", "b", "c", "d"] },
});
assert.deepEqual(collab.platformSpecificData?.collaborators, ["a", "b", "c"]);

// YouTube long-form: cover + title mapping.
const ytLong = buildPostExtras({
  platform: "youtube",
  format: "long_form",
  coverUrl: "https://cdn.example/cover.jpg",
  youtubeTitle: "How to charge the ZR1X",
});
assert.deepEqual(ytLong.platformSpecificData, { title: "How to charge the ZR1X" });
assert.equal(ytLong.mediaThumbnail, "https://cdn.example/cover.jpg");

// YouTube short-form never carries a thumbnail (YouTube's rule for Shorts).
const ytShort = buildPostExtras({
  platform: "youtube",
  format: "short_form",
  coverUrl: "https://cdn.example/cover.jpg",
  youtubeTitle: "T",
});
assert.equal(ytShort.mediaThumbnail, undefined);
assert.deepEqual(ytShort.platformSpecificData, { title: "T" });

// TikTok cover goes to the top-level settings object.
assert.deepEqual(
  buildPostExtras({ platform: "tiktok", format: "short_form", coverUrl: "https://cdn.example/c.jpg" }),
  { tiktokSettings: { video_cover_image_url: "https://cdn.example/c.jpg" } },
);

// TikTok without a cover sends nothing.
assert.deepEqual(buildPostExtras({ platform: "tiktok", format: "short_form", coverUrl: null }), {});

// Platforms with no options produce the legacy body.
assert.deepEqual(buildPostExtras({ platform: "facebook", format: "short_form", coverUrl: null }), {});
assert.deepEqual(buildPostExtras({ platform: "snapchat", format: null, coverUrl: null }), {});

console.log("options builder: all checks passed");
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @toreroflow/publishers exec tsx src/options.check.ts`
Expected: FAIL, cannot find module `./options`. (If tsx is not yet resolvable, finish Step 4's package.json change first, run `pnpm install`, and rerun.)

- [ ] **Step 3: Implement the builder**

`packages/publishers/src/options.ts`:

```ts
import type { Platform } from "@toreroflow/core";

/**
 * Options the operator can pick at schedule time for an Instagram target.
 * Field names are ours; the mapping to Zernio's names happens below, in one
 * place, so the wire format can never drift screen by screen.
 */
export interface InstagramScheduleOptions {
  trial?: boolean;
  graduationStrategy?: "MANUAL" | "SS_PERFORMANCE";
  collaborators?: string[];
  audioName?: string;
  shareToFeed?: boolean;
  firstComment?: string;
  aiLabel?: boolean;
}

export interface TargetOptionsInput {
  platform: Platform;
  /** MediaAsset.format: "short_form" | "long_form" | null. */
  format: string | null;
  /** Public URL of the uploaded cover image, when one was chosen. */
  coverUrl: string | null;
  instagram?: InstagramScheduleOptions | null;
  youtubeTitle?: string | null;
}

export interface BuiltPostExtras {
  /** Goes inside this target's platforms[] entry. */
  platformSpecificData?: Record<string, unknown>;
  /** Goes at the top level of the request body (TikTok's shape). */
  tiktokSettings?: Record<string, unknown>;
  /** Goes on the mediaItems[] entry (YouTube long-form only). */
  mediaThumbnail?: string;
}

/**
 * Maps a target's chosen options onto Zernio's exact request fields.
 *
 * Every Instagram video is declared a reel explicitly. YouTube Shorts never
 * get a thumbnail because YouTube's API refuses them; long-form does. TikTok
 * covers ride the provider's top-level settings object, which is safe here
 * because the worker publishes exactly one target per request.
 */
export function buildPostExtras(input: TargetOptionsInput): BuiltPostExtras {
  const out: BuiltPostExtras = {};

  if (input.platform === "instagram") {
    const psd: Record<string, unknown> = { contentType: "reels" };
    if (input.coverUrl) psd.instagramThumbnail = input.coverUrl;
    const ig = input.instagram;
    if (ig) {
      if (ig.trial) {
        psd.trialParams = { graduationStrategy: ig.graduationStrategy ?? "MANUAL" };
      }
      const collaborators = (ig.collaborators ?? [])
        .map((c) => c.trim())
        .filter(Boolean)
        .slice(0, 3);
      if (collaborators.length) psd.collaborators = collaborators;
      if (ig.audioName) psd.audioName = ig.audioName;
      if (ig.shareToFeed !== undefined) psd.shareToFeed = ig.shareToFeed;
      if (ig.firstComment) psd.firstComment = ig.firstComment;
      if (ig.aiLabel) psd.isAiGenerated = true;
    }
    out.platformSpecificData = psd;
    return out;
  }

  if (input.platform === "tiktok") {
    if (input.coverUrl) {
      out.tiktokSettings = { video_cover_image_url: input.coverUrl };
    }
    return out;
  }

  if (input.platform === "youtube") {
    if (input.youtubeTitle) {
      out.platformSpecificData = { title: input.youtubeTitle };
    }
    if (input.coverUrl && input.format === "long_form") {
      out.mediaThumbnail = input.coverUrl;
    }
    return out;
  }

  return out;
}
```

- [ ] **Step 4: Re-export, wire the test script**

In `packages/publishers/src/index.ts`, next to the existing re-exports at the top, add:

```ts
export * from "./options";
```

In `packages/publishers/package.json`, add to `scripts`:

```json
    "test": "tsx src/options.check.ts"
```

and to `devDependencies` (workspace pattern; tsx already serves core, api, and desktop):

```json
    "tsx": "^4.23.1"
```

Run `pnpm install` from the repo root to link tsx.

- [ ] **Step 5: Run the check and typecheck**

Run: `pnpm --filter @toreroflow/publishers test`
Expected: `options builder: all checks passed`
Run: `pnpm --filter @toreroflow/publishers typecheck`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add packages/publishers/src/options.ts packages/publishers/src/options.check.ts packages/publishers/src/index.ts packages/publishers/package.json pnpm-lock.yaml
git commit -m "feat: pure options builder mapping schedule choices to zernio fields"
```

---

### Task 3: Widen the Zernio client and the dry-run logger

**Files:**
- Modify: `packages/publishers/src/zernio.ts` (`createPost`, lines ~159-186)
- Modify: `packages/publishers/src/index.ts` (`PublishInput`, `DryRunPublisher.publish`)

**Interfaces:**
- Consumes: `BuiltPostExtras` from Task 2.
- Produces: `createPost` accepting per-target `platformSpecificData`, top-level `tiktokSettings`, and `mediaThumbnail`; `PublishInput.extras?: unknown` logged by the dry-run publisher. Task 5 calls both.

- [ ] **Step 1: Widen createPost**

In `packages/publishers/src/zernio.ts`, replace the whole `createPost` method with:

```ts
  /** Publish (or schedule) a post to one or more connected accounts. */
  async createPost(input: {
    content: string;
    mediaUrl?: string;
    /** Thumbnail for the media item (YouTube long-form covers). */
    mediaThumbnail?: string;
    targets: Array<{
      platform: Platform;
      accountId: string;
      /** Per-platform options, passed through verbatim. */
      platformSpecificData?: Record<string, unknown>;
    }>;
    /** TikTok's options live at the top level of the request body. */
    tiktokSettings?: Record<string, unknown>;
    publishNow?: boolean;
    scheduledFor?: string;
    timezone?: string;
  }): Promise<{ remotePostId: string }> {
    const body: Record<string, unknown> = {
      content: input.content,
      platforms: input.targets.map((t) => ({
        platform: t.platform,
        accountId: t.accountId,
        ...(t.platformSpecificData ? { platformSpecificData: t.platformSpecificData } : {}),
      })),
    };
    if (input.mediaUrl) {
      const item: Record<string, unknown> = { url: input.mediaUrl, type: "video" };
      if (input.mediaThumbnail) item.thumbnail = input.mediaThumbnail;
      body.mediaItems = [item];
    }
    if (input.tiktokSettings) body.tiktokSettings = input.tiktokSettings;
    if (input.publishNow) body.publishNow = true;
    if (input.scheduledFor) {
      body.scheduledFor = input.scheduledFor;
      body.timezone = input.timezone ?? "UTC";
    }
    const data = await this.request<Record<string, unknown>>("POST", "/posts", body);
    const post = (data.post ?? data) as { _id?: string; id?: string };
    return { remotePostId: post._id ?? post.id ?? "unknown" };
  }
```

- [ ] **Step 2: Teach the dry run to show the extras**

In `packages/publishers/src/index.ts`, add to `PublishInput` (after `scheduledAt?: Date;`):

```ts
  /** Built platform extras, logged verbatim so dry runs can be inspected. */
  extras?: unknown;
```

and in `DryRunPublisher.publish`, replace the `console.log` call with:

```ts
    console.log(`[dryrun:${this.platform}] publish`, {
      account: input.account.handle,
      caption: input.caption.slice(0, 80),
      hashtags: input.hashtags,
      scheduledAt: input.scheduledAt?.toISOString(),
      extras: input.extras ?? null,
    });
```

- [ ] **Step 3: Check, typecheck, commit**

Run: `pnpm --filter @toreroflow/publishers test` (expected: all checks passed)
Run: `pnpm --filter @toreroflow/publishers typecheck` (expected: exit 0)

```bash
git add packages/publishers/src/zernio.ts packages/publishers/src/index.ts
git commit -m "feat: zernio client carries platform options, tiktok settings, and media thumbnails"
```

---

### Task 4: Schema, schedule route, and the YouTube mapping

**Files:**
- Modify: `packages/core/src/schemas.ts` (schedulePostSchema, ~line 49)
- Modify: `apps/api/src/routes/posts.ts` (the schedule handler, lines ~51-86)

**Interfaces:**
- Consumes: `PostTarget.options` from Task 1.
- Produces: `schedulePostSchema` accepting `instagram?: {...}`; PostTarget rows whose `options` JSON is `{ instagram: {...} }` for Instagram targets and `{ youtubeTitle: string }` for YouTube targets; the YouTube target's `caption` holds the description (falling back to the title). Task 5 reads `options`; Task 7 sends `instagram`.

- [ ] **Step 1: Extend the schema**

In `packages/core/src/schemas.ts`, directly above `schedulePostSchema`, add:

```ts
export const instagramOptionsSchema = z.object({
  trial: z.boolean().optional(),
  graduationStrategy: z.enum(["MANUAL", "SS_PERFORMANCE"]).optional(),
  collaborators: z.array(z.string().max(80)).max(3).optional(),
  audioName: z.string().max(120).optional(),
  shareToFeed: z.boolean().optional(),
  firstComment: z.string().max(2200).optional(),
  aiLabel: z.boolean().optional(),
});
```

and add to `schedulePostSchema`'s object, after `hashtags`:

```ts
  instagram: instagramOptionsSchema.optional(),
```

- [ ] **Step 2: Route: options per target and the truthful YouTube caption**

In `apps/api/src/routes/posts.ts`, the draft parse currently reads:

```ts
    const draft =
      (asset.draftCopy as {
        title?: string;
        hook?: string;
        hashtags?: string[];
      } | null) ?? {};
```

Widen it to include the description:

```ts
    const draft =
      (asset.draftCopy as {
        title?: string;
        hook?: string;
        description?: string;
        hashtags?: string[];
      } | null) ?? {};
```

After the existing `const hashtags = ...` line, add:

```ts
    // YouTube's caption is the description; everywhere else the title IS the
    // caption. The description was being written and never sent before this.
    const description = decodeEscapes(draft.description ?? "");
    // Collaborators arrive as typed usernames; strip the @ some people type.
    const igOptions = body.instagram
      ? {
          ...body.instagram,
          collaborators: body.instagram.collaborators
            ?.map((c) => c.replace(/^@/, "").trim())
            .filter(Boolean),
        }
      : undefined;
```

Replace the per-target `create` mapping:

```ts
          create: accounts.map(({ platform, account }) => ({
            socialAccountId: account!.id,
            platform,
            caption,
            hashtags,
            scheduledAt,
            status: "scheduled",
          })),
```

with:

```ts
          create: accounts.map(({ platform, account }) => ({
            socialAccountId: account!.id,
            platform,
            caption: platform === "youtube" && description ? description : caption,
            hashtags,
            scheduledAt,
            status: "scheduled",
            options:
              platform === "instagram" && igOptions
                ? { instagram: igOptions }
                : platform === "youtube"
                  ? { youtubeTitle: caption }
                  : undefined,
          })),
```

- [ ] **Step 3: Typecheck, checks, commit**

Run: `pnpm --filter @toreroflow/api typecheck` and `pnpm --filter @toreroflow/api test`
Expected: exit 0; three "all checks passed" lines.

```bash
git add packages/core/src/schemas.ts apps/api/src/routes/posts.ts
git commit -m "feat: schedule accepts instagram options and youtube posts its real description"
```

---

### Task 5: Cover routes, thumb preference, and worker publish wiring

**Files:**
- Modify: `apps/api/src/routes/media.ts` (assetView + three new cover routes)
- Modify: `apps/api/package.json` (add `"@toreroflow/media": "workspace:*"` dependency)
- Modify: `apps/worker/src/index.ts` (cover upload + publish wiring, lines ~226-308)

**Interfaces:**
- Consumes: Task 1 columns, Task 2 `buildPostExtras`, Task 3 `createPost`/`extras`.
- Produces: `PATCH /media/:id/cover` body `{ offsetMs: number }`; `POST /media/:id/cover-image` (multipart JPEG/PNG); `DELETE /media/:id/cover`; assetView gains `coverOffsetMs` and prefers the cover for `thumbUrl`. Task 6 calls all three routes.

- [ ] **Step 1: API package dependency**

In `apps/api/package.json` dependencies, add `"@toreroflow/media": "workspace:*"` (the worker already depends on it; ffmpeg paths come from the shared .env). Run `pnpm install`.

- [ ] **Step 2: assetView prefers the cover**

In `apps/api/src/routes/media.ts`, add to the `assetView` parameter type after `revisionOfId: string | null;`:

```ts
    coverOffsetMs: number | null;
    coverKey: string | null;
```

and change the returned object: replace the `thumbUrl` line with

```ts
      coverOffsetMs: a.coverOffsetMs,
      thumbUrl: ready
        ? a.coverKey
          ? `/files/${a.coverKey}`
          : `/files/${a.clientId}/${a.id}/thumb.jpg`
        : null,
```

- [ ] **Step 3: The three cover routes**

Add to `apps/api/src/routes/media.ts`, after the `/media/:id/draft` route. Also add the import at the top of the file:

```ts
import { extractThumbnail } from "@toreroflow/media";
```

```ts
  const coverSchema = z.object({
    offsetMs: z.number().int().min(0).max(4 * 60 * 60 * 1000),
  });

  /**
   * Choose a frame of the video as the cover. The frame is extracted to
   * cover.jpg beside the source; every platform that accepts a custom
   * cover gets this image at publish, and the app's thumbnails switch to
   * it so what the operator sees is what posts.
   */
  app.patch<{ Params: { id: string } }>("/media/:id/cover", async (request, reply) => {
    const body = coverSchema.parse(request.body ?? {});
    const asset = await prisma.mediaAsset.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
    });
    if (!asset) return reply.status(404).send({ error: "asset not found" });
    if (asset.status !== "ready") {
      return reply.status(409).send({ error: "asset is still processing" });
    }
    const source = path.join(env.STORAGE_DIR, asset.storageKey);
    const coverKey = `${asset.clientId}/${asset.id}/cover.jpg`;
    await extractThumbnail(source, path.join(env.STORAGE_DIR, coverKey), body.offsetMs / 1000);
    // An uploaded cover may exist under another extension; the jpg now wins.
    const updated = await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { coverOffsetMs: body.offsetMs, coverKey },
    });
    return assetView(updated);
  });

  /** Upload an image as the cover instead of picking a frame. */
  app.post<{ Params: { id: string } }>("/media/:id/cover-image", async (request, reply) => {
    const asset = await prisma.mediaAsset.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
    });
    if (!asset) return reply.status(404).send({ error: "asset not found" });
    const file = await request.file();
    if (!file) return reply.status(400).send({ error: "no file uploaded" });
    const mime = file.mimetype;
    if (mime !== "image/jpeg" && mime !== "image/png") {
      return reply.status(400).send({ error: "cover must be a JPEG or PNG" });
    }
    const ext = mime === "image/png" ? ".png" : ".jpg";
    const coverKey = `${asset.clientId}/${asset.id}/cover${ext}`;
    await pipeline(
      file.file,
      createWriteStream(path.join(env.STORAGE_DIR, coverKey)),
    );
    if (file.file.truncated) {
      await fs.rm(path.join(env.STORAGE_DIR, coverKey), { force: true });
      return reply.status(413).send({ error: "file too large" });
    }
    // Remove the other-extension cover so exactly one exists.
    const other = path.join(
      env.STORAGE_DIR,
      `${asset.clientId}/${asset.id}/cover${ext === ".jpg" ? ".png" : ".jpg"}`,
    );
    await fs.rm(other, { force: true });
    const updated = await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { coverOffsetMs: null, coverKey },
    });
    return assetView(updated);
  });

  /** Back to the automatic thumbnail. */
  app.delete<{ Params: { id: string } }>("/media/:id/cover", async (request, reply) => {
    const asset = await prisma.mediaAsset.findFirst({
      where: { id: request.params.id, client: { agencyId: request.user.agencyId } },
    });
    if (!asset) return reply.status(404).send({ error: "asset not found" });
    for (const ext of [".jpg", ".png"]) {
      await fs.rm(
        path.join(env.STORAGE_DIR, `${asset.clientId}/${asset.id}/cover${ext}`),
        { force: true },
      );
    }
    const updated = await prisma.mediaAsset.update({
      where: { id: asset.id },
      data: { coverOffsetMs: null, coverKey: null },
    });
    return assetView(updated);
  });
```

Note: the auto thumbnail path writes `thumb.jpg`; the frame cover writes `cover.jpg`, so clearing always recovers the original.

- [ ] **Step 4: Worker: cover upload and publish wiring**

In `apps/worker/src/index.ts`:

Add to the `@toreroflow/publishers` import: `buildPostExtras`.

After the `zernioMediaUrl` function, add:

```ts
/** Cover images change when re-picked, so cache on the exact key. */
const coverUrlCache = new Map<string, string>();

async function zernioCoverUrl(coverKey: string): Promise<string> {
  const cached = coverUrlCache.get(coverKey);
  if (cached) return cached;
  const contentType = coverKey.endsWith(".png") ? "image/png" : "image/jpeg";
  const filePath = path.join(env.STORAGE_DIR, coverKey);
  const { uploadUrl, publicUrl } = await zernio!.presignMedia(
    path.basename(coverKey),
    contentType,
  );
  const body = await fs.readFile(filePath);
  await zernio!.uploadMedia(uploadUrl, body, contentType);
  coverUrlCache.set(coverKey, publicUrl);
  return publicUrl;
}
```

In `publishTarget`, after the `const caption = ...` block, add:

```ts
    const asset = target.post.mediaAsset;
    const targetOptions =
      (target.options as {
        instagram?: import("@toreroflow/publishers").InstagramScheduleOptions;
        youtubeTitle?: string;
      } | null) ?? {};
```

Then replace the `if (viaZernio) { ... }` block body with:

```ts
    if (viaZernio) {
      // Always the original upload; the app no longer produces re-encodes.
      const fileKey = asset?.storageKey;
      if (!fileKey) throw new Error("no media file for post");
      const mediaUrl = await zernioMediaUrl(asset!.id, path.join(env.STORAGE_DIR, fileKey));
      const coverUrl = asset?.coverKey ? await zernioCoverUrl(asset.coverKey) : null;
      const extras = buildPostExtras({
        platform: target.platform as Platform,
        format: asset?.format ?? null,
        coverUrl,
        instagram: targetOptions.instagram ?? null,
        youtubeTitle: targetOptions.youtubeTitle ?? null,
      });
      const result = await zernio.createPost({
        content: caption,
        mediaUrl,
        mediaThumbnail: extras.mediaThumbnail,
        targets: [
          {
            platform: target.platform as Platform,
            accountId: target.socialAccount.providerAccountId ?? "",
            platformSpecificData: extras.platformSpecificData,
          },
        ],
        tiktokSettings: extras.tiktokSettings,
        publishNow: true,
      });
      remotePostId = result.remotePostId;
    } else {
      // Dry-run accounts (and dev without a provider key) log instead of post.
      const publisher = new DryRunPublisher(target.platform as Platform);
      const extras = buildPostExtras({
        platform: target.platform as Platform,
        format: asset?.format ?? null,
        coverUrl: asset?.coverKey ? `/files/${asset.coverKey}` : null,
        instagram: targetOptions.instagram ?? null,
        youtubeTitle: targetOptions.youtubeTitle ?? null,
      });
      const result = await publisher.publish({
        account: {
          id: target.socialAccount.id,
          platform: target.platform as Platform,
          handle: target.socialAccount.handle,
        },
        videoUrl: asset?.storageKey ?? "",
        caption,
        hashtags: target.hashtags,
        extras,
      });
      remotePostId = result.remotePostId;
      remoteUrl = result.remoteUrl;
    }
```

(The pre-existing `const asset = target.post.mediaAsset;` line inside the viaZernio branch is removed; the hoisted one replaces it.)

- [ ] **Step 5: Typecheck everything touched, commit**

Run: `pnpm --filter @toreroflow/api typecheck`, `pnpm --filter @toreroflow/worker typecheck`
Expected: exit 0 for both.

```bash
git add apps/api/src/routes/media.ts apps/api/package.json apps/worker/src/index.ts pnpm-lock.yaml
git commit -m "feat: cover routes, cover-aware thumbnails, and options-aware publishing"
```

---

### Task 6: CoverModal and the Edit cover affordance

**Files:**
- Create: `apps/desktop/src/modals/CoverModal.tsx`
- Modify: `apps/desktop/src/lib/api.ts` (`MediaAssetInfo` + `uploadCoverImage`)
- Modify: `apps/desktop/src/screens/UploadSchedule.tsx` (Edit cover button under the thumb, modal state)
- Modify: `apps/desktop/src/styles.css` (cover modal styles)

**Interfaces:**
- Consumes: Task 5 routes.
- Produces: `<CoverModal asset onClose onChanged />`; `MediaAssetInfo.coverOffsetMs: number | null`; `uploadCoverImage(assetId: string, file: File): Promise<MediaAssetInfo>`.

- [ ] **Step 1: api.ts additions**

In `apps/desktop/src/lib/api.ts`, add to `MediaAssetInfo` after `thumbUrl`:

```ts
  /** Millisecond offset of the chosen cover frame; null when auto or uploaded. */
  coverOffsetMs: number | null;
```

After `uploadMedia`, add:

```ts
export async function uploadCoverImage(assetId: string, file: File): Promise<MediaAssetInfo> {
  const form = new FormData();
  form.append("file", file, file.name);
  const headers: Record<string, string> = {};
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${API_URL}/media/${assetId}/cover-image`, {
    method: "POST",
    headers,
    body: form,
  });
  const data: unknown = await res.json();
  if (!res.ok) throw new ApiError(res.status, data);
  return data as MediaAssetInfo;
}
```

- [ ] **Step 2: The modal**

`apps/desktop/src/modals/CoverModal.tsx`:

```tsx
import { useRef, useState } from "react";
import Modal from "./Modal";
import { useToast } from "../components/Toasts";
import { api, fileUrl, uploadCoverImage, type MediaAssetInfo } from "../lib/api";

interface CoverModalProps {
  asset: MediaAssetInfo;
  onClose: () => void;
  onChanged: () => void;
}

/**
 * Pick the frame that fronts this video everywhere a platform allows a
 * custom cover (Instagram, TikTok, YouTube long-form), or upload an image
 * instead. The app's own thumbnails switch to the choice, so the card
 * always shows exactly what will post.
 */
export default function CoverModal({ asset, onClose, onChanged }: CoverModalProps) {
  const toast = useToast();
  const video = useRef<HTMLVideoElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const [positionSec, setPositionSec] = useState(
    asset.coverOffsetMs != null ? asset.coverOffsetMs / 1000 : 1,
  );
  const [busy, setBusy] = useState<"frame" | "upload" | "clear" | null>(null);
  const src = fileUrl(asset.videoUrl);
  const duration = asset.durationSec ?? 0;

  const seek = (sec: number) => {
    setPositionSec(sec);
    if (video.current) video.current.currentTime = sec;
  };

  const useFrame = async () => {
    setBusy("frame");
    try {
      await api.patch(`/media/${asset.id}/cover`, { offsetMs: Math.round(positionSec * 1000) });
      onChanged();
      onClose();
    } catch (err) {
      toast.fail("Could not set the cover", err);
    } finally {
      setBusy(null);
    }
  };

  const uploadImage = async (file: File) => {
    setBusy("upload");
    try {
      await uploadCoverImage(asset.id, file);
      onChanged();
      onClose();
    } catch (err) {
      toast.fail("Could not upload the cover", err);
    } finally {
      setBusy(null);
    }
  };

  const clear = async () => {
    setBusy("clear");
    try {
      await api.del(`/media/${asset.id}/cover`);
      onChanged();
      onClose();
    } catch (err) {
      toast.fail("Could not remove the cover", err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal maxWidth={560} onClose={onClose}>
      <div className="modal-head">
        <div>
          <h3>Edit cover</h3>
          <p>{asset.name}</p>
        </div>
        <div className="modal-x" onClick={onClose}>
          <svg>
            <use href="#i-x" />
          </svg>
        </div>
      </div>
      <div className="modal-body">
        <div className="coverstage">
          {src ? (
            <video ref={video} src={src} muted playsInline preload="auto" />
          ) : (
            <div className="coverwait">Video not ready yet.</div>
          )}
        </div>
        <label className="flabel" style={{ marginTop: 14 }}>
          Scrub to the frame you want
        </label>
        <input
          className="coverscrub"
          type="range"
          min={0}
          max={Math.max(duration, 0.1)}
          step={0.05}
          value={positionSec}
          onChange={(e) => seek(Number(e.target.value))}
        />
        <p style={{ fontSize: 11.5, color: "var(--txt-3)", marginTop: 8 }}>
          Used on Instagram, TikTok, and YouTube long form. YouTube Shorts pick
          their own thumbnail, that is YouTube's rule, not ours.
        </p>
        <input
          ref={fileInput}
          type="file"
          accept="image/jpeg,image/png"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void uploadImage(f);
            e.target.value = "";
          }}
        />
      </div>
      <div className="modal-foot">
        <button className="btn ghost" disabled={busy !== null} onClick={() => void clear()}>
          {busy === "clear" ? "Removing…" : "Use auto thumbnail"}
        </button>
        <button
          className="btn ghost"
          disabled={busy !== null}
          onClick={() => fileInput.current?.click()}
        >
          {busy === "upload" ? "Uploading…" : "Upload an image"}
        </button>
        <button className="btn" disabled={busy !== null || !src} onClick={() => void useFrame()}>
          {busy === "frame" ? "Saving…" : "Use this frame"}
        </button>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 3: The Edit cover button**

In `apps/desktop/src/screens/UploadSchedule.tsx`:

Add the import: `import CoverModal from "../modals/CoverModal";`

Add state next to the other modal state (`const [scheduling, setScheduling] = ...`):

```tsx
  const [coverEditing, setCoverEditing] = useState<MediaAssetInfo | null>(null);
```

Inside the asset card, directly AFTER the closing `</div>` of the `className="thumb"` block, add:

```tsx
                  {asset.status === "ready" && (
                    <button
                      className="btn ghost coverbtn"
                      onClick={() => setCoverEditing(asset)}
                    >
                      Edit cover
                    </button>
                  )}
```

Wrap the thumb and the new button together so they stack: change `<div className="thumb" ...>` 's parent structure by wrapping both in a column container:

```tsx
                  <div className="thumbcol">
                    {/* existing <div className="thumb"> block unchanged */}
                    {/* the new Edit cover button */}
                  </div>
```

(Concretely: insert `<div className="thumbcol">` before the existing thumb div and close it after the new button.)

Near the other modal renders at the bottom of the component (beside `{scheduling && <ScheduleModal ... />}`), add:

```tsx
      {coverEditing && (
        <CoverModal
          asset={coverEditing}
          onClose={() => setCoverEditing(null)}
          onChanged={() => void load()}
        />
      )}
```

- [ ] **Step 4: CSS**

Append to `apps/desktop/src/styles.css` (end of file):

```css
/* ---- Cover picker ---- */
.thumbcol{display:flex;flex-direction:column;gap:8px;flex:0 0 auto}
.coverbtn{padding:6px 10px;font-size:11px}
.coverstage{border-radius:14px;overflow:hidden;background:#000;display:grid;place-items:center;min-height:220px}
.coverstage video{width:100%;max-height:300px;display:block}
.coverwait{color:var(--txt-3);font-size:12.5px;padding:40px}
.coverscrub{width:100%;margin-top:6px;accent-color:var(--v)}
```

- [ ] **Step 5: Typecheck, commit**

Run: `pnpm --filter @toreroflow/desktop typecheck`
Expected: exit 0.

```bash
git add apps/desktop/src/modals/CoverModal.tsx apps/desktop/src/lib/api.ts apps/desktop/src/screens/UploadSchedule.tsx apps/desktop/src/styles.css
git commit -m "feat: edit cover modal with frame scrubbing and image upload"
```

---

### Task 7: Instagram options in the schedule modal

**Files:**
- Modify: `apps/desktop/src/modals/ScheduleModal.tsx`
- Modify: `apps/desktop/src/styles.css` (append)

**Interfaces:**
- Consumes: Task 4's `instagram` field on the schedule body.
- Produces: the schedule POST body optionally carrying `instagram: { trial, graduationStrategy, collaborators, audioName, shareToFeed, firstComment, aiLabel }`, sent only when Instagram is selected and something was chosen.

- [ ] **Step 1: State and helpers**

In `apps/desktop/src/modals/ScheduleModal.tsx`, after the `confirmNow` state, add:

```tsx
  // Instagram-only options, applied to this scheduling action.
  const [igTrial, setIgTrial] = useState(false);
  const [igGraduate, setIgGraduate] = useState(false);
  const [igCollaborators, setIgCollaborators] = useState(["", "", ""]);
  const [igAudioName, setIgAudioName] = useState("");
  const [igShareToFeed, setIgShareToFeed] = useState(true);
  const [igFirstComment, setIgFirstComment] = useState("");
  const [igAiLabel, setIgAiLabel] = useState(false);

  const igSelected = platforms.includes("instagram");

  /** Only what was actually chosen; untouched controls send nothing. */
  const instagramBody = () => {
    if (!igSelected) return undefined;
    const collaborators = igCollaborators
      .map((c) => c.replace(/^@/, "").trim())
      .filter(Boolean);
    const body: Record<string, unknown> = {};
    if (igTrial) {
      body.trial = true;
      body.graduationStrategy = igGraduate ? "SS_PERFORMANCE" : "MANUAL";
    }
    if (collaborators.length) body.collaborators = collaborators;
    if (igAudioName.trim()) body.audioName = igAudioName.trim();
    if (!igShareToFeed) body.shareToFeed = false;
    if (igFirstComment.trim()) body.firstComment = igFirstComment.trim();
    if (igAiLabel) body.aiLabel = true;
    return Object.keys(body).length ? body : undefined;
  };
```

- [ ] **Step 2: Send it**

In `submit`, replace the POST body:

```tsx
      await api.post(`/media/${asset.id}/schedule`, {
        platforms,
        scheduledAt: (mode === "now" ? new Date() : new Date(when)).toISOString(),
        instagram: instagramBody(),
      });
```

- [ ] **Step 3: The options section**

In the JSX, directly after the closing `</div>` of the `className="toggles"` platforms block and BEFORE the "Post at" label, add:

```tsx
        {igSelected && (
          <div className="igopts">
            <label className="flabel" style={{ marginTop: 18 }}>
              Instagram options
            </label>
            <div className="igrow">
              <span
                className={`revtoggle${igTrial ? " on" : ""}`}
                title="Show this reel to non-followers first; it will not appear on the profile unless it graduates"
                onClick={() => setIgTrial((v) => !v)}
              >
                Trial reel
              </span>
              {igTrial && (
                <span
                  className={`revtoggle${igGraduate ? " on" : ""}`}
                  title="Share to everyone automatically if the trial performs"
                  onClick={() => setIgGraduate((v) => !v)}
                >
                  Auto-share if it performs
                </span>
              )}
              <span
                className={`revtoggle${igShareToFeed ? " on" : ""}`}
                title="Also show the reel in the main feed"
                onClick={() => setIgShareToFeed((v) => !v)}
              >
                Share to feed
              </span>
              <span
                className={`revtoggle${igAiLabel ? " on" : ""}`}
                title="Label this post as AI-generated content"
                onClick={() => setIgAiLabel((v) => !v)}
              >
                AI label
              </span>
            </div>
            <label className="flabel" style={{ marginTop: 12 }}>
              Collaborators
              <span className="hint">up to 3 public business or creator accounts</span>
            </label>
            <div className="igcollabs">
              {igCollaborators.map((value, i) => (
                <input
                  key={i}
                  className="field-in"
                  placeholder={`@username ${i + 1}`}
                  value={value}
                  onChange={(e) =>
                    setIgCollaborators((prev) =>
                      prev.map((v, j) => (j === i ? e.target.value : v)),
                    )
                  }
                />
              ))}
            </div>
            <label className="flabel" style={{ marginTop: 12 }}>
              Rename audio
              <span className="hint">replaces "Original Audio"</span>
            </label>
            <input
              className="field-in"
              placeholder="e.g. Torerone Original"
              maxLength={120}
              value={igAudioName}
              onChange={(e) => setIgAudioName(e.target.value)}
            />
            <label className="flabel" style={{ marginTop: 12 }}>
              First comment
              <span className="hint">posted automatically right after the reel</span>
            </label>
            <input
              className="field-in"
              placeholder="e.g. the hashtags, or a question for the comments"
              maxLength={2200}
              value={igFirstComment}
              onChange={(e) => setIgFirstComment(e.target.value)}
            />
          </div>
        )}
```

- [ ] **Step 4: CSS**

Append to `apps/desktop/src/styles.css`:

```css
/* ---- Instagram schedule options ---- */
.igrow{display:flex;gap:8px;flex-wrap:wrap;margin-top:6px}
.igcollabs{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-top:6px}
.igcollabs .field-in{padding:8px 10px;font-size:12px}
```

(The `revtoggle` pill class already exists on the upload screen and carries the on state.)

- [ ] **Step 5: Typecheck, commit**

Run: `pnpm --filter @toreroflow/desktop typecheck`
Expected: exit 0.

```bash
git add apps/desktop/src/modals/ScheduleModal.tsx apps/desktop/src/styles.css
git commit -m "feat: instagram options in the schedule modal"
```

---

### Task 8: Live verification walk

**Files:** none. Prereq: stack running (Task 1 already restarted the API and worker), desktop rebuilt or dev.

- [ ] **Step 1:** `pnpm -r typecheck` and the four package test scripts (core, api, desktop, publishers) all pass.
- [ ] **Step 2:** In the app, open Upload & Schedule on Northstar. Every ready card shows the Edit cover button. Open it: the video loads, the scrubber seeks, "Use this frame" saves, and the card thumbnail visibly changes to the chosen frame. Reopen: the scrubber starts at the saved offset.
- [ ] **Step 3:** "Upload an image" with a PNG: thumbnail switches to it. "Use auto thumbnail": the original card thumbnail returns.
- [ ] **Step 4:** Open the schedule modal with Instagram selected: the Instagram options section shows. Turn on Trial reel plus Auto-share, add one collaborator with a leading @, set an audio name and a first comment, leave Share to feed on. Deselect Instagram: the section disappears.
- [ ] **Step 5:** Dry-run proof: on a client whose accounts are dry-run (Vantage Auto LLC or a throwaway), schedule a post to Instagram + YouTube "now" with options set and a frame cover chosen. Read the worker window's `[dryrun:instagram] publish` log: extras must show `contentType: "reels"`, `instagramThumbnail`, `trialParams { graduationStrategy: "SS_PERFORMANCE" }`, the cleaned collaborator (no @), `audioName`, `firstComment`. The `[dryrun:youtube]` log: extras show `platformSpecificData.title` and, for a short-form asset, NO mediaThumbnail; the logged caption is the description when one exists.
- [ ] **Step 6:** Clean up: delete the dry-run test post targets (calendar delete), remove any test cover, restore anything touched on Northstar.
- [ ] **Step 7:** A real Instagram publish with a trial reel to Northstar's account is Tyrone's decision, separately from this walk.
