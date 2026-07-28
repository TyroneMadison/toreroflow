# Upload Copy Fields Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A video carries a Name, a Description that is the caption on Instagram, TikTok, Facebook and Snapchat, and YouTube's own Title and Description behind a toggle, with the file name demoted to a small label and scheduling saving what is on screen.

**Architecture:** The per-platform text rules become one pure function in `packages/core` that the schedule route calls per target. `draftCopy` (a Json column) gains `name`, `youtubeTitle` and `youtubeDescription`, mapped from legacy shapes by the existing read-time normalizer, so there is no migration. The card's bold file name becomes an editable Name bound to that field.

**Tech Stack:** TypeScript, pnpm workspace, zod, Fastify, Prisma (Json column, no migration), React, BullMQ worker, `tsx`-run `.check.ts` files (no test framework, never add one).

**Spec:** `docs/superpowers/specs/2026-07-28-upload-copy-fields-design.md`

## Global Constraints

- No em dashes anywhere: code, comments, UI copy, commit messages. Use commas, periods, or hyphens.
- Commits are local only, never push. No AI attribution: no `Co-Authored-By`, no "Generated with" lines. Tyrone Madison is the only author.
- No new dependencies. No test framework. Checks are `assert`-style `.check.ts` run with `tsx`, ending with `console.log("<name>: all checks passed")`. Desktop checks use the LOCAL assert object (`apps/desktop/src/lib/viewTiers.check.ts:4-16`); core checks import node's `assert`.
- No database migration. `draftCopy` is a Json column and `normalizeDraft` is the single read-time mapper.
- The fallback chains are exactly these, and live only in `packages/core/src/postCopy.ts`:
  - Caption platforms (anything not youtube): `description`, else `name`.
  - YouTube description: `youtubeDescription`, else `description`, else `name`.
  - YouTube title: `youtubeTitle`, else `name`, else `""` (empty means omit the key and let the provider name it).
  - A whitespace-only field counts as blank.
- `MediaAsset.originalName` is never written to and never becomes post content. The revision heuristic reads it (`apps/api/src/routes/media.ts:125`).
- The YouTube toggle controls visibility only. It must not influence which platforms a post goes to.

---

### Task 1: The per-platform copy rules

**Files:**
- Create: `packages/core/src/postCopy.ts`
- Create: `packages/core/src/postCopy.check.ts`
- Modify: `packages/core/src/index.ts` (add the export)
- Modify: `packages/core/package.json` (test script)

**Interfaces:**
- Consumes: nothing.
- Produces, exported from `@toreroflow/core`:
  - `interface DraftCopy { name?: string; description?: string; youtubeTitle?: string; youtubeDescription?: string; hashtags?: string[] }`
  - `captionFor(platform: string, draft: DraftCopy): string`
  - `youtubeTitleFor(draft: DraftCopy): string`

- [ ] **Step 1: Write the failing check**

Create `packages/core/src/postCopy.check.ts`:

```ts
// Guards the per-platform copy rules. These decide what actually gets
// published, so a wrong pick here posts the wrong words to a client's
// audience, silently and irreversibly.
import assert from "node:assert/strict";
import { captionFor, youtubeTitleFor } from "./postCopy";

const full = {
  name: "ZR1X first drive",
  description: "We take the ZR1X out for the first time.",
  youtubeTitle: "ZR1X FIRST DRIVE (it moves)",
  youtubeDescription: "Full walkaround and first impressions.",
};

/* Every caption platform posts the description, never the name or a title. */
for (const p of ["instagram", "tiktok", "facebook", "snapchat"]) {
  assert.equal(captionFor(p, full), "We take the ZR1X out for the first time.", p);
}

/* YouTube gets its own description, and its own title. */
assert.equal(captionFor("youtube", full), "Full walkaround and first impressions.");
assert.equal(youtubeTitleFor(full), "ZR1X FIRST DRIVE (it moves)");

/* A blank description falls back to the name on the caption platforms. */
assert.equal(captionFor("instagram", { name: "Just the name" }), "Just the name");

/* YouTube's description falls back to the card description, then the name. */
assert.equal(
  captionFor("youtube", { name: "n", description: "card copy" }),
  "card copy",
);
assert.equal(captionFor("youtube", { name: "n" }), "n");

/* YouTube's title falls back to the name, and is empty when nothing exists. */
assert.equal(youtubeTitleFor({ name: "n" }), "n");
assert.equal(youtubeTitleFor({ description: "d" }), "");
assert.equal(youtubeTitleFor({}), "");

/* Whitespace is not content. */
assert.equal(captionFor("tiktok", { name: "n", description: "   " }), "n");
assert.equal(youtubeTitleFor({ youtubeTitle: "\n\t ", name: "n" }), "n");

/* Everything blank yields empty, never the string "undefined". */
assert.equal(captionFor("instagram", {}), "");
assert.equal(captionFor("youtube", {}), "");

/* Values are trimmed on the way out. */
assert.equal(captionFor("instagram", { description: "  spaced  " }), "spaced");

console.log("post copy: all checks passed");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @toreroflow/core exec tsx src/postCopy.check.ts`
Expected: FAIL, cannot find `./postCopy`.

- [ ] **Step 3: Implement**

Create `packages/core/src/postCopy.ts`:

```ts
/**
 * What each platform actually receives.
 *
 * YouTube is the odd one out: it takes a title and a description, while
 * Instagram, TikTok, Facebook and Snapchat take a caption only. One
 * Description field serves as that caption, so the operator writes the
 * words once and YouTube's own two fields override them when filled.
 *
 * Every rule lives here. The schedule route asks this and never decides
 * for itself, so what posts can never drift from what is documented.
 */

export interface DraftCopy {
  /** The video's label in the app, and the fallback for everything else. */
  name?: string;
  /** The caption on Instagram, TikTok, Facebook and Snapchat. */
  description?: string;
  youtubeTitle?: string;
  youtubeDescription?: string;
  hashtags?: string[];
}

/** Trimmed value, or "" for missing and whitespace-only fields. */
function text(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The first field with something in it. */
function firstOf(...values: Array<string | undefined>): string {
  for (const v of values) {
    const t = text(v);
    if (t) return t;
  }
  return "";
}

/** The caption body this platform receives. */
export function captionFor(platform: string, draft: DraftCopy): string {
  if (platform === "youtube") {
    return firstOf(draft.youtubeDescription, draft.description, draft.name);
  }
  return firstOf(draft.description, draft.name);
}

/**
 * YouTube's title. An empty result means send no title at all: Zernio then
 * names the upload from the first line of the content, which beats posting
 * a title the operator never wrote.
 */
export function youtubeTitleFor(draft: DraftCopy): string {
  return firstOf(draft.youtubeTitle, draft.name);
}
```

Add to `packages/core/src/index.ts`, after the `./text` line:

```ts
export * from "./postCopy";
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @toreroflow/core exec tsx src/postCopy.check.ts`
Expected: `post copy: all checks passed`

- [ ] **Step 5: Wire the test script**

In `packages/core/package.json`, change the test script from:

```json
    "test": "tsx src/money.check.ts && tsx src/expenseCategories.check.ts && tsx src/financeSchemas.check.ts && tsx src/text.check.ts"
```

to:

```json
    "test": "tsx src/money.check.ts && tsx src/expenseCategories.check.ts && tsx src/financeSchemas.check.ts && tsx src/text.check.ts && tsx src/postCopy.check.ts"
```

- [ ] **Step 6: Test and typecheck**

Run: `pnpm --filter @toreroflow/core test && pnpm --filter @toreroflow/core typecheck`
Expected: five checks pass, typecheck exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/postCopy.ts packages/core/src/postCopy.check.ts packages/core/src/index.ts packages/core/package.json
git commit -m "feat: one place decides what copy each platform receives"
```

---

### Task 2: The server reads and writes the new shape

**Files:**
- Modify: `apps/api/src/routes/media.ts:25-30` (draftSchema) and `:46-58` (normalizeDraft)
- Modify: `apps/api/src/routes/posts.ts:174` (assetName)

**Interfaces:**
- Consumes: nothing from Task 1 (this task is storage shape only).
- Produces: `assetView(...).draftCopy` always carries `{ name, description, youtubeTitle, youtubeDescription, hashtags }`; `PATCH /media/:id/draft` accepts those same keys; the queue and calendar feed's `assetName` prefers the typed name.

- [ ] **Step 1: Widen the draft schema**

In `apps/api/src/routes/media.ts`, replace:

```ts
const draftSchema = z.object({
  /** Posted verbatim: YouTube title, and the Instagram/TikTok caption. */
  title: z.string().max(300).optional(),
  description: z.string().max(4000).optional(),
  hashtags: z.array(z.string().max(60)).max(20).optional(),
});
```

with:

```ts
const draftSchema = z.object({
  /** The video's label in the app, and the fallback for the fields below. */
  name: z.string().max(300).optional(),
  /** The caption on Instagram, TikTok, Facebook and Snapchat. */
  description: z.string().max(4000).optional(),
  youtubeTitle: z.string().max(100).optional(),
  youtubeDescription: z.string().max(4000).optional(),
  hashtags: z.array(z.string().max(60)).max(20).optional(),
});
```

(100 is YouTube's own title limit, established in the item 6 research.)

- [ ] **Step 2: Map every stored shape on read**

Replace `normalizeDraft` with:

```ts
  /**
   * Present draft copy in the current shape. Older rows carry {hook, caption}
   * from before the rename, and rows from before the split carry a `title`
   * that meant "YouTube title and everyone's caption". Both map onto `name`,
   * which is the field that still feeds every platform when nothing more
   * specific was written, so nothing already drafted changes behavior.
   */
  const normalizeDraft = (draft: unknown): unknown => {
    if (!draft || typeof draft !== "object") return draft;
    const d = draft as Record<string, unknown>;
    const str = (v: unknown): string | undefined =>
      typeof v === "string" ? decodeEscapes(v) : undefined;
    return {
      name: str(d.name) ?? str(d.title) ?? str(d.hook) ?? "",
      description: str(d.description) ?? str(d.caption) ?? "",
      youtubeTitle: str(d.youtubeTitle) ?? "",
      youtubeDescription: str(d.youtubeDescription) ?? "",
      hashtags: Array.isArray(d.hashtags)
        ? d.hashtags.map((h) => (typeof h === "string" ? decodeEscapes(h) : h))
        : [],
    };
  };
```

- [ ] **Step 3: The queue and calendar show the typed name**

In `apps/api/src/routes/posts.ts`, replace line 174:

```ts
        assetName: t.post.mediaAsset?.originalName ?? "post",
```

with:

```ts
        // The typed name when there is one, so the queue and calendar stop
        // showing raw file names.
        assetName:
          draftName(t.post.mediaAsset?.draftCopy) ||
          t.post.mediaAsset?.originalName ||
          "post",
```

and add this helper just above the route registrations in the same file (after the imports, before `export async function postRoutes`):

```ts
/** The name an operator typed for a video, or "" when they have not. */
function draftName(draft: unknown): string {
  if (!draft || typeof draft !== "object") return "";
  const d = draft as { name?: unknown; title?: unknown };
  if (typeof d.name === "string" && d.name.trim()) return d.name.trim();
  if (typeof d.title === "string" && d.title.trim()) return d.title.trim();
  return "";
}
```

- [ ] **Step 4: Typecheck and test**

Run: `pnpm --filter @toreroflow/api typecheck && pnpm --filter @toreroflow/api test`
Expected: exit 0, four checks pass. If the `mediaAsset` include does not carry `draftCopy`, check the query at `posts.ts:161` (`include: { post: { include: { mediaAsset: true } } }`) which selects the whole row, so it does.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/media.ts apps/api/src/routes/posts.ts
git commit -m "feat: draft copy carries a name and youtube's own two fields"
```

---

### Task 3: The schedule route asks the rules

**Files:**
- Modify: `apps/api/src/routes/posts.ts:54-103` (the draft read, the caption derivation, and the per-target create)

**Interfaces:**
- Consumes: `captionFor(platform, draft)` and `youtubeTitleFor(draft)` from `@toreroflow/core` (Task 1); the normalized draft shape (Task 2).
- Produces: each `PostTarget.caption` is that platform's caption, and `options.youtubeTitle` is YouTube's title.

- [ ] **Step 1: Import the rules**

In `apps/api/src/routes/posts.ts`, extend the core import:

```ts
import {
  appendWatchNext,
  captionFor,
  decodeEscapes,
  schedulePostSchema,
  youtubeTitleFor,
} from "@toreroflow/core";
```

(The file shadows `decodeEscapes` with a local const; leave that alone, only the import list changes.)

- [ ] **Step 2: Replace the derivation**

Replace lines 54-70, currently:

```ts
    const draft =
      (asset.draftCopy as {
        title?: string;
        hook?: string;
        description?: string;
        hashtags?: string[];
      } | null) ?? {};
```

through

```ts
    const description = decodeEscapes(draft.description ?? "");
```

with:

```ts
    // Older rows carry {hook, caption} or a `title` that used to mean both
    // the YouTube title and everyone's caption. Fold them onto `name`, which
    // is what every field falls back to, so nothing already drafted changes.
    const stored =
      (asset.draftCopy as {
        name?: string;
        title?: string;
        hook?: string;
        description?: string;
        caption?: string;
        youtubeTitle?: string;
        youtubeDescription?: string;
        hashtags?: string[];
      } | null) ?? {};
    const decodeEscapes = (v: string): string =>
      v.replace(/\\u([0-9a-fA-F]{4})/g, (_m, hex: string) =>
        String.fromCharCode(parseInt(hex, 16)),
      );
    const draft = {
      // body.caption stays an explicit override of the whole caption.
      name: decodeEscapes(body.caption ?? stored.name ?? stored.title ?? stored.hook ?? ""),
      description: decodeEscapes(stored.description ?? stored.caption ?? ""),
      youtubeTitle: decodeEscapes(stored.youtubeTitle ?? ""),
      youtubeDescription: decodeEscapes(stored.youtubeDescription ?? ""),
    };
    const hashtags = (body.hashtags ?? stored.hashtags ?? []).map(decodeEscapes);
```

- [ ] **Step 3: Use the rules per target**

Replace the `ytOptions` and `youtubeDescription` lines, currently:

```ts
    const ytOptions = body.youtube;
    const youtubeDescription = appendWatchNext(description || caption, ytOptions?.relatedVideoUrl);
```

with:

```ts
    const ytOptions = body.youtube;
    const youtubeCaption = appendWatchNext(
      captionFor("youtube", draft),
      ytOptions?.relatedVideoUrl,
    );
```

Then in the per-target create, replace:

```ts
            caption: platform === "youtube" && youtubeDescription ? youtubeDescription : caption,
```

with:

```ts
            caption: platform === "youtube" ? youtubeCaption : captionFor(platform, draft),
```

and replace:

```ts
                  ? { youtubeTitle: caption, ...(ytOptions ? { youtube: ytOptions } : {}) }
```

with:

```ts
                  ? {
                      youtubeTitle: youtubeTitleFor(draft),
                      ...(ytOptions ? { youtube: ytOptions } : {}),
                    }
```

- [ ] **Step 4: Typecheck and test**

Run: `pnpm --filter @toreroflow/api typecheck && pnpm --filter @toreroflow/api test`
Expected: exit 0, four checks pass. If TypeScript reports `caption` as unused, delete the now-dead `const caption` line; the replacement in Step 2 removed its only definition, so a leftover reference means an incomplete edit worth re-reading.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/posts.ts
git commit -m "feat: each platform is scheduled with the copy written for it"
```

---

### Task 4: The AI draft writes for the new split

**Files:**
- Modify: `apps/worker/src/index.ts:16-25` (DRAFT_SCHEMA) and `:69-76` (the system prompt)

**Interfaces:**
- Consumes: nothing.
- Produces: `draftCopy` rows shaped `{ name, description, hashtags }`.

- [ ] **Step 1: Rename the drafted field**

In `apps/worker/src/index.ts`, replace `DRAFT_SCHEMA`:

```ts
const DRAFT_SCHEMA = {
  type: "object",
  properties: {
    name: { type: "string" },
    description: { type: "string" },
    hashtags: { type: "array", items: { type: "string" } },
  },
  required: ["name", "description", "hashtags"],
  additionalProperties: false,
} as const;
```

- [ ] **Step 2: Correct the prompt**

Replace the `system:` string with:

```ts
      system:
        "You write short-form video post copy for a social media agency. " +
        "Given a video transcript, produce: a name (a short label for the " +
        "video, under 100 characters, no hashtags inside, which also serves " +
        "as the YouTube title when the operator writes nothing more " +
        "specific), a description (2-4 sentences, posted as the caption on " +
        "Instagram, TikTok, Facebook and Snapchat and as the YouTube " +
        "description, no hashtags inside), and 5-8 relevant hashtags without " +
        "the # sign. Write emoji as real characters, never as escape " +
        "sequences.",
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @toreroflow/worker typecheck`
Expected: exit 0. `cleanDraft` (`apps/worker/src/index.ts:27-37`) walks string values generically, so it needs no change.

- [ ] **Step 4: Commit**

```bash
git add apps/worker/src/index.ts
git commit -m "feat: drafted copy names the video and writes the caption"
```

---

### Task 5: The card's name, and the file name demoted

**Files:**
- Modify: `apps/desktop/src/lib/api.ts` (the `DraftCopy` interface, plus a label helper)
- Modify: `apps/desktop/src/screens/UploadSchedule.tsx` (state, `saveDraft`, the heading at :433-447, the Title input at :453-471, the Description hint at :473-475)
- Modify: `apps/desktop/src/modals/ScheduleModal.tsx:179` and `apps/desktop/src/modals/CoverModal.tsx:79`
- Modify: `apps/desktop/src/styles.css` (two small rules)

**Interfaces:**
- Consumes: the normalized draft shape (Task 2).
- Produces: `videoLabel(asset: MediaAssetInfo): string` exported from `apps/desktop/src/lib/api.ts`; the card's Name field bound to `draftCopy.name`.

- [ ] **Step 1: Update the desktop types and add the label helper**

In `apps/desktop/src/lib/api.ts`, replace the `DraftCopy` interface:

```ts
export interface DraftCopy {
  /** The video's label in the app, and the fallback for the fields below. */
  name?: string;
  /** The caption on Instagram, TikTok, Facebook and Snapchat. */
  description?: string;
  youtubeTitle?: string;
  youtubeDescription?: string;
  hashtags?: string[];
}
```

and add directly below the `MediaAssetInfo` interface:

```ts
/** What to call a video on screen: the typed name, else the file name. */
export function videoLabel(asset: MediaAssetInfo): string {
  const name = asset.draftCopy?.name?.trim();
  return name ? name : asset.name;
}
```

- [ ] **Step 2: Add the state for the new fields**

In `apps/desktop/src/screens/UploadSchedule.tsx`, replace the `titles` state line:

```ts
  const [titles, setTitles] = useState<Record<string, string>>({});
```

with:

```ts
  const [names, setNames] = useState<Record<string, string>>({});
  const [ytTitles, setYtTitles] = useState<Record<string, string>>({});
  const [ytDescriptions, setYtDescriptions] = useState<Record<string, string>>({});
```

Then fix every remaining reference to `titles`/`setTitles`:

- In `removeAsset`, the block that clears `setTitles` becomes `setNames`, and add matching clears for `ytTitles` and `ytDescriptions`:

```ts
    setNames((t) => {
      const next = { ...t };
      delete next[asset.id];
      return next;
    });
    setYtTitles((t) => {
      const next = { ...t };
      delete next[asset.id];
      return next;
    });
    setYtDescriptions((t) => {
      const next = { ...t };
      delete next[asset.id];
      return next;
    });
```

- [ ] **Step 3: Save every field**

Replace `saveDraft` (`apps/desktop/src/screens/UploadSchedule.tsx:191-208`) with:

```ts
  /** Persist whatever was typed. Returns false when the server refused. */
  const saveDraft = async (asset: MediaAssetInfo): Promise<boolean> => {
    const description = drafts[asset.id];
    const name = names[asset.id];
    const youtubeTitle = ytTitles[asset.id];
    const youtubeDescription = ytDescriptions[asset.id];
    if (
      description === undefined &&
      name === undefined &&
      youtubeTitle === undefined &&
      youtubeDescription === undefined
    ) {
      return true;
    }
    try {
      await api.patch(`/media/${asset.id}/draft`, {
        ...(name !== undefined ? { name } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(youtubeTitle !== undefined ? { youtubeTitle } : {}),
        ...(youtubeDescription !== undefined ? { youtubeDescription } : {}),
      });
    } catch (err) {
      // Never flash "Saved" over copy the server rejected.
      toast.fail(`Could not save the copy for ${videoLabel(asset)}`, err);
      return false;
    }
    setSavedFlash(asset.id);
    setTimeout(() => setSavedFlash((s) => (s === asset.id ? null : s)), 2000);
    void load();
    return true;
  };
```

Add `videoLabel` to the api import at the top of the file.

- [ ] **Step 4: The heading becomes the name**

Replace the per-asset derived values, currently:

```ts
              const description =
                drafts[asset.id] ?? asset.draftCopy?.description ?? "";
              const title = titles[asset.id] ?? asset.draftCopy?.title ?? "";
```

with:

```ts
              const description =
                drafts[asset.id] ?? asset.draftCopy?.description ?? "";
              const name = names[asset.id] ?? asset.draftCopy?.name ?? "";
              const ytTitle = ytTitles[asset.id] ?? asset.draftCopy?.youtubeTitle ?? "";
              const ytDescription =
                ytDescriptions[asset.id] ?? asset.draftCopy?.youtubeDescription ?? "";
```

Replace the heading block (`:433-447`) with:

```tsx
                    <div className="name">
                      <input
                        className="namein"
                        value={name}
                        maxLength={300}
                        placeholder="Name this video"
                        disabled={asset.status !== "ready"}
                        onChange={(e) =>
                          setNames((n) => ({ ...n, [asset.id]: e.target.value }))
                        }
                      />
                      {asset.isRevision && <span className="tag rev">Revision</span>}
                      {asset.status === "ready" && asset.hasTranscript && (
                        <span className="tag ok">Transcribed</span>
                      )}
                      {asset.status === "ready" && asset.draftCopy && (
                        <span className="tag ai">AI copy drafted</span>
                      )}
                      {asset.status === "failed" && (
                        <span className="tag" style={{ background: "rgba(255,107,122,.15)", color: "var(--red)", border: "1px solid rgba(255,107,122,.32)" }}>
                          Failed
                        </span>
                      )}
                    </div>
                    <div className="filename" title={asset.name}>
                      {asset.name}
                    </div>
```

- [ ] **Step 5: Drop the Title input, restate the Description**

Replace the Title label and input (`:453-471`, from `<label className="flabel" style={{ marginTop: 10 }}>` through the closing `/>` of the title input) and the Description label that follows it with just the Description label:

```tsx
                        <label className="flabel" style={{ marginTop: 10 }}>
                          Description
                          <span className="hint">
                            Instagram, TikTok, Facebook and Snapchat caption
                          </span>
                        </label>
```

The `<div className="captionbox">` textarea below it is unchanged.

- [ ] **Step 6: Fix the Save copy disabled rule**

Replace the `disabled` expression on the Save copy button (`:561-563`):

```tsx
                          disabled={
                            drafts[asset.id] === undefined &&
                            names[asset.id] === undefined &&
                            ytTitles[asset.id] === undefined &&
                            ytDescriptions[asset.id] === undefined
                          }
```

- [ ] **Step 7: Use the label in the two modals**

In `apps/desktop/src/modals/ScheduleModal.tsx`, import `videoLabel` from `../lib/api` and replace line 179's `<p>{asset.name}</p>` with `<p>{videoLabel(asset)}</p>`.

In `apps/desktop/src/modals/CoverModal.tsx`, do the same for line 79.

- [ ] **Step 8: The CSS**

Append to `apps/desktop/src/styles.css`:

```css
/* The card's name is an editable heading: it reads as text until focused,
   so an untitled video shows its placeholder rather than a form control. */
.namein{flex:1;min-width:0;background:transparent;border:1px solid transparent;border-radius:8px;color:var(--txt-1);font:inherit;padding:2px 6px;margin-left:-6px}
.namein:hover:not(:disabled){border-color:var(--brd-soft)}
.namein:focus{outline:none;border-color:var(--brd-soft);background:var(--glass-2)}
.namein::placeholder{color:var(--txt-3)}
.filename{font-size:11.5px;color:var(--txt-3);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
```

- [ ] **Step 9: Typecheck and test**

Run: `pnpm --filter @toreroflow/desktop typecheck && pnpm --filter @toreroflow/desktop test`
Expected: exit 0, three checks pass. A typecheck error naming `titles` means a reference in Step 2 was missed; find it and rename it to `names`.

- [ ] **Step 10: Commit**

```bash
git add apps/desktop/src/lib/api.ts apps/desktop/src/screens/UploadSchedule.tsx apps/desktop/src/modals/ScheduleModal.tsx apps/desktop/src/modals/CoverModal.tsx apps/desktop/src/styles.css
git commit -m "feat: a video carries a name, and the file name steps back"
```

---

### Task 6: The YouTube panel behind a toggle

**Files:**
- Modify: `apps/desktop/src/screens/UploadSchedule.tsx` (toggle state, the pill, the panel)
- Modify: `apps/desktop/src/styles.css` (one rule)

**Interfaces:**
- Consumes: `ytTitle` / `ytDescription` derived values and their setters (Task 5).
- Produces: no exported API. The panel renders inside the ready branch of the card.

- [ ] **Step 1: Add the toggle state**

In `apps/desktop/src/screens/UploadSchedule.tsx`, add after the `connectedCount` const:

```ts
  const youtubeConnected = (selectedClient?.accounts ?? []).some(
    (a) => a.platform === "youtube" && a.status === "connected",
  );
  // Disclosure only: this decides whether the YouTube fields are on screen,
  // never where a video posts. Platform choice belongs to the schedule modal,
  // and a second picker here would be a source of truth that can disagree.
  const [ytOpen, setYtOpen] = useState<Record<string, boolean>>({});
  const ytPanelOpen = (assetId: string): boolean => ytOpen[assetId] ?? youtubeConnected;
```

- [ ] **Step 2: Add the pill and the panel**

In the `revrow` block, directly after the closing `</span>` of the `revtoggle` quota pill and before the `{!asset.isRevision && asset.revisionOfId && (` line, add:

```tsx
                      {asset.status === "ready" && (
                        <span
                          className={`revtoggle${ytPanelOpen(asset.id) ? " on" : ""}`}
                          title="Show the title and description used for YouTube"
                          onClick={() =>
                            setYtOpen((o) => ({
                              ...o,
                              [asset.id]: !ytPanelOpen(asset.id),
                            }))
                          }
                        >
                          <span className="knob" />
                          YouTube
                        </span>
                      )}
```

Then, directly after the closing `</div>` of the `revrow` block and before the `<div className="schedrow">` line, add the panel:

```tsx
                    {asset.status === "ready" && ytPanelOpen(asset.id) && (
                      <div className="ytpanel">
                        <label className="flabel">
                          Title for YouTube upload
                          <span className="hint">
                            falls back to the video's name
                          </span>
                        </label>
                        <input
                          className="field-in"
                          value={ytTitle}
                          maxLength={100}
                          placeholder="Title this YouTube upload"
                          onChange={(e) =>
                            setYtTitles((t) => ({ ...t, [asset.id]: e.target.value }))
                          }
                        />
                        <label className="flabel" style={{ marginTop: 12 }}>
                          Description
                          <span className="hint">
                            falls back to the description above
                          </span>
                        </label>
                        <div className="captionbox">
                          <textarea
                            value={ytDescription}
                            placeholder="Write the YouTube description"
                            onChange={(e) =>
                              setYtDescriptions((d) => ({
                                ...d,
                                [asset.id]: e.target.value,
                              }))
                            }
                          />
                        </div>
                      </div>
                    )}
```

- [ ] **Step 3: The CSS**

Append to `apps/desktop/src/styles.css`:

```css
/* The YouTube panel: the blueprint's second card, folded into the row it
   belongs to so the video stays one object on screen. */
.ytpanel{margin-top:14px;padding:14px;border-radius:14px;background:var(--glass-2);border:1px solid var(--brd-soft)}
```

- [ ] **Step 4: Typecheck and test**

Run: `pnpm --filter @toreroflow/desktop typecheck && pnpm --filter @toreroflow/desktop test`
Expected: exit 0, three checks pass.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/screens/UploadSchedule.tsx apps/desktop/src/styles.css
git commit -m "feat: youtube's own title and description behind a toggle"
```

---

### Task 7: Scheduling saves what is on screen

**Files:**
- Modify: `apps/desktop/src/screens/UploadSchedule.tsx` (the Schedule button's onClick at :583)

**Interfaces:**
- Consumes: `saveDraft(asset): Promise<boolean>` (Task 5).
- Produces: the schedule modal opens only after pending edits are stored.

- [ ] **Step 1: Save before opening**

Replace the Schedule button's handler, currently:

```tsx
                        onClick={() => setScheduling(asset)}
```

with:

```tsx
                        onClick={() => {
                          // What posts has to be what is on screen. saveDraft
                          // is a no-op when nothing was typed, and returns
                          // false when the server refused, in which case the
                          // modal stays shut rather than publishing older copy.
                          void saveDraft(asset).then((ok) => {
                            if (ok) setScheduling(asset);
                          });
                        }}
```

- [ ] **Step 2: Typecheck and test**

Run: `pnpm --filter @toreroflow/desktop typecheck && pnpm --filter @toreroflow/desktop test`
Expected: exit 0, three checks pass.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/screens/UploadSchedule.tsx
git commit -m "fix: scheduling saves the copy on screen first"
```

---

### Task 8: Final review, rebuild, live walk (orchestrator, not a subagent)

No files. After all tasks and the whole-branch review.

- [ ] **Step 1: Full sweep**

`pnpm --filter @toreroflow/core test`, `--filter @toreroflow/api test`, `--filter @toreroflow/desktop test`, and `pnpm -r typecheck`. All green.

- [ ] **Step 2: Rebuild and reinstall**

`pnpm tauri build` from `apps/desktop`, then the silent NSIS reinstall and relaunch.

- [ ] **Step 3: The walk**

1. The existing video's card shows an editable name (carrying its old title, via the legacy mapping) with the file name small underneath, and no Title field.
2. Type a name, a description, a YouTube title and a YouTube description, press Save copy, reload the screen: all four persist.
3. Toggle YouTube off and on: the panel hides and returns with its text intact.
4. Type into a field and press Schedule without pressing Save copy: the stored draft matches what was on screen (check `draftCopy` in Postgres).
5. The queue row and calendar chip show the typed name, not the file name.
6. Prove the wire without publishing: with the worker stopped, schedule to all platforms, then read the created rows in Postgres:
   `SELECT platform, caption, options FROM "PostTarget" ORDER BY platform;`
   YouTube's caption must be the YouTube description and its options must carry the YouTube title; every other platform's caption must be the card's description. Then remove every target from the queue and confirm no delayed publish jobs remain before restarting the worker.
7. Clear the description and schedule again: the caption platforms fall back to the name.

- [ ] **Step 4: Ledger and list**

Update `.superpowers/sdd/progress.md`. Record that item 15 is delivered by this item, so the list stays honest.
