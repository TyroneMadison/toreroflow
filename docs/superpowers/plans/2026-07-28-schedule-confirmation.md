# Schedule Confirmation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scheduling a video makes its card play a green check and leave the upload list for good, a failure draws a red X beside the error with the operator's options intact, and failed posts become visible in the queue so a hidden card can never hide a problem.

**Architecture:** The upload list becomes "videos not yet scheduled" through one database query change, so the rule survives restarts and unqueueing restores a card for free. The screen marks the departing asset by id, plays the animation, then refetches. The queue's row selection moves into one pure function that includes failed posts.

**Tech Stack:** TypeScript, React (Vite desktop app in Tauri), Fastify, Prisma, plain CSS in one stylesheet, `tsx`-run `.check.ts` files (no test framework, never add one).

**Spec:** `docs/superpowers/specs/2026-07-28-schedule-confirmation-design.md`

## Global Constraints

- No em dashes anywhere: code, comments, UI copy, commit messages. Use commas, periods, or hyphens.
- Commits are local only, never push. No AI attribution: no `Co-Authored-By`, no "Generated with" lines. Tyrone Madison is the only author.
- No new dependencies, and no animation library. The animations are CSS in `apps/desktop/src/styles.css`.
- No test framework. Checks are `assert`-style `.check.ts` run with `tsx`. Desktop checks use the LOCAL assert object (see `apps/desktop/src/lib/viewTiers.check.ts:4-16`) so the file stays inside the app's typecheck without pulling in node types. End with `console.log("<name>: all checks passed")`.
- House easing is `cubic-bezier(.2,.7,.2,1)`. Match it; do not invent new curves.
- Every new animation carries its own `prefers-reduced-motion: reduce` guard, following the per-component `.toast` precedent at `styles.css:729`. There is no global reset to rely on.
- The counter ("Videos this period") is item 8 and must not be touched. It reads `GET /clients/:id/quota` and is unaffected by anything here.
- Animation timings are fixed: ring draws at 0ms for 340ms, tick at 300ms for 260ms, card collapse at 600ms for 320ms, refetch at 950ms.

---

### Task 1: The upload list stops returning scheduled videos

**Files:**
- Modify: `apps/api/src/routes/media.ts:168-172` (the `GET /clients/:id/media` query)

**Interfaces:**
- Consumes: nothing.
- Produces: `GET /clients/:id/media` returns only assets with no live post. Response shape via `assetView` is unchanged, so no client type changes.

**Note on testing:** this is a database query. There is no pure logic to check, and the repo has no integration test harness by design, so its gate is the typecheck plus the live walk in Task 5. Do not invent a test framework for it.

- [ ] **Step 1: Change the query**

In `apps/api/src/routes/media.ts`, replace:

```ts
    const assets = await prisma.mediaAsset.findMany({
      where: { clientId: client.id },
      orderBy: { createdAt: "desc" },
    });
```

with:

```ts
    // The upload list means "not yet scheduled". A video leaves it once it
    // has a live post, and comes back on its own if that post is removed
    // from the queue, because removing a target deletes the row. A post
    // whose every target failed is not live: nothing was published, so the
    // operator can fix it and schedule again from the same card.
    const assets = await prisma.mediaAsset.findMany({
      where: {
        clientId: client.id,
        posts: {
          none: {
            deletedAt: null,
            targets: {
              some: { status: { in: ["scheduled", "publishing", "posted"] } },
            },
          },
        },
      },
      orderBy: { createdAt: "desc" },
    });
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @toreroflow/api typecheck`
Expected: exit 0. If Prisma rejects the relation name, confirm it against `packages/db/prisma/schema.prisma` (`MediaAsset.posts Post[]`, `Post.targets PostTarget[]`, `Post.deletedAt`) and report rather than guessing a different shape.

- [ ] **Step 3: Run the api checks**

Run: `pnpm --filter @toreroflow/api test`
Expected: all four checks pass (they cover other modules; this confirms nothing regressed).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/media.ts
git commit -m "feat: the upload list holds only videos that are not scheduled yet"
```

---

### Task 2: Failed posts appear in the queue

**Files:**
- Create: `apps/desktop/src/lib/queue.ts`
- Create: `apps/desktop/src/lib/queue.check.ts`
- Modify: `apps/desktop/package.json` (test script)
- Modify: `apps/desktop/src/screens/UploadSchedule.tsx` (both queue call sites at :569 and :581, the status line at :627-631, the actions gate at :632-666)
- Modify: `apps/desktop/src/styles.css` (one class)

**Interfaces:**
- Consumes: `PostTargetInfo` from `../lib/api` (fields: `id, postId, platform, status: "scheduled" | "publishing" | "posted" | "failed", scheduledAt: string | null, publishedAt, error: string | null, caption, assetName, thumbUrl`).
- Produces: `queueRows(posts: PostTargetInfo[], max?: number): PostTargetInfo[]` exported from `apps/desktop/src/lib/queue.ts`, used by both queue call sites.

- [ ] **Step 1: Write the failing check**

Create `apps/desktop/src/lib/queue.check.ts`:

```ts
import type { PostTargetInfo } from "./api";
import { queueRows } from "./queue";

/** Local so the file stays part of the app's typecheck without pulling in node types. */
const assert = {
  equal(actual: unknown, expected: unknown, message: string) {
    if (actual !== expected) {
      throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
    }
  },
  deepEqual(actual: unknown, expected: unknown, message: string) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) throw new Error(`${message}\n  expected: ${b}\n  actual:   ${a}`);
  },
};

/**
 * Runnable check for the queue's rows: `pnpm --filter @toreroflow/desktop test`.
 *
 * The regression this exists to prevent: a scheduled video's card now leaves
 * the upload list, so a failed post that appeared in neither place would be a
 * problem with nowhere to see it. Failures must be listed, and listed first.
 */

const row = (
  id: string,
  status: PostTargetInfo["status"],
  scheduledAt: string | null,
): PostTargetInfo => ({
  id,
  postId: `p-${id}`,
  platform: "instagram",
  status,
  scheduledAt,
  publishedAt: null,
  error: status === "failed" ? "token expired" : null,
  caption: null,
  assetName: `${id}.mp4`,
  thumbUrl: null,
});

/* Failures are listed, and sort above everything upcoming. */
{
  const rows = queueRows([
    row("a", "scheduled", "2026-07-28T10:00:00.000Z"),
    row("b", "failed", "2026-07-29T10:00:00.000Z"),
    row("c", "publishing", "2026-07-28T09:00:00.000Z"),
  ]);
  assert.deepEqual(
    rows.map((r) => r.id),
    ["b", "c", "a"],
    "failed first, then the rest by time",
  );
}

/* Scheduled rows keep their time order. */
{
  const rows = queueRows([
    row("late", "scheduled", "2026-07-30T10:00:00.000Z"),
    row("early", "scheduled", "2026-07-28T10:00:00.000Z"),
  ]);
  assert.deepEqual(rows.map((r) => r.id), ["early", "late"], "earliest scheduled first");
}

/* Posted work is done and lives in Analytics, never in the queue. */
{
  const rows = queueRows([
    row("done", "posted", "2026-07-01T10:00:00.000Z"),
    row("next", "scheduled", "2026-07-28T10:00:00.000Z"),
  ]);
  assert.deepEqual(rows.map((r) => r.id), ["next"], "posted rows are excluded");
}

/* The cap holds, and a failure never loses its place to the cap. */
{
  const many = [
    ...Array.from({ length: 6 }, (_, i) =>
      row(`s${i}`, "scheduled", `2026-07-2${i}T10:00:00.000Z`),
    ),
    row("boom", "failed", "2026-07-29T10:00:00.000Z"),
  ];
  const rows = queueRows(many);
  assert.equal(rows.length, 6, "cap honored");
  assert.equal(rows[0].id, "boom", "the failure survives the cap");
}

/* The caller's array is never reordered underneath it. */
{
  const input = [
    row("a", "scheduled", "2026-07-30T10:00:00.000Z"),
    row("b", "failed", "2026-07-28T10:00:00.000Z"),
  ];
  queueRows(input);
  assert.deepEqual(input.map((r) => r.id), ["a", "b"], "input order untouched");
}

console.log("queue rows: all checks passed");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @toreroflow/desktop exec tsx src/lib/queue.check.ts`
Expected: FAIL, cannot find `./queue`.

- [ ] **Step 3: Implement the helper**

Create `apps/desktop/src/lib/queue.ts`:

```ts
import type { PostTargetInfo } from "./api";

/**
 * The rows the queue card shows, in the order it shows them.
 *
 * Failed posts are included and sorted first. A scheduled video's card
 * leaves the upload list, so a failure listed nowhere would be a problem
 * the operator cannot see or clear. Posted work is finished and belongs to
 * Analytics, so it stays out.
 */
export function queueRows(posts: PostTargetInfo[], max = 6): PostTargetInfo[] {
  const rank = (p: PostTargetInfo): number => (p.status === "failed" ? 0 : 1);
  return posts
    .filter(
      (p) => p.status === "scheduled" || p.status === "publishing" || p.status === "failed",
    )
    .sort((a, b) => {
      const byRank = rank(a) - rank(b);
      if (byRank !== 0) return byRank;
      return (a.scheduledAt ?? "").localeCompare(b.scheduledAt ?? "");
    })
    .slice(0, max);
}
```

(`filter` already returns a fresh array, so the `sort` cannot reorder the caller's list.)

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @toreroflow/desktop exec tsx src/lib/queue.check.ts`
Expected: `queue rows: all checks passed`

- [ ] **Step 5: Wire the check into the test script**

In `apps/desktop/package.json`, change:

```json
    "test": "tsx src/lib/viewTiers.check.ts && tsx src/lib/financials.check.ts"
```

to:

```json
    "test": "tsx src/lib/viewTiers.check.ts && tsx src/lib/financials.check.ts && tsx src/lib/queue.check.ts"
```

- [ ] **Step 6: Use the helper at both call sites**

In `apps/desktop/src/screens/UploadSchedule.tsx`, add to the imports:

```ts
import { queueRows } from "../lib/queue";
```

Add this next to the other derived values in the component body (right after the `connectedCount` const around line 64):

```ts
  // One source for the queue's rows so the empty state and the list can
  // never disagree about what counts as queued.
  const queued = queueRows(posts);
```

Replace the empty-state condition, currently:

```tsx
              {posts.filter((p) => p.status === "scheduled" || p.status === "publishing")
                .length === 0 ? (
```

with:

```tsx
              {queued.length === 0 ? (
```

Replace the render list, currently:

```tsx
                posts
                  .filter((p) => p.status === "scheduled" || p.status === "publishing")
                  .slice(0, 6)
                  .map((p) => (
```

with:

```tsx
                queued.map((p) => (
```

Take care to drop exactly one closing paren level to match: the `.map((p) => (` opener is unchanged in shape, only what precedes it changes.

- [ ] **Step 7: Render the failure on the row**

Replace the status line, currently:

```tsx
                        <span>
                          <Pf p={PF_ID[p.platform]} size="sm" />{" "}
                          {p.status === "publishing" ? "publishing…" : fmtWhen(p.scheduledAt)}
                        </span>
```

with:

```tsx
                        <span className={p.status === "failed" ? "qfail" : undefined}>
                          <Pf p={PF_ID[p.platform]} size="sm" />{" "}
                          {p.status === "failed"
                            ? `Failed: ${p.error ?? "unknown error"}`
                            : p.status === "publishing"
                              ? "publishing…"
                              : fmtWhen(p.scheduledAt)}
                        </span>
```

- [ ] **Step 8: Let a failed row be cleared**

A failed post must be removable, since removing it is what brings its card back. The reschedule button stays scheduled-only (there is nothing to move about a failure).

Replace the actions gate, currently:

```tsx
                      {p.status === "scheduled" && (
                        <div className="qactions">
                          <div
                            className="iconbtn"
                            title="Change day and time"
                            onClick={() => setQueueDetail(p)}
                          >
                            <svg>
                              <use href="#i-cal" />
                            </svg>
                          </div>
```

with:

```tsx
                      {(p.status === "scheduled" || p.status === "failed") && (
                        <div className="qactions">
                          {p.status === "scheduled" && (
                            <div
                              className="iconbtn"
                              title="Change day and time"
                              onClick={() => setQueueDetail(p)}
                            >
                              <svg>
                                <use href="#i-cal" />
                              </svg>
                            </div>
                          )}
```

The remove button that follows it is unchanged, and its title already reads "Remove from queue".

- [ ] **Step 9: One line of CSS**

Append to `apps/desktop/src/styles.css`:

```css
.qfail{color:var(--red)}
```

- [ ] **Step 10: Test and typecheck**

Run: `pnpm --filter @toreroflow/desktop test && pnpm --filter @toreroflow/desktop typecheck`
Expected: three checks pass, typecheck exit 0.

- [ ] **Step 11: Commit**

```bash
git add apps/desktop/src/lib/queue.ts apps/desktop/src/lib/queue.check.ts apps/desktop/package.json apps/desktop/src/screens/UploadSchedule.tsx apps/desktop/src/styles.css
git commit -m "feat: failed posts show in the queue where they can be cleared"
```

---

### Task 3: The card acknowledges and leaves

**Files:**
- Modify: `apps/desktop/src/styles.css` (append the animation block)
- Modify: `apps/desktop/src/screens/UploadSchedule.tsx` (new state, card wrapper, overlay, `onScheduled`)

**Interfaces:**
- Consumes: `load` and `loadPosts` (both `useCallback`s already in the component, at :92 and :68), `scheduling` state holding the `MediaAssetInfo` being scheduled (:53).
- Produces: no exported API. The card list renders each asset inside a `.jobwrap` element that carries the `departing` class while the animation runs.

- [ ] **Step 1: Add the CSS**

Append to `apps/desktop/src/styles.css`:

```css
/* Schedule confirmation. The ring and tick draw themselves with
   stroke-dashoffset, then the row collapses using the grid-rows technique
   .pexpand already uses, so the cards below slide up instead of jumping.
   The delays match the plan: tick at 300ms, collapse at 600ms. */
.jobwrap{display:grid;grid-template-rows:1fr;transition:grid-template-rows .32s cubic-bezier(.2,.7,.2,1) .6s,opacity .32s ease .6s}
.jobwrap>.job{position:relative}
.jobwrap.departing{grid-template-rows:0fr;opacity:0}
.jobwrap.departing>.job{overflow:hidden;min-height:0;margin-top:0;transition:margin-top .32s cubic-bezier(.2,.7,.2,1) .6s}
.schedok{position:absolute;inset:0;z-index:5;display:grid;place-items:center;background:rgba(10,14,26,.55);border-radius:inherit;pointer-events:none}
.okmark{width:64px;height:64px}
.okmark circle,.okmark path,.failmark circle,.failmark path{fill:none;stroke-width:3;stroke-linecap:round;stroke-linejoin:round}
.okmark circle,.okmark path{stroke:var(--green)}
.okmark circle{stroke-dasharray:145;stroke-dashoffset:145;animation:draw .34s cubic-bezier(.2,.7,.2,1) forwards}
.okmark path{stroke-dasharray:36;stroke-dashoffset:36;animation:draw .26s cubic-bezier(.2,.7,.2,1) .3s forwards}
@keyframes draw{to{stroke-dashoffset:0}}
@media (prefers-reduced-motion:reduce){
  .jobwrap,.jobwrap.departing>.job{transition:none}
  .okmark circle,.okmark path{animation:none;stroke-dashoffset:0}
}
```

(`.failmark` is styled alongside `.okmark` here because they share the stroke geometry; its own colour and paths arrive in Task 4.)

- [ ] **Step 2: Add the departing state**

In `apps/desktop/src/screens/UploadSchedule.tsx`, add after the `savedFlash` state (line 50):

```ts
  const [departing, setDeparting] = useState<string | null>(null);
```

- [ ] **Step 3: Wrap the card and add the overlay**

Replace the opening of the card, currently:

```tsx
              return (
                <div className="job glass-sm" key={asset.id}>
```

with:

```tsx
              return (
                <div
                  className={`jobwrap${departing === asset.id ? " departing" : ""}`}
                  key={asset.id}
                >
                  <div className="job glass-sm">
                    {departing === asset.id && (
                      <div className="schedok" aria-hidden="true">
                        <svg className="okmark" viewBox="0 0 52 52">
                          <circle cx="26" cy="26" r="23" />
                          <path d="M15 27l8 8 15-16" />
                        </svg>
                      </div>
                    )}
```

Then close the new wrapper. The card's JSX runs to roughly line 551, ending with the `</div>` that closes `.job` immediately before the `);` that closes this `return`. Add one more `</div>` after that one so the wrapper closes too:

```tsx
                  </div>
                </div>
              );
```

The card's inner JSX is otherwise untouched. Do not reindent it: a whitespace-only reformat of 190 lines would bury the real change in review. Confirm the nesting by running the typecheck in Step 5, which fails loudly on an unbalanced tag.

- [ ] **Step 4: Rewire onScheduled**

Replace, currently at :695:

```tsx
          onScheduled={() => void loadPosts()}
```

with:

```tsx
          onScheduled={() => {
            // The modal calls this and then closes, so `scheduling` still
            // holds the asset that just went out. The queue refreshes at
            // once; the card holds for its animation and only then refetches,
            // so the list ends up authoritative rather than merely looking
            // right.
            const departingId = scheduling?.id ?? null;
            void loadPosts();
            if (!departingId) return;
            setDeparting(departingId);
            window.setTimeout(() => {
              setDeparting((d) => (d === departingId ? null : d));
              void load();
            }, 950);
          }}
```

- [ ] **Step 5: Typecheck and test**

Run: `pnpm --filter @toreroflow/desktop typecheck && pnpm --filter @toreroflow/desktop test`
Expected: exit 0, three checks pass.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/styles.css apps/desktop/src/screens/UploadSchedule.tsx
git commit -m "feat: a scheduled card checks off and leaves the list"
```

---

### Task 4: The failure draws an X in the modal

**Files:**
- Modify: `apps/desktop/src/modals/ScheduleModal.tsx:465`
- Modify: `apps/desktop/src/styles.css` (append the failmark colour and paths)

**Interfaces:**
- Consumes: `@keyframes draw` and the shared stroke geometry from Task 3's CSS block.
- Produces: nothing exported.

- [ ] **Step 1: Add the mark to the error block**

In `apps/desktop/src/modals/ScheduleModal.tsx`, replace line 465:

```tsx
        {error && <div className="autherr">{error}</div>}
```

with:

```tsx
        {/* Keyed by the message so a second, different failure redraws. */}
        {error && (
          <div className="autherr" key={error}>
            <svg className="failmark" viewBox="0 0 52 52" aria-hidden="true">
              <circle cx="26" cy="26" r="23" />
              <path d="M18 18L34 34M34 18L18 34" />
            </svg>
            {error}
          </div>
        )}
```

- [ ] **Step 2: Add the CSS**

Append to `apps/desktop/src/styles.css`:

```css
.failmark{width:30px;height:30px;vertical-align:-8px;margin-right:6px}
.failmark circle,.failmark path{stroke:var(--red)}
.failmark circle{stroke-dasharray:145;stroke-dashoffset:145;animation:draw .34s cubic-bezier(.2,.7,.2,1) forwards}
.failmark path{stroke-dasharray:46;stroke-dashoffset:46;animation:draw .26s cubic-bezier(.2,.7,.2,1) .3s forwards}
@media (prefers-reduced-motion:reduce){
  .failmark circle,.failmark path{animation:none;stroke-dashoffset:0}
}
```

- [ ] **Step 3: Typecheck and test**

Run: `pnpm --filter @toreroflow/desktop typecheck && pnpm --filter @toreroflow/desktop test`
Expected: exit 0, three checks pass.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/modals/ScheduleModal.tsx apps/desktop/src/styles.css
git commit -m "feat: a failed schedule draws an X beside the reason"
```

---

### Task 5: Final review, rebuild, live walk (orchestrator, not a subagent)

No files. After all tasks and the whole-branch review.

- [ ] **Step 1: Full sweep**

`pnpm --filter @toreroflow/api test`, `pnpm --filter @toreroflow/desktop test`, and `pnpm -r typecheck`. All green.

- [ ] **Step 2: Rebuild and reinstall**

`pnpm tauri build` from `apps/desktop`, then the silent NSIS reinstall and relaunch, since both the screen and the modal changed.

- [ ] **Step 3: The walk**

1. Schedule a ready video: the modal closes, the check draws on the card, the card collapses away with the cards below sliding up, and a queue row appears on the right. Leave the screen and come back, then restart the app: the card is still gone.
2. Remove that post from the queue: the card returns to the upload list.
3. Stop the API, then schedule: the modal stays open, the red X draws beside the error, and the platform picks and options are still set. Restart the API and retry from the same modal.
4. A failed post appears in the queue above the upcoming ones with its reason, and its remove button clears it and restores the card. If no natural failure is available, set one target's status to `failed` directly in Postgres rather than breaking a real publish.
5. Turn Windows animation effects off and repeat step 1: the check appears without drawing and the card leaves at once.

- [ ] **Step 4: Ledger**

Update `.superpowers/sdd/progress.md`. Record any deferred Minors from the reviews.
