# Schedule confirmation: the card leaves, and the outcome is visible

Date: 2026-07-28
Status: approved
Source: "List of improvments for the app.md", item 7 (line 173).

## Context

Item 7 asks that scheduling a video make its whole card disappear, with a
green check circle animation on success and a circular X animation when
something goes wrong.

What the code does today:

- `GET /clients/:id/media` (`apps/api/src/routes/media.ts:168-172`) returns
  every asset the client has ever uploaded, ordered newest first, with no
  status filter of any kind.
- On a successful schedule, `ScheduleModal`'s `onScheduled` runs
  `loadPosts()` only (`apps/desktop/src/screens/UploadSchedule.tsx:695`),
  which refetches the queue on the right. The asset list is never
  refetched, and nothing about the asset changes.
- So the card never disappears. It sits in the list forever, can be
  scheduled again and again, and the only feedback is a row appearing in
  the other column. There is no success toast on schedule either, so the
  new animation is the first real confirmation the operator gets.
- No exit animation exists anywhere in the app. `.job` has no transition
  at all. The house easing is `cubic-bezier(.2,.7,.2,1)`, and
  `prefers-reduced-motion` is honored per component in two places
  (`.toast`, `.livedot`) rather than globally.
- `#i-check` and `#i-x` already exist in the sprite
  (`apps/desktop/src/components/IconDefs.tsx`), both stroke-based.

Two facts that shaped the design:

- Removing a post from the queue hard-deletes the `PostTarget` row, and
  deletes the `Post` when the last target goes
  (`apps/api/src/routes/posts.ts:231-252`). So "the card comes back when
  you unqueue it" needs no stored state: it falls out of the data.
- The queue list only renders targets whose status is `scheduled` or
  `publishing` (`UploadSchedule.tsx:569`). A `failed` target appears
  nowhere on this screen, so hiding cards without addressing that would
  let a video be hidden while carrying an invisible problem.

Confirmed safe: `GET /clients/:id/media` has exactly one consumer, this
screen. The "Videos this period" counter reads its own endpoint
(`GET /clients/:id/quota`) and counts uploads server side, so filtering
the list cannot disturb it. That counter is item 8 and is untouched here.

## Decisions

- **The upload list means "not yet scheduled".** An asset drops out once
  it has a post that is `scheduled`, `publishing`, or `posted`. The rule
  lives in the database query, so it survives restarts and brand
  switches.
- **A failed-only asset keeps its card.** Nothing was published, so
  rescheduling is safe and the operator can fix it where they expect to.
- **An asset with any live target stays hidden even if a sibling target
  failed.** Rescheduling a partly published video would double post to
  the platforms that already succeeded, which is worse than the failure
  being one screen away.
- **Failed targets join the queue list**, sorted above the upcoming ones,
  which is what makes hiding safe: a hidden card can never mean an
  invisible problem. Removing a failed post from the queue restores its
  card, closing the loop.
- **The success animation plays on the card, the failure animation plays
  in the modal.** On failure the modal must stay open, because the
  platform picks and per-platform options live in it and losing them
  costs more than the error does. Putting the X beside the inline error
  keeps the signal where the operator is already looking.
- **The card animates before the refetch, not after.** The screen marks
  the departing asset by id (the established `savedFlash` idiom), plays
  the animation, and only then calls `load()`, so the list is
  authoritative rather than merely looking right.
- **The queue refetch fires immediately**, in parallel with the
  animation, so the new queue row appears as the card leaves.
- **Both animations honor `prefers-reduced-motion`**, following the
  per-component `.toast` precedent rather than assuming a global reset.

## Design

### 1. The hide rule

`apps/api/src/routes/media.ts`, the `GET /clients/:id/media` query gains:

```ts
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
```

Read plainly: return assets for which no live post exists. A soft-deleted
post does not count, and neither does a post whose every target failed.
`assetView` and the response shape are unchanged.

### 2. The success animation

`apps/desktop/src/screens/UploadSchedule.tsx`:

- New state `departing: string | null`, the id of the asset playing its
  farewell.
- `onScheduled` captures `scheduling.id` before the modal unmounts (the
  modal calls `onScheduled()` then `onClose()` in the same tick), fires
  `loadPosts()` immediately, sets `departing`, and after the animation
  completes clears it and calls `load()`.
- The card gains a `departing` class and renders a check overlay while it
  is leaving.

Timing, all on the house easing:

| Stage | Start | Duration |
|---|---|---|
| Ring draws | 0ms | 340ms |
| Tick draws | 300ms | 260ms |
| Card collapses | 600ms | 320ms |
| `load()` refetch | 950ms | - |

The overlay is a 52x52 SVG drawn with `stroke-dasharray` and
`stroke-dashoffset`, in `var(--green)`. The collapse animates
`grid-template-rows` from `1fr` to `0fr` with `overflow: hidden`, the
technique already used by `.pexpand`
(`apps/desktop/src/styles.css:685`), so the cards below slide up rather
than jumping when the row is removed.

### 3. The failure animation

`apps/desktop/src/modals/ScheduleModal.tsx`: the existing `.autherr`
block gains a small X mark drawn the same way in `var(--red)`, 340ms for
the ring and 260ms for the two strokes. The modal stays open, the error
text and the existing `toast.fail` are unchanged, and the operator's
options survive for a retry.

### 4. Failed posts in the queue

The queue's row selection currently lives inline twice, once for the
empty check and once for the render. It moves to a pure function in
`apps/desktop/src/lib/queue.ts`:

```ts
export function queueRows(posts: PostTargetInfo[], max = 6): PostTargetInfo[]
```

It keeps `scheduled`, `publishing`, and `failed`; sorts failed first,
then by `scheduledAt` ascending; and caps at `max`. Both call sites use
it, so the empty state and the list can never disagree. A failed row
renders with the existing red styling and its error text, and keeps the
existing remove control.

### 5. Checks

`apps/desktop/src/lib/queue.check.ts`, in the repo's no-framework style
with the local `assert` object that `viewTiers.check.ts` uses, wired into
the desktop `test` script. It pins: failed rows are included and sort
above scheduled ones, scheduled rows keep time order, `posted` rows are
excluded, and the cap is honored while still preferring failures.

The hide rule is a database query and the animations are CSS, so both are
proven in the live walk rather than by a check.

## Out of scope, recorded so it is not lost

- The "Videos this period" counter (item 8).
- Any change to drafts, Save copy, or the revision toggle.
- Surfacing failed posts anywhere beyond this screen's queue list.
- An undo for a scheduled post; the queue's remove control already is
  one, and it restores the card.

## Verification

On the installed app with the full stack running:

1. Schedule a ready video: the modal closes, the green check draws on the
   card, the card collapses away, the queue row appears on the right, and
   the card is still gone after switching screens or restarting the app.
2. Remove that post from the queue: the card returns to the upload list.
3. Force a failure (schedule with the API stopped): the modal stays open,
   the red X draws beside the error, the chosen platforms and options are
   still there, and the card is untouched.
4. A failed post appears in the queue list above the upcoming ones with
   its reason, and removing it restores the card.
5. With Windows "Show animations" turned off, the check and X appear
   without drawing and the card leaves immediately.
6. `pnpm --filter @toreroflow/desktop test` and `pnpm -r typecheck` pass.
