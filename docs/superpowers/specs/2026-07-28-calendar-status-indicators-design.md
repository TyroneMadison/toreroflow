# Calendar status indicators: what is out, what is going out, and what you can still move

Date: 2026-07-28
Status: approved
Source: "List of improvments for the app.md", item 10 (line 200).

## Context

Item 10 asks for three things on the content calendar: a status indicator
that pulses for posted, publishing and not-yet-posted; a legend above the
calendar explaining each one; and a lock icon on posts that can no longer be
dragged versus an unlock icon on the ones that can.

What the code does today:

- `CalendarScreen.tsx:39-44` maps status to a plain text suffix
  (`""`, `" · publishing"`, `" · posted"`, `" · failed"`). That suffix is
  the entire status signal in every view.
- `EV_CLASS` (`CalendarScreen.tsx:23-29`) colors the week and day card's
  3px left bar by platform *family*: violet for Instagram and Snapchat,
  blue for TikTok, YouTube and Facebook. The rule lives in
  `styles.css:208-209` as `.ev::before` plus `.ev.v` / `.ev.b`.
- `EV_DOT` (`CalendarScreen.tsx:31-37`) colors the month row's dot by exact
  platform. The dot is `.mev .d` (`styles.css:454`).
- Drag is allowed only when the status is `scheduled`. That rule is written
  by hand in four places: `CalendarScreen.tsx:199`, `CalendarScreen.tsx:373`,
  `PostDetailModal.tsx:33`, and `UploadSchedule.tsx:737`.
- The server enforces the same rule a fifth time:
  `PATCH /posts/targets/:id/reschedule` returns 409 "only scheduled posts
  can move" (`apps/api/src/routes/posts.ts:246-248`).
- Nothing on the calendar pulses, and there is no legend.
- The note under the calendar (`CalendarScreen.tsx:404-407`) tells the
  operator that "Posts are color-coded by platform".
- `PostDetailModal` renders a `.pdstatus` pill whose CSS
  (`styles.css:631-635`) colors scheduled violet, posted green and failed
  red. There is no `.pdstatus.publishing` rule at all, so a publishing post
  gets the unstyled base pill.

Three facts that shaped the design:

- Every color this design needs already exists: `--green` `#57d6a0`,
  `--amber` `#ffcf6b`, `--b` `#4ea8ff` and `--red` `#ff6b7a`
  (`styles.css:12-16`).
- A pulse already exists. `.livedot` runs the `livepulse` keyframe
  (`styles.css:343-351`) and already honors `prefers-reduced-motion` by
  dropping to a steady full-opacity dot rather than disappearing.
- The lock is not a new rule. It is the rule the server has always
  enforced, drawn for the first time.

## Decisions

### Red stays reserved for failure

Item 10 describes the not-yet-posted state as having "the red indicator".
Red already means failed everywhere in this app: the failed queue row, the
red X, the red border on a failed calendar card. If scheduled were also
red, a calendar full of healthy scheduled work would look exactly like a
calendar full of broken posts, and the one color meant to make the operator
look twice would stop meaning anything.

Scheduled is blue. Red is kept for the state that needs a human.

### The four states

| State | Dot | Motion | Icon | Meaning |
|---|---|---|---|---|
| `scheduled` | `--b` blue | steady | open padlock | Waiting. Drag it anywhere. |
| `publishing` | `--amber` | pulsing | padlock | Going out right now. Cannot move. |
| `posted` | `--green` | steady | padlock | Out. Cannot move. |
| `failed` | `--red` | pulsing | warning triangle | Did not go out. Needs attention. |

### Only live or broken things move

Taken literally, item 10 pulses posted, publishing and scheduled, which on
a normal month means thirty-plus dots blinking permanently. When everything
moves, nothing stands out, and a failure loses its urgency.

Motion means "this needs your eyes now". Publishing and failed pulse.
Posted is finished and scheduled is merely waiting, so both are steady.
Under `prefers-reduced-motion` the pulsing dots go steady and keep their
color, matching how `.livedot` already behaves.

### Failed gets a warning triangle, not a padlock

A failed post cannot be dragged either, so by the drag rule it is locked.
But a padlock reads as "this is handled", which is the opposite of true.
The icon slot always answers "why can't I move this", and for a failure
that answer is "because it broke", not "because it is done".

### The status takes the accent bar, and the dot leads the row

The card's left bar is repurposed from platform family to status. This
costs nothing: the bar only ever distinguished two groups, and the exact
platform is already named by the `Pf` icon sitting next to it.

In the month view the row's dot becomes the status dot and the platform
moves to its `Pf` icon, so both views end up with the same anatomy: status
dot, platform icon, time, then the lock icon pushed right.

`EV_CLASS` and `EV_DOT` both become unused and are deleted, along with the
`.ev.v` / `.ev.b` rules and the inline red `borderColor` on failed cards
(`CalendarScreen.tsx:209`), which is folded into the status class.

### The status word stays in week and day, and goes in month

The week and day card has room for all three signals, and each has a
distinct job: the dot is what the eye catches, the word is precise, and the
icon says whether you can drag it. The month row is 9.5px tall and cannot
hold a word once the platform icon and the lock are in it, so the suffix
comes out of that view only.

Color is never the sole carrier: the dot takes an `aria-label` naming the
status in both views, and the existing `title` attribute keeps saying it in
plain words.

### One source of truth

`apps/desktop/src/lib/postStatus.ts` is the only place that knows what a
status looks like or whether it can move. Both calendar views, the legend
and the detail modal's pill read from it.

The drag rule is currently hand-written in four components and enforced
independently by the server. When those drift, the app invites a drag the
server will reject with a 409. One `canMove(status)` that every caller
routes through removes that whole class of bug.

### The detail modal joins the same language

`.pdstatus` currently colors scheduled violet where the calendar will color
it blue, and has no rule at all for publishing. Since the modal opens
directly from a calendar card, leaving it would mean two color languages
one click apart. It adopts the four colors.

## What gets built

### 1. `apps/desktop/src/lib/postStatus.ts`

Pure. Its only import is the status type, taken from the existing
`PostTargetInfo` so a fifth status can never be added to the API without
this file failing to compile:

```ts
import type { PostTargetInfo } from "./api";

export type PostStatus = PostTargetInfo["status"];

export interface StatusMeta {
  /** The word on a week or day card. */
  label: string;
  /** What the legend adds after the label. */
  hint: string;
  /** Pulses to pull the eye. Only what is live or broken. */
  pulses: boolean;
  /** Whether the operator can drag it. The server agrees. */
  movable: boolean;
  icon: "lock" | "unlock" | "alert";
}

export const POST_STATUS: Record<PostStatus, StatusMeta>;

/** The one drag rule. Every caller routes through this. */
export function canMove(status: PostStatus): boolean;
```

The CSS class is the status name itself (`st-scheduled`, `st-publishing`,
`st-posted`, `st-failed`), so no separate tone field exists to fall out of
sync with the record's key.

Legend order is the lifecycle: scheduled, publishing, posted, failed.

| Status | `label` | `hint` |
|---|---|---|
| `scheduled` | Scheduled | drag to move |
| `publishing` | Publishing | going out now |
| `posted` | Posted | locked |
| `failed` | Failed | needs attention |

A card renders `label`. The legend renders `label`, a comma, then `hint`.
The two are split rather than one string sliced at the comma, because a
card silently showing "Publishing now" the day someone reworded a hint is
the kind of coupling nobody expects to find.

### 2. `apps/desktop/src/lib/postStatus.check.ts`

Assert-style, run by `pnpm --filter @toreroflow/desktop test`, matching
`viewTiers.check.ts` and `queue.check.ts`.

It pins:

- each status to its icon, its pulse and its movability;
- that exactly one status is movable, so making posted draggable fails the
  check before it reaches the app;
- that `canMove` agrees with `POST_STATUS[s].movable` for all four;
- that every status has a non-empty label and hint;
- that only a status which cannot move gets the `lock` icon, and the one
  that can gets `unlock`, so the icon can never contradict the drag rule.

### 3. Icons

`IconDefs.tsx` gains three stroke-based symbols in the existing style:
`#i-lock`, `#i-unlock` and `#i-alert`. None of the three exists today.

### 4. `CalendarScreen.tsx`

- `STATUS_SUFFIX`, `EV_CLASS` and `EV_DOT` are deleted.
- `renderEvent` draws: status dot, `Pf` platform icon, time, then
  `· <label>` keeping the existing separator, then the status icon pushed
  right. The card carries `st-<status>` and `draggable={canMove(t.status)}`.
- The month row draws: status dot, `Pf` platform icon, time, status icon.
  No label.
- A legend row renders directly above the grid, inside `.stage`, in all
  three views, built by mapping `POST_STATUS` so it cannot drift from what
  the cards draw. Its dots carry the same colors and the same pulse as the
  cards, so it is a true key rather than a description of one.
- The note under the calendar is rewritten. It currently claims posts are
  color-coded by platform, which this change makes false.

### 5. `PostDetailModal.tsx`

`editable` becomes `canMove(target.status)`. The status pill reads its
label from `POST_STATUS`.

### 6. `UploadSchedule.tsx`

`draggable={p.status === "scheduled"}` becomes `canMove(p.status)`. The
queue's drag is a different gesture (swapping two slots) but the same rule,
and this is the fourth hand-written copy.

### 7. `styles.css`

- `.ev.v` and `.ev.b` are replaced by `.ev.st-*`, which set the left bar
  color and, for failed, the border color the inline style used to set.
- `.stdot` is the shared dot, with `.stdot.pulse` reusing the existing
  `livepulse` keyframe rather than adding a second animation.
- One `prefers-reduced-motion` rule covering `.stdot`, matching the
  `.livedot` treatment: animation off, opacity 1.
- `.callegend` for the legend row.
- `.pdstatus.scheduled` moves from violet to `--b`, and
  `.pdstatus.publishing` is added.

## Out of scope, deliberately

**Overdue posts.** A scheduled post whose time has passed but which never
published, which is what happens when the worker is down, keeps showing
blue "scheduled" rather than turning into an overdue state. That is a real
gap worth having, but it is a fifth state with its own rules about when it
triggers and what the operator can do about it, and folding it in here
would roughly double the item. It belongs on the list as its own entry.

**Making failed posts draggable.** Recovery today is to remove the post
from the queue and reschedule from the upload card, which item 7 built on
purpose. Dragging a failed post would mean re-queueing a job that already
ran. This item makes the existing rule visible; it does not change it.

**The "posts scheduled in view" counter** in the topbar, which counts
scheduled plus publishing, is left alone.

## Verification

- `pnpm --filter @toreroflow/desktop test` passes, including the new check.
- All seven workspace projects typecheck.
- A live walk in the rebuilt installed app: the legend is visible in day,
  week and month; a scheduled post shows a blue steady dot and an open
  padlock and can be dragged to another day; a posted post shows a green
  steady dot and a padlock and refuses the drag; a failed target shows a
  red pulsing dot and a warning triangle; the detail modal's pill matches
  the dot color for each. A publishing post is verified by setting a target
  to `publishing` directly, since catching the real window is a race.
