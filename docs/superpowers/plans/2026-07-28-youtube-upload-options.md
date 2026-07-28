# YouTube Upload Options Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** YouTube targets get schedule-time options (visibility, made for kids, first comment, category, playlist, AI label) riding item 4's options pipeline, plus a Related Video picker over the item-5 catalogue whose choice becomes a `Watch next:` link at the end of the description.

**Architecture:** A `youtube` options object flows ScheduleModal -> zod schema -> `PostTarget.options` -> `buildPostExtras` -> `platformSpecificData`, exactly like Instagram's. The route consumes `relatedVideoUrl` into the description before the worker ever sees it. Two small read endpoints feed the modal: the stored YouTube catalogue and the channel's public playlists.

**Tech Stack:** TypeScript, pnpm workspace, zod, Fastify, Prisma, React (desktop), `tsx`-run `.check.ts` files (no test framework, never add one).

**Spec:** `docs/superpowers/specs/2026-07-28-youtube-upload-options-design.md`

## Global Constraints

- No em dashes anywhere: code, comments, docs, commit messages. Use commas, periods, or hyphens.
- Commits are local only, never push. No AI attribution: no `Co-Authored-By`, no "Generated with" lines. Tyrone Madison is the only author.
- No new dependencies of any kind. No test framework; checks are `assert`-style `.check.ts` files run with `tsx`, ending with `console.log("<name>: all checks passed")`.
- Untouched controls send nothing: every options object is sparse, and Zernio's defaults (public, not for kids, category 22) apply when a field is absent.
- `relatedVideoUrl` must NEVER appear in `platformSpecificData` (the wire); it is consumed by the schedule route only.
- `madeForKids: true` drops `firstComment` in BOTH the modal (disabled input) and `buildPostExtras` (belt and braces; comments are permanently disabled on kids videos).
- The Shorts no-thumbnail rule (cover only when `format === "long_form"`) must survive unchanged.
- Match surrounding code style; the Instagram options section in ScheduleModal is the visual and structural template.

---

### Task 1: Schema and options builder

**Files:**
- Modify: `packages/core/src/schemas.ts:49-66` (add youtubeOptionsSchema, extend schedulePostSchema)
- Modify: `packages/publishers/src/options.ts` (interface + YouTube branch, currently lines 77-85)
- Test: `packages/publishers/src/options.check.ts` (append cases)

**Interfaces:**
- Consumes: nothing new.
- Produces:
  - `youtubeOptionsSchema` (zod) and `schedulePostSchema` gaining `youtube: youtubeOptionsSchema.optional()`, both exported from `@toreroflow/core`.
  - `interface YouTubeScheduleOptions { visibility?: "public" | "unlisted" | "private"; madeForKids?: boolean; firstComment?: string; categoryId?: string; playlistId?: string; aiLabel?: boolean; relatedVideoUrl?: string }` exported from `@toreroflow/publishers`.
  - `TargetOptionsInput` gains `youtube?: YouTubeScheduleOptions | null`.
  - `buildPostExtras` maps them to `platformSpecificData` fields `visibility, madeForKids, firstComment, categoryId, playlistId, containsSyntheticMedia` alongside the existing `title`.

- [ ] **Step 1: Write the failing checks**

Append to `packages/publishers/src/options.check.ts`, before the final `console.log` line:

```ts
// YouTube with every option set: aiLabel becomes containsSyntheticMedia,
// relatedVideoUrl never reaches the wire (the route consumes it).
const ytFull = buildPostExtras({
  platform: "youtube",
  format: "short_form",
  coverUrl: null,
  youtubeTitle: "ZR1X charging",
  youtube: {
    visibility: "unlisted",
    madeForKids: false,
    firstComment: "Full build on the channel",
    categoryId: "2",
    playlistId: "PLabc123",
    aiLabel: true,
    relatedVideoUrl: "https://www.youtube.com/watch?v=abc123",
  },
});
assert.deepEqual(ytFull.platformSpecificData, {
  title: "ZR1X charging",
  visibility: "unlisted",
  firstComment: "Full build on the channel",
  categoryId: "2",
  playlistId: "PLabc123",
  containsSyntheticMedia: true,
});

// Made for kids rides the wire and drops the first comment: kids videos
// have comments permanently disabled, so the pair can never coexist.
const ytKids = buildPostExtras({
  platform: "youtube",
  format: "short_form",
  coverUrl: null,
  youtube: { madeForKids: true, firstComment: "never sent" },
});
assert.deepEqual(ytKids.platformSpecificData, { madeForKids: true });

// Untouched YouTube options still send nothing at all.
assert.deepEqual(
  buildPostExtras({ platform: "youtube", format: "short_form", coverUrl: null }),
  {},
);
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @toreroflow/publishers exec tsx src/options.check.ts`
Expected: FAIL (TypeScript/tsx error: `youtube` not in `TargetOptionsInput`, or assertion failure on the sparse case).

- [ ] **Step 3: Implement the builder**

In `packages/publishers/src/options.ts`, add after `InstagramScheduleOptions` (line 16):

```ts
/**
 * Options the operator can pick at schedule time for a YouTube target.
 * relatedVideoUrl is consumed by the schedule route (it becomes a link at
 * the end of the description) and never reaches the wire, so it has no
 * mapping below.
 */
export interface YouTubeScheduleOptions {
  visibility?: "public" | "unlisted" | "private";
  madeForKids?: boolean;
  firstComment?: string;
  categoryId?: string;
  playlistId?: string;
  aiLabel?: boolean;
  relatedVideoUrl?: string;
}
```

Add to `TargetOptionsInput` after the `instagram` field (line 24):

```ts
  youtube?: YouTubeScheduleOptions | null;
```

Replace the YouTube branch (lines 77-85) with:

```ts
  if (input.platform === "youtube") {
    const psd: Record<string, unknown> = {};
    if (input.youtubeTitle) psd.title = input.youtubeTitle;
    const yt = input.youtube;
    if (yt) {
      if (yt.visibility) psd.visibility = yt.visibility;
      if (yt.madeForKids) psd.madeForKids = true;
      // Kids videos have comments permanently disabled, so a pinned first
      // comment cannot exist on one; drop it rather than send a request
      // YouTube must reject.
      if (yt.firstComment && !yt.madeForKids) psd.firstComment = yt.firstComment;
      if (yt.categoryId) psd.categoryId = yt.categoryId;
      if (yt.playlistId) psd.playlistId = yt.playlistId;
      if (yt.aiLabel) psd.containsSyntheticMedia = true;
    }
    if (Object.keys(psd).length) out.platformSpecificData = psd;
    if (input.coverUrl && input.format === "long_form") {
      out.mediaThumbnail = input.coverUrl;
    }
    return out;
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @toreroflow/publishers exec tsx src/options.check.ts`
Expected: `options builder: all checks passed` (the pre-existing YouTube title and thumbnail cases at lines 57-75 must still pass).

- [ ] **Step 5: Add the zod schema**

In `packages/core/src/schemas.ts`, add after `instagramOptionsSchema` (line 57):

```ts
export const youtubeOptionsSchema = z.object({
  visibility: z.enum(["public", "unlisted", "private"]).optional(),
  madeForKids: z.boolean().optional(),
  firstComment: z.string().max(10_000).optional(),
  categoryId: z.string().max(10).optional(),
  playlistId: z.string().max(60).optional(),
  aiLabel: z.boolean().optional(),
  relatedVideoUrl: z.string().url().max(300).optional(),
});
```

And inside `schedulePostSchema` (line 59), after the `instagram` line:

```ts
  youtube: youtubeOptionsSchema.optional(),
```

- [ ] **Step 6: Package tests and typecheck**

Run: `pnpm --filter @toreroflow/publishers test && pnpm --filter @toreroflow/publishers typecheck && pnpm --filter @toreroflow/core typecheck`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/schemas.ts packages/publishers/src/options.ts packages/publishers/src/options.check.ts
git commit -m "feat: youtube schedule options in the builder and wire schema"
```

---

### Task 2: The watch-next helper and the schedule route

**Files:**
- Modify: `packages/core/src/text.ts` (append helper)
- Create: `packages/core/src/text.check.ts`
- Modify: `packages/core/package.json` (test script)
- Modify: `apps/api/src/routes/posts.ts:70-101`

**Interfaces:**
- Consumes: `schedulePostSchema` with `youtube` (Task 1).
- Produces: `appendWatchNext(description: string, url: string | undefined): string` exported from `@toreroflow/core`; YouTube targets stored with `options: { youtubeTitle, youtube? }` and a caption ending in the watch-next line when a related video was picked.

- [ ] **Step 1: Write the failing check**

Create `packages/core/src/text.check.ts`:

```ts
// Guards the watch-next append: the link lands exactly once, at the end,
// and an empty description must not produce leading blank lines.
import assert from "node:assert/strict";
import { appendWatchNext } from "./text";

assert.equal(
  appendWatchNext("Big turbo day.", "https://www.youtube.com/watch?v=abc"),
  "Big turbo day.\n\nWatch next: https://www.youtube.com/watch?v=abc",
);
assert.equal(
  appendWatchNext("", "https://www.youtube.com/watch?v=abc"),
  "Watch next: https://www.youtube.com/watch?v=abc",
);
assert.equal(appendWatchNext("Big turbo day.", undefined), "Big turbo day.");
assert.equal(appendWatchNext("", undefined), "");

console.log("text helpers: all checks passed");
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @toreroflow/core exec tsx src/text.check.ts`
Expected: FAIL, `appendWatchNext` is not exported.

- [ ] **Step 3: Implement**

Append to `packages/core/src/text.ts`:

```ts
/**
 * The related-video link for a YouTube description. The Shorts "Related
 * video" pin is Studio-only with no API anywhere, so a link at the end of
 * the description is the closest any tool can get.
 */
export function appendWatchNext(description: string, url: string | undefined): string {
  if (!url) return description;
  return description ? `${description}\n\nWatch next: ${url}` : `Watch next: ${url}`;
}
```

- [ ] **Step 4: Run to verify pass, wire the test script**

Run: `pnpm --filter @toreroflow/core exec tsx src/text.check.ts`
Expected: `text helpers: all checks passed`

In `packages/core/package.json`, change the test script from:

```json
    "test": "tsx src/money.check.ts && tsx src/expenseCategories.check.ts && tsx src/financeSchemas.check.ts"
```

to:

```json
    "test": "tsx src/money.check.ts && tsx src/expenseCategories.check.ts && tsx src/financeSchemas.check.ts && tsx src/text.check.ts"
```

Run: `pnpm --filter @toreroflow/core test`
Expected: all four checks pass.

- [ ] **Step 5: Wire the route**

In `apps/api/src/routes/posts.ts`:

Add `appendWatchNext` to the core import (line 4):

```ts
import { decodeEscapes, schedulePostSchema, appendWatchNext } from "@toreroflow/core";
```

(Note: the file shadows `decodeEscapes` with a local copy at line 61; leave that as it is, only the import list changes.)

After the `igOptions` block (line 79), add:

```ts
    const ytOptions = body.youtube;
    const youtubeDescription = appendWatchNext(description, ytOptions?.relatedVideoUrl);
```

In the per-target create (lines 88-101), change the caption line from:

```ts
            caption: platform === "youtube" && description ? description : caption,
```

to:

```ts
            caption: platform === "youtube" && youtubeDescription ? youtubeDescription : caption,
```

and the options expression from:

```ts
            options:
              platform === "instagram" && igOptions
                ? { instagram: igOptions }
                : platform === "youtube"
                  ? { youtubeTitle: caption }
                  : undefined,
```

to:

```ts
            options:
              platform === "instagram" && igOptions
                ? { instagram: igOptions }
                : platform === "youtube"
                  ? { youtubeTitle: caption, ...(ytOptions ? { youtube: ytOptions } : {}) }
                  : undefined,
```

- [ ] **Step 6: Typecheck and test**

Run: `pnpm --filter @toreroflow/api typecheck && pnpm --filter @toreroflow/api test`
Expected: pass (api checks are unchanged; the route compiles against the new schema).

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/text.ts packages/core/src/text.check.ts packages/core/package.json apps/api/src/routes/posts.ts
git commit -m "feat: schedule route stores youtube options and appends the watch-next link"
```

---

### Task 3: Catalogue and playlists endpoints

**Files:**
- Modify: `packages/publishers/src/youtube.ts` (add `listPlaylists` after `getVideos`, near line 185)
- Modify: `apps/api/src/routes/clients.ts` (two new routes after the `/clients/:id/external/youtube/sync` route, which ends near line 715)

**Interfaces:**
- Consumes: `ExternalVideo` rows (item 5's store), the existing `youtube: YouTubeProvider | null` instance and `NOT_FOUND` constant already in scope in `clients.ts`.
- Produces:
  - `interface YouTubePlaylist { id: string; title: string }` and `YouTubeProvider.listPlaylists(handleOrId: string): Promise<YouTubePlaylist[]>` from `@toreroflow/publishers`.
  - `GET /clients/:id/external/youtube/videos` returning `{ videos: Array<{ platformVideoId, title, thumbnailUrl, url, publishedAt, views }> }` newest first.
  - `GET /clients/:id/external/youtube/playlists` returning `{ playlists: YouTubePlaylist[] }`, empty on unconfigured provider, missing account, or fetch failure.

- [ ] **Step 1: Add the provider method**

In `packages/publishers/src/youtube.ts`, add after the `YouTubeVideo` interface (line 22):

```ts
export interface YouTubePlaylist {
  id: string;
  title: string;
}
```

Add inside the class, after `getVideos` (after line 185):

```ts
  /** The channel's public playlists, for the schedule modal's dropdown. */
  async listPlaylists(handleOrId: string): Promise<YouTubePlaylist[]> {
    const { channelId } = await this.resolveChannel(handleOrId);
    const data = await this.get<{
      items?: Array<{ id?: string; snippet?: { title?: string } }>;
    }>("/playlists", { part: "snippet", channelId, maxResults: "50" });
    return (data.items ?? []).flatMap((p) =>
      typeof p.id === "string" ? [{ id: p.id, title: p.snippet?.title ?? "(untitled playlist)" }] : [],
    );
  }
```

- [ ] **Step 2: Add the two routes**

In `apps/api/src/routes/clients.ts`, directly after the closing `);` of the `/clients/:id/external/youtube/sync` route (near line 715), add:

```ts
  /**
   * The client's stored YouTube catalogue, for the schedule modal's
   * related-video picker. Reads the rolling store only; no live call, so
   * it is fast and works offline from YouTube.
   */
  app.get<{ Params: { id: string } }>(
    "/clients/:id/external/youtube/videos",
    async (request, reply) => {
      const client = await prisma.client.findFirst({
        where: { id: request.params.id, agencyId: request.user.agencyId, deletedAt: null },
        select: { id: true },
      });
      if (!client) return reply.status(404).send(NOT_FOUND);
      const videos = await prisma.externalVideo.findMany({
        where: {
          platform: "youtube",
          socialAccount: { clientId: client.id, deletedAt: null },
        },
        select: {
          platformVideoId: true,
          title: true,
          thumbnailUrl: true,
          url: true,
          publishedAt: true,
          views: true,
        },
        orderBy: { publishedAt: "desc" },
      });
      return { videos };
    },
  );

  /**
   * The channel's public playlists for the schedule modal dropdown. An
   * unconfigured provider, a missing account, or a failed fetch degrades
   * to an empty list, because scheduling must never depend on this.
   */
  app.get<{ Params: { id: string } }>(
    "/clients/:id/external/youtube/playlists",
    async (request, reply) => {
      const client = await prisma.client.findFirst({
        where: { id: request.params.id, agencyId: request.user.agencyId, deletedAt: null },
        include: {
          socialAccounts: { where: { deletedAt: null, platform: "youtube" } },
        },
      });
      if (!client) return reply.status(404).send(NOT_FOUND);
      const handle = client.socialAccounts[0]?.handle;
      if (!youtube || !handle) return { playlists: [] };
      try {
        return { playlists: await youtube.listPlaylists(handle) };
      } catch (error) {
        request.log.error({ err: error }, "youtube playlists fetch failed");
        return { playlists: [] };
      }
    },
  );
```

- [ ] **Step 3: Typecheck and test**

Run: `pnpm --filter @toreroflow/publishers typecheck && pnpm --filter @toreroflow/api typecheck && pnpm --filter @toreroflow/api test`
Expected: all pass. (`listPlaylists` is a thin fetch mapper in a file with no checks; consistent with the rest of `youtube.ts`, it gets none.)

- [ ] **Step 4: Commit**

```bash
git add packages/publishers/src/youtube.ts apps/api/src/routes/clients.ts
git commit -m "feat: catalogue and playlist endpoints for the schedule modal"
```

---

### Task 4: Worker passes the options through

**Files:**
- Modify: `apps/worker/src/index.ts:284-332` (the stored-options read and BOTH `buildPostExtras` call sites)

**Interfaces:**
- Consumes: `YouTubeScheduleOptions` from `@toreroflow/publishers` (Task 1); `buildPostExtras` with `youtube` input.
- Produces: live and dry-run publishes carry the stored `youtube` options.

- [ ] **Step 1: Widen the stored-options read**

In `apps/worker/src/index.ts`, change lines 284-288 from:

```ts
    const targetOptions =
      (target.options as {
        instagram?: import("@toreroflow/publishers").InstagramScheduleOptions;
        youtubeTitle?: string;
      } | null) ?? {};
```

to:

```ts
    const targetOptions =
      (target.options as {
        instagram?: import("@toreroflow/publishers").InstagramScheduleOptions;
        youtube?: import("@toreroflow/publishers").YouTubeScheduleOptions;
        youtubeTitle?: string;
      } | null) ?? {};
```

- [ ] **Step 2: Pass it at BOTH call sites**

There are two `buildPostExtras` calls, live (line 301) and dry-run (line 326); if only one changes, dry-run output silently diverges from the live wire. In each, after the `instagram:` line, add:

```ts
        youtube: targetOptions.youtube ?? null,
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @toreroflow/worker typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/index.ts
git commit -m "feat: worker publishes youtube options on live and dry-run paths"
```

---

### Task 5: ScheduleModal section and API types

**Files:**
- Modify: `apps/desktop/src/lib/api.ts` (two response shapes, in the response-shapes section after line 60)
- Modify: `apps/desktop/src/modals/ScheduleModal.tsx` (state + body builder + section; the Instagram section ends at line 221)

**Interfaces:**
- Consumes: the two endpoints from Task 3; the `youtube` key in the schedule body (Tasks 1-2).
- Produces: the YouTube options section, sparse `youtubeBody()`, lazy catalogue/playlists loading.

- [ ] **Step 1: Add the response shapes**

In `apps/desktop/src/lib/api.ts`, add in the response-shapes section (after line 60):

```ts
export interface CatalogueVideo {
  platformVideoId: string;
  title: string;
  thumbnailUrl: string | null;
  url: string | null;
  publishedAt: string;
  views: number;
}

export interface YouTubePlaylistInfo {
  id: string;
  title: string;
}
```

- [ ] **Step 2: Modal state and data loading**

In `apps/desktop/src/modals/ScheduleModal.tsx`:

Change line 1 to `import { useEffect, useState } from "react";` and extend the api import (line 6) to `import { api, type CatalogueVideo, type MediaAssetInfo, type YouTubePlaylistInfo } from "../lib/api";`.

Add above the component (after the `localInputValue` helper, line 20):

```ts
/** YouTube's stable category ids; Autos first because that is the clientele. */
const YT_CATEGORIES: Array<[string, string]> = [
  ["2", "Autos & Vehicles"],
  ["24", "Entertainment"],
  ["22", "People & Blogs"],
  ["26", "Howto & Style"],
  ["28", "Science & Technology"],
  ["27", "Education"],
  ["17", "Sports"],
  ["23", "Comedy"],
  ["10", "Music"],
  ["20", "Gaming"],
  ["19", "Travel & Events"],
  ["25", "News & Politics"],
  ["15", "Pets & Animals"],
  ["1", "Film & Animation"],
];
```

Add after the Instagram option states (line 45):

```ts
  // YouTube-only options, applied to this scheduling action.
  const [ytVisibility, setYtVisibility] = useState("");
  const [ytKids, setYtKids] = useState(false);
  const [ytAiLabel, setYtAiLabel] = useState(false);
  const [ytFirstComment, setYtFirstComment] = useState("");
  const [ytCategoryId, setYtCategoryId] = useState("");
  const [ytPlaylistId, setYtPlaylistId] = useState("");
  const [ytRelated, setYtRelated] = useState<CatalogueVideo | null>(null);
  const [ytPickerOpen, setYtPickerOpen] = useState(false);
  const [ytSearch, setYtSearch] = useState("");
  const [ytCatalogue, setYtCatalogue] = useState<CatalogueVideo[] | null>(null);
  const [ytCatalogueFailed, setYtCatalogueFailed] = useState(false);
  const [ytPlaylists, setYtPlaylists] = useState<YouTubePlaylistInfo[] | null>(null);
```

Add after `const igSelected = ...` (line 47):

```ts
  const ytSelected = platforms.includes("youtube");

  // Catalogue and playlists load once, the first time the section shows.
  // Quiet failures: the operator can always schedule without either.
  useEffect(() => {
    if (!ytSelected || !selectedClient || ytCatalogue !== null) return;
    api
      .get<{ videos: CatalogueVideo[] }>(
        `/clients/${selectedClient.id}/external/youtube/videos`,
      )
      .then((r) => setYtCatalogue(r.videos))
      .catch(() => {
        setYtCatalogue([]);
        setYtCatalogueFailed(true);
      });
    api
      .get<{ playlists: YouTubePlaylistInfo[] }>(
        `/clients/${selectedClient.id}/external/youtube/playlists`,
      )
      .then((r) => setYtPlaylists(r.playlists))
      .catch(() => setYtPlaylists([]));
  }, [ytSelected, selectedClient, ytCatalogue]);
```

- [ ] **Step 3: The sparse body builder**

Add after `instagramBody` (line 66):

```ts
  /** Only what was actually chosen; untouched controls send nothing. */
  const youtubeBody = () => {
    if (!ytSelected) return undefined;
    const body: Record<string, unknown> = {};
    if (ytVisibility) body.visibility = ytVisibility;
    if (ytKids) body.madeForKids = true;
    if (ytFirstComment.trim() && !ytKids) body.firstComment = ytFirstComment.trim();
    if (ytCategoryId) body.categoryId = ytCategoryId;
    if (ytPlaylistId) body.playlistId = ytPlaylistId;
    if (ytAiLabel) body.aiLabel = true;
    if (ytRelated) {
      body.relatedVideoUrl =
        ytRelated.url ?? `https://www.youtube.com/watch?v=${ytRelated.platformVideoId}`;
    }
    return Object.keys(body).length ? body : undefined;
  };
```

In `submit` (line 81-85), add `youtube: youtubeBody(),` after the `instagram:` line.

- [ ] **Step 4: The section JSX**

Insert directly after the Instagram section's closing `)}` (line 221), before the `Post at` label:

```tsx
        {ytSelected && (
          <div className="ytopts">
            <label className="flabel" style={{ marginTop: 18 }}>
              YouTube options
            </label>
            <div className="igrow">
              <span
                className={`revtoggle${ytKids ? " on" : ""}`}
                title="Declares the video made for kids. YouTube permanently disables comments, cards, and personalized ads on it"
                onClick={() => setYtKids((v) => !v)}
              >
                Made for kids
              </span>
              <span
                className={`revtoggle${ytAiLabel ? " on" : ""}`}
                title="Discloses altered or synthetic content"
                onClick={() => setYtAiLabel((v) => !v)}
              >
                AI label
              </span>
            </div>
            <label className="flabel" style={{ marginTop: 12 }}>
              Visibility
            </label>
            <select
              className="field-in"
              value={ytVisibility}
              onChange={(e) => setYtVisibility(e.target.value)}
            >
              <option value="">Public (default)</option>
              <option value="unlisted">Unlisted</option>
              <option value="private">Private</option>
            </select>
            <label className="flabel" style={{ marginTop: 12 }}>
              Category
            </label>
            <select
              className="field-in"
              value={ytCategoryId}
              onChange={(e) => setYtCategoryId(e.target.value)}
            >
              <option value="">Default (People &amp; Blogs)</option>
              {YT_CATEGORIES.map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
            <label className="flabel" style={{ marginTop: 12 }}>
              Playlist
            </label>
            {ytPlaylists && ytPlaylists.length > 0 ? (
              <select
                className="field-in"
                value={ytPlaylistId}
                onChange={(e) => setYtPlaylistId(e.target.value)}
              >
                <option value="">None</option>
                {ytPlaylists.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            ) : (
              <p style={{ fontSize: 12.5, color: "var(--txt-3)", marginTop: 4 }}>
                {ytPlaylists === null ? "Loading playlists…" : "No public playlists found."}
              </p>
            )}
            <label className="flabel" style={{ marginTop: 12 }}>
              First comment
              <span className="hint">
                {ytKids
                  ? "unavailable: made-for-kids videos have comments disabled"
                  : "posted and pinned automatically"}
              </span>
            </label>
            <input
              className="field-in"
              placeholder="e.g. full build playlist on the channel"
              maxLength={10000}
              disabled={ytKids}
              value={ytFirstComment}
              onChange={(e) => setYtFirstComment(e.target.value)}
            />
            <label className="flabel" style={{ marginTop: 12 }}>
              Related video
              <span className="hint">
                links it at the end of the description; the Studio pin stays manual
              </span>
            </label>
            {ytRelated ? (
              <div className="igrow">
                <span
                  className="revtoggle on"
                  title="Remove the related video"
                  onClick={() => setYtRelated(null)}
                >
                  {ytRelated.title.slice(0, 48)} ✕
                </span>
              </div>
            ) : (
              <>
                <span className="revtoggle" onClick={() => setYtPickerOpen((v) => !v)}>
                  {ytPickerOpen ? "Close list" : "Choose a video"}
                </span>
                {ytPickerOpen && (
                  <div style={{ marginTop: 8 }}>
                    <input
                      className="field-in"
                      placeholder="Search the channel's videos"
                      value={ytSearch}
                      onChange={(e) => setYtSearch(e.target.value)}
                    />
                    <div style={{ maxHeight: 210, overflowY: "auto", marginTop: 6 }}>
                      {ytCatalogueFailed && (
                        <p style={{ fontSize: 12.5, color: "var(--txt-3)" }}>
                          Could not load the catalogue. Try a refresh on Analytics first.
                        </p>
                      )}
                      {(ytCatalogue ?? [])
                        .filter((v) =>
                          v.title.toLowerCase().includes(ytSearch.trim().toLowerCase()),
                        )
                        .slice(0, 30)
                        .map((v) => (
                          <div
                            key={v.platformVideoId}
                            className="rrow"
                            style={{ cursor: "pointer" }}
                            onClick={() => {
                              setYtRelated(v);
                              setYtPickerOpen(false);
                            }}
                          >
                            {v.thumbnailUrl && (
                              <img
                                src={v.thumbnailUrl}
                                alt=""
                                style={{
                                  width: 42,
                                  height: 24,
                                  objectFit: "cover",
                                  borderRadius: 4,
                                }}
                              />
                            )}
                            <span className="t">{v.title}</span>
                            <span className="v">
                              {v.views >= 1000 ? `${Math.round(v.views / 1000)}K` : v.views}
                            </span>
                          </div>
                        ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        )}
```

(`.igrow`, `.revtoggle`, `.field-in`, `.flabel`, `.hint`, and `.rrow` all exist in `styles.css` already; `.ytopts`, like `.igopts`, is a bare wrapper needing no CSS.)

- [ ] **Step 5: Typecheck and test**

Run: `pnpm --filter @toreroflow/desktop typecheck && pnpm --filter @toreroflow/desktop test`
Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/lib/api.ts apps/desktop/src/modals/ScheduleModal.tsx
git commit -m "feat: youtube options section with the related video picker"
```

---

### Task 6: Final review and live verification walk (orchestrator, not a subagent)

No files. After all tasks and the whole-branch review:

- [ ] **Step 1: Full sweep**

`pnpm --filter @toreroflow/publishers test`, `--filter @toreroflow/core test`, `--filter @toreroflow/api test`, `--filter @toreroflow/desktop test`, and `pnpm -r typecheck`. All green.

- [ ] **Step 2: Rebuild and reinstall the desktop app**

The modal changed, so unlike item 5 the installed Tauri app needs a rebuild and silent reinstall (the established pattern from earlier items). Then relaunch it against the running stack.

- [ ] **Step 3: The modal walk**

Open Upload & Schedule, pick a ready video, open the schedule modal with a YouTube account connected: the YouTube options section renders; the catalogue list opens with search and real thumbnails from the store; picking a video shows the removable chip; Made for kids disables the first-comment input with the hint; playlists show as a dropdown (or the quiet empty state).

- [ ] **Step 4: Wire proof without a real post**

Package-level: the Task 1 checks pin the exact `platformSpecificData`. Do NOT schedule against the live provider. If a worker-level wire trace is wanted, unset `ZERNIO_API_KEY` in a scratch environment so the dry-run publisher logs the extras; otherwise the checks plus the whole-branch review stand as the proof, matching item 4's precedent.

- [ ] **Step 5: Ledger and handoff**

Update `.superpowers/sdd/progress.md`. Tyrone's manual step, recorded: the first real publish with options set (visibility, category, first comment, related video), verified on YouTube itself.
