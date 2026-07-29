# What to do next: generated in the background, delivered as a PDF

Date: 2026-07-28
Status: approved
Source: "List of improvments for the app.md", item 11 (line 203).

## Context

Item 11 asks that pressing Generate inside "What to do next" not trap the
operator at the screen: the work should run in the background, and the
results should show up in a PDF.

What the code does today:

- `ClientInsightsModal.generate()`
  (`apps/desktop/src/modals/ClientInsightsModal.tsx:39-58`) awaits
  `POST /clients/:id/suggestions` and holds the modal open behind a
  "Thinking…" button.
- That route (`apps/api/src/routes/clients.ts:977-1056`) calls Anthropic
  inline and returns the parsed suggestions in the response body. The
  request is open for the whole model call.
- Nothing is persisted. The suggestions live only in React state, so
  closing the modal destroys them and the only way back is to pay for the
  model call again.
- There is no PDF. Suggestions render as `.sugg` rows inside the modal and
  nowhere else.
- The Account Overview screen refetches `/overview` when the client list
  changes and on a manual Refresh
  (`AccountOverviewScreen.tsx:180-182`). It has no interval poll.

Facts that shaped the design:

- The worker already holds an Anthropic client and `STORAGE_DIR`
  (`apps/worker/src/env.ts:12-14`, `apps/worker/src/index.ts:12-13`) and
  already runs three queues: `media`, `publish` and `analytics`
  (`apps/worker/src/index.ts:628-648`). Background work has an established
  home.
- `renderReportPdf` (`apps/api/src/reports/renderPdf.ts`) prints HTML with
  a headless Chrome already on the machine. It is API-local today, and both
  apps already depend on `@toreroflow/media`.
- PDFs are written under `STORAGE_DIR` and served at `/files/<key>`
  (`apps/api/src/routes/reports.ts:158-161`).

## Decisions

### The API stops waiting for the model

`POST /clients/:id/suggestions` no longer calls Anthropic. It marks the
client's insight row `running`, enqueues a job, and returns 202
immediately. The model call and the PDF render both move to the worker.

This is what the item actually asks for. It also removes a request that
could sit open for thirty seconds against an API with no timeout in front
of it.

### A second click cannot stack a second model call

The job's `jobId` is the client id. While a run exists, BullMQ refuses a
duplicate, so a double click costs nothing. The route also returns the
existing row rather than starting again when one is already `running`.

Without this, an impatient second press bills a second Anthropic call and
races the first one's write.

### One row per client, not a history

`ClientInsight` has a unique `clientId` and is upserted per run. The item
asks what to do next, and next has one answer. A growing pile of stale
advice is a list nobody reads, which is the same reasoning that made
`SystemAlert` rows delete themselves when the check passes.

### The PDF is the thing the client receives

Revised 2026-07-29, after review. The first build treated this as internal
notes. It is the opposite: Tyrone hands this document to the client as their
game plan, so it carries the Torerone brand and speaks to them directly.

Consequences, all of them load-bearing:

- **It is written to the client, as "you".** No mention of the agency, the
  app, dashboards or analytics tooling. The client sees steps, never the
  machinery. The first version told them to "Build 3 workflows in Toreroflow
  this week", which is Tyrone's job, not theirs.
- **Sixth grade reading level, fewest possible words.** Metric names are
  translated: "how long people watch", not "average watch time".
- **No em dashes, no en dashes, no arrows, ever.** They read as machine
  output. See the enforcement decision below.
- **Design follows `Torerone_Portfolio_Canva.pptx.pdf`**, whose exact
  palette and typefaces were read out of the file: page `#0B0B10`, cards
  `#14141C` with `#282834` borders, coral `#FF6F61` accent, cool grey body
  text `#A6A6B4` / `#B9B9C6`, headlines in Anton and body in Montserrat.
  Neither font is installed on the machine and the render has no network, so
  both are embedded in the template as base64 data URIs. Originals and
  licence notes live in `assets/fonts/`; both are SIL OFL 1.1, which permits
  this. A linked or system font would have silently fallen back to something
  that is not the brand, which is the failure mode worth paying 75KB to
  avoid.
- **One page.** Spacing is tuned so six steps and the header fit on a single
  Letter page, because a plan someone has to turn over is a plan they read
  half of.

It still lives in `${clientId}/insights/`, away from `reports/`, because the
report folder is what the Netlify publisher sweeps onto the public web.
These are two different ways of reaching a client and they stay apart.

### The punctuation rule is enforced in code, not asked for in a prompt

`packages/core/src/plainText.ts` strips em dashes, en dashes, arrows in
every common shape including the ASCII ones, smart quotes and ellipses, and
the worker runs every field through it before storing.

A prompt is a request. This document goes to a paying client under Tyrone's
name, and one run in ten will still produce an em dash however firmly it is
told not to. The check pins real strings that came back from the model.

### One fixed file name

`what-to-do-next.pdf`, overwritten per run. A dated name left every
superseded plan on disk with nothing pointing at it. The date the client
cares about is printed on the page. Because the path is now stable, both
routes stamp the URL with the run's completion time so a viewer can never
serve the previous plan from cache.

### The renderer moves to `packages/media`

Two apps now print PDFs. `renderPdf.ts` moves out of `apps/api/src/reports/`
into `packages/media`, which the API and the worker already both depend on.
The alternative is a second copy in the worker, and a divergent PDF
renderer is a bug that only shows up in a printed document.

### Failure is stored, not just logged

A failed run writes `failed` plus the message to the row, so reopening the
modal says what went wrong. The existing 503 for a missing
`ANTHROPIC_API_KEY` keeps its exact wording, since the fix is the whole
message. That check stays on the route, where it can still answer
immediately rather than costing a queue round trip to say "no key".

## What gets built

### 1. `packages/media`: `renderPdf.ts` moved

Moved verbatim, exported from the package index. The API's import in
`routes/reports.ts` changes to the package. `findBrowser` moves with it,
since the reports route uses it for its own precheck.

### 2. `packages/db`: the `ClientInsight` model

```prisma
model ClientInsight {
  id          String    @id @default(cuid())
  clientId    String    @unique
  status      String    // running | ready | failed
  suggestions Json?
  storageKey  String?
  error       String?
  requestedAt DateTime  @default(now())
  completedAt DateTime?
  client      Client    @relation(fields: [clientId], references: [id], onDelete: Cascade)
}
```

`onDelete: Cascade` because an insight about a deleted client is nothing.
Migration is hand-written SQL plus `migrate:deploy`, per this repo.

### 3. `packages/core`: `insightStatus.ts`

The status strings and the one rule the UI and the API both need: whether a
run is in flight. Pure, with a runnable check, so the API's "already
running" guard and the modal's polling condition cannot disagree.

### 4. `apps/api`

- `POST /clients/:id/suggestions`: keeps the 503 key check, then upserts
  `running` and enqueues on the `insights` queue with `jobId` = client id.
  Returns 202 with the row. Returns the existing row unchanged when one is
  already running.
- `GET /clients/:id/suggestions`: returns the row, including the PDF url
  when ready, or `null` when the client has never generated one.
- `/overview`: each client gains `insight: { status, url } | null`, so the
  row can say a plan is ready without opening the modal.

### 5. `apps/worker`: the `insights` queue

Moves the Anthropic call and the prompt across unchanged, then renders the
PDF from a new template and writes the row `ready`. On any throw it writes
`failed` with the message. The prompt, the schema and the model all stay
exactly as they are: this item changes when the work happens, not what it
produces.

### 6. The insights template

`assets/insights-template.html`, beside the report template and printed the
same way: data injected as `window.REPORT_DATA` ahead of the loader. Carries
the Torerone wordmark, the client's name, the date, and the steps as
numbered cards in the portfolio's card style.

### 7. `apps/desktop`

- The modal's Generate fires and returns. The button reads "Working on it"
  and the modal states plainly that it can be closed.
- While open and running, the modal polls the GET route. When it lands, the
  suggestions render as they do today, plus an "Open PDF" button.
- On reopen, the modal loads the stored row, so a finished run is there
  without regenerating, and a failed one says why.
- The Account Overview row shows a signal when a plan is ready, and the
  screen polls only while some client has a run in flight.

## Out of scope, deliberately

**Notifying across screens.** If the operator leaves Account Overview
entirely, nothing chases them. The button lives on that screen and the
answer arrives there. A global notifier is a bigger idea than this item.

**History.** One row per client, overwritten per run.

**Changing the schema.** Same model, same four categories, same
title-and-detail shape. The prompt changed; the structure did not.

## Verification

- New runnable check for `insightStatus`, and all existing checks pass.
- All seven workspace projects typecheck.
- Live: press Generate, close the modal immediately, watch the overview row
  turn to a ready plan, reopen and find the suggestions plus a PDF that
  opens and reads correctly. A failure path forced by pointing the worker at
  a bad key, confirming the row says why rather than spinning.
