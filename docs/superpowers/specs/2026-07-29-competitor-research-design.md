# Competitor research: what the accounts they admire are actually doing

Date: 2026-07-29
Status: draft, phase 1 scoped
Source: "List of improvments for the app.md", item 17 (the market research item, rewritten 2026-07-29).

## Context

Item 17 asks for a button that takes the creators a client named at signup and
pulls what is working for them: best posts by views and engagement, the
captions and descriptions used, the transcripts, "basically everything about
the video". That feeds niche research, game plans, and a script generator.

What exists today:

- The onboarding form on torerone.com captures five inspiration accounts as
  `inspo-1-name` / `inspo-1-username` through `inspo-5-*`. Deployed and
  detected by Netlify on 2026-07-29, so submissions land from now on. **There
  are zero historical submissions**: the form went live today.
- The form captures a handle but **not which platform it belongs to**.
  `@carguy` could be Instagram, TikTok, both, or two different people.
- `ClientInsight` and the `insights` worker queue already do the
  "press a button, work happens on the worker, a document comes out" pattern.
  This item is the same shape with a fetch step in front.

## What the research established

Recorded here because it constrains the design more than any product decision.

- **TikTok's Research API is unavailable to us.** Academic and non-profit
  institutions only, commercial use explicitly prohibited. There is no
  commercial tier to buy.
- **Instagram's `business_discovery` is too thin to build on.** It needs our
  own connected IG Business account plus a Facebook Page, the target must
  itself be a Business or Creator account, and it caps at 200 calls per hour.
  It returns follower and media counts plus per-post likes, comments and
  views. No transcripts, captions undocumented, personal accounts invisible.
- **Meta v. Bright Data** (Jan 2024, N.D. Cal.) held that Meta's terms do not
  bar logged-off scraping of public data and that the perpetual survival
  clause was unenforceable, building on hiQ v. LinkedIn. It did **not** hold
  that scraping is lawful in general: contract claims failed, copyright and
  other claims were untouched.
- The ruling turned on **logged-out** access by a party with no accounts.
  Anything fetched from a logged-in session is still bound by the terms that
  session agreed to.

## Decisions

### Nothing in this app ever talks to Instagram or TikTok directly

All outbound research goes through a third-party gateway that fetches
logged-out public data on its own infrastructure. Toreroflow holds no
scraping code, no cookies, no sessions, no proxy pool.

This is the single decision that keeps the feature safe to run. The exposure
that actually matters here is not legal, it is account level: a fetch made
from Tyrone's IP or with a client's connected account is what gets an account
rate-limited, flagged, and eventually banned. A client's Instagram is their
livelihood and ours to protect.

### The gateway is an interface, and Monid is one implementation

`ResearchProvider` defines resolve-handle, fetch-top-posts and
fetch-transcript. `MonidProvider` implements it against
`POST /v1/discover`, `/v1/inspect`, `/v1/run` and `GET /v1/runs/:runId`.

Monid brokers other providers' endpoints rather than owning data: its own
docs demonstrate `-p apify -e /apidojo/tweet-scraper`. That makes it a
billing and routing convenience, which is genuinely worth having (one key,
one wallet, no per-provider contracts, from $0.0013 a call) and worth not
depending on. It is a young company found through Twitter, holding prepaid
balance. Keeping it behind an interface means it can be replaced without
touching the schema, the storage or the screen.

### Fetching happens on the worker, never in a request

Monid runs are asynchronous: `POST /v1/run` may answer `202` and results are
polled from `GET /v1/runs/:runId`, and synchronous calls can time out with a
`408`. A new `research` queue mirrors `insights`, which already proved this
shape.

### One paid fetch serves every consumer

Raw provider payloads are stored verbatim in `CompetitorSnapshot` alongside
what they cost. Research, the game plan and the script generator all read
that store. Re-running is an explicit act, not something a page refresh can
trigger, because every fetch spends real money.

### Every run has a ceiling, and nothing runs on a timer

A run declares a maximum spend before it starts and stops when it reaches it.
Some endpoints price per result with a base charge, so "top 50 posts for five
creators" can cost far more than a headline per-call price suggests.

Nothing schedules research. It happens when the operator presses the button,
because an unattended loop against a metered API is how a wallet empties
overnight.

### The client says which app, and the operator still confirms the match

Settled 2026-07-29: the website form now asks which app each inspiration
account is on (Instagram, TikTok or both) and the field is live. So the
platform is known rather than guessed for everyone who signs up from now on.

Resolution is still required, because the posts endpoints want an internal id
rather than a handle, and the resolved account is still shown for
confirmation before anything expensive runs. A wrong account researched is
worse than a slow one: it produces a confident game plan about a stranger.

Anyone who signed up before today has no platform recorded. There are none
today, since the form went live the same day, but the code still treats
`platform` as possibly unknown and falls back to trying both.

### Transcripts are a separate, opt-in step

Not part of the default pull. They cost the most and carry the most legal
weight: transcribing someone's video produces a derivative of their creative
work. Using that internally to understand what works is defensible; handing
it to a client or regenerating a near-copy of their script is not.

So transcripts are fetched only when asked for, stay internal, never appear
verbatim in a client-facing document, and reach the script generator as
aggregate patterns rather than as text to rewrite.

**This is a judgement call, not legal advice.** Before transcripts are used
in anything billed, it is worth a lawyer's twenty minutes.

## The endpoints, confirmed against the live account

Read from Monid's own catalog on 2026-07-29, not from documentation.

| Step | Instagram | TikTok |
|---|---|---|
| Handle to id | `tikhub /api/v1/instagram/v1/fetch_user_info_by_username` | `tikhub /api/v1/tiktok/web/fetch_search_user` |
| Id to posts | `tikhub /api/v1/instagram/v1/fetch_user_posts` | `tikhub /api/v1/tiktok/web/fetch_user_post` |

**Resolution is mandatory, not a nicety.** Neither posts endpoint accepts a
handle: Instagram's requires a numeric `user_id`, TikTok's requires a
`secUid`. So every creator costs two calls the first time and one call on
every run after, which is the whole reason `InspirationAccount.externalId`
exists.

Pricing is `PER_CALL` at $0.0015 for the tikhub endpoints and $0.00225 for
the Apify equivalents. A first full run for one client, five creators across
both platforms, is roughly 20 calls at about three cents. Later runs are
about half that. The `$1` starting balance is therefore around thirty full
runs, which is plenty to build and prove the feature and nowhere near enough
to leave unattended.

The `tikhub /api/v1/tiktok/creator/*` endpoints look tempting and are not
usable: they are creator analytics for an account you control, not public
data about someone else's.

## Phase 1 scope

Deliberately smaller than the item, because the item is four features.

**In:** ingesting inspiration accounts from Netlify form submissions onto the
client record; resolving handles to Instagram and TikTok accounts; a button
that pulls top posts with views, engagement, captions and hashtags; storing
the raw result; showing it.

**Out, for later phases:** transcripts, niche synthesis, game plan
generation, the script generator. Each needs the store this phase builds
before any of them is worth writing.

## What gets built

### 1. `packages/db`: two models

```prisma
model InspirationAccount {
  id        String   @id @default(cuid())
  clientId  String
  /// As the client typed it at signup.
  rawHandle String
  displayName String?
  /// instagram | tiktok | unknown until resolved.
  platform  String   @default("unknown")
  /// Provider's id for the resolved account, null until confirmed.
  externalId String?
  confirmedAt DateTime?
  createdAt DateTime @default(now())
  client    Client   @relation(fields: [clientId], references: [id], onDelete: Cascade)
  snapshots CompetitorSnapshot[]
  @@index([clientId])
}

model CompetitorSnapshot {
  id        String   @id @default(cuid())
  accountId String
  fetchedAt DateTime @default(now())
  /// Provider payload, stored verbatim so a schema change cannot lose data.
  raw       Json
  /// What this cost, in integer cents, for the ceiling to be enforceable.
  costCents Int      @default(0)
  account   InspirationAccount @relation(fields: [accountId], references: [id], onDelete: Cascade)
  @@index([accountId, fetchedAt])
}
```

### 2. `packages/core/src/research.ts`

Pure, with a runnable check: normalising a typed handle (strip `@`, strip a
pasted profile URL down to the handle, lowercase), deciding whether a
snapshot is stale enough to be worth re-paying for, and summing costs against
a ceiling.

### 3. `apps/api/src/research/monid.ts`

The provider client. Bearer auth, `x-request-id` captured on every call for
support, `402` surfaced as "the research wallet is empty" rather than a
generic failure, and resolved endpoint ids cached so `discover` is not paid
for on every run.

### 4. Netlify form ingestion

A route that reads the `onboarding` form's submissions and offers unmatched
ones for attaching to a client. Not automatic: matching a lead to a client
record is a judgement the operator should make.

### 5. `apps/worker`: the `research` queue

Resolve, fetch, store, record cost. Failures land on the row with a reason,
the same way `ClientInsight` does.

### 6. `apps/desktop`

Inspiration accounts on the client's profile, a confirm step for resolved
handles, and one button that starts a run with its ceiling shown before it
is pressed.

## Verification

- Runnable checks for the pure helpers, including that a ceiling is never
  exceeded and that a pasted profile URL reduces to the same handle as typing
  it by hand.
- A live run against one real handle with a low ceiling, confirming the cost
  recorded matches the wallet movement.
- Confirmation that no request in the whole path carries a cookie, session or
  client credential.

## Open, needs Tyrone

- How much to keep in the Monid wallet. The starting balance is $1, roughly
  thirty full runs. The key is in `.env` as `MONID_API_KEY` and verified
  working against the live account.
- Whether transcripts are worth a lawyer's review before phase 2 uses them in
  anything billed.
