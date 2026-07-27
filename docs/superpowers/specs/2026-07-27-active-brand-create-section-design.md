# Active brand: make switching the Create section actually work

Date: 2026-07-27
Status: approved
Source: "List of improvments for the app.md", item 1

## Context

The improvement list asks for the entire Create section (Upload & Schedule,
Content Calendar, Workflows) to be tied to the active brand, so each brand has
its own isolated data and switching brands switches everything.

Investigation found the isolation already exists. `MediaAsset`, `Post`,
`Workflow`, `ScheduleSlot`, and the quota columns all carry a client key, and
all three Create screens fetch through `/clients/:id/...` endpoints that
filter by client on the server. No client id is hardcoded anywhere in the
desktop app.

What is broken is the switching experience. Six defects together make the app
feel like it is stuck on one brand:

1. Onboarding a new brand does not make it active. Only the first brand ever
   auto-selects (`ConnectClientModal.tsx:50` guards on `clients.length === 0`).
2. A missing or stale selection is cleared to null and never replaced
   (`AppState.tsx:98-103`), leaving all three Create screens empty forever.
3. Screens are not re-keyed on brand switch (`App.tsx:147,150,171` use
   constant keys). Typed drafts, open modals, and calendar position survive
   the switch.
4. A failed refetch silently keeps the previous brand's rows on screen
   (empty catch blocks at `UploadSchedule.tsx:73-75,91-93` and
   `CalendarScreen.tsx:97-99`).
5. The calendar's brand chip is a static label, not a filter, and reads
   "All brands" when nothing is selected while showing zero posts
   (`CalendarScreen.tsx:286-289`).
6. `ScheduleModal` reads its account list from `selectedClient`
   (`ScheduleModal.tsx:23-30`), so a brand change while the modal is open
   offers the wrong accounts.

## Decisions

- Scope is the switching experience only. Workflow execution (workflows are
  stored per brand but nothing runs them) is deliberately out of scope and
  tracked as future work.
- Onboarding a new brand always makes it the active brand.
- One brand at a time everywhere in the Create section. No all-brands view.
- No database or API changes. The server-side scoping is already correct.

## Design

### 1. Onboarding switches to the new brand

`ConnectClientModal` calls `selectClient(client.id)` unconditionally after a
successful create, instead of only when the list was empty.

### 2. There is always an active brand when brands exist

In `AppState`, when the clients list loads or changes and the current
selection is null or points at a client that no longer exists, select the
first client in the list. Selection remains null only when there are no
clients at all.

### 3. Brand switch fully resets the Create screens

`App.tsx` keys the Upload & Schedule, Calendar, and Workflows screens on the
selected client id (`key={selectedClientId}`), so React remounts them on
every switch. Component state (typed titles and drafts, open schedule and
detail modals, calendar view and anchor, workflow create form) resets to a
clean slate. This also closes defect 6 for the switching case, because the
schedule modal cannot outlive a switch.

### 4. A failed refresh never shows the wrong brand's data

The catch blocks in `UploadSchedule` (media list, queue) and `CalendarScreen`
(posts) clear their rows and raise an error toast through the existing toast
system, instead of keeping stale rows silently. The screen shows its normal
empty state plus the toast.

### 5. The calendar chip tells the truth

The chip shows the active brand's name and color dot. With no brand selected
it reads "No brand selected". The "All brands" fallback text is removed.

## Out of scope, recorded so it is not lost

- Workflow execution. The Workflows screen is display-only today; nothing in
  the worker reads the `Workflow` model. Making workflows drive publishing is
  its own future item.
- Backend hardening: per-asset and per-target mutation endpoints verify
  agency ownership but not brand ownership, `PostTarget` has no direct
  `clientId`, and `Job` rows carry no client or agency key. None of this is
  reachable from the UI after this change; worth closing if a second operator
  or client-facing surface ever appears.
- `ScheduleModal` still derives accounts from `selectedClient` rather than
  from the asset's own client. Safe after re-keying, since the modal and the
  asset list always share one brand; noted as a latent trap if the modal is
  ever reused outside that screen.

## Verification

Live app walk with a throwaway second brand, then clean up:

1. Onboard a test brand. Expect: it becomes active immediately, Upload,
   Calendar, and Workflows are empty, quota widget shows the new brand's
   quota.
2. Switch back to Caleb. Expect: his uploads, calendar, and workflows exactly
   as before.
3. Start typing a title on Caleb, switch brands. Expect: the draft is gone on
   return, nothing leaks to the test brand.
4. Open the schedule modal, switch brands. Expect: the modal is closed.
5. Stop the API, switch brands. Expect: empty screens plus an error toast,
   never Caleb's rows under the test brand's name.
6. Delete the test brand while it is active. Expect: selection falls back to
   Caleb, screens show his data.
7. Confirm the calendar chip names the active brand, and "No brand selected"
   appears only when no brands exist.
