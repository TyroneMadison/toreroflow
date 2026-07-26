# Toreroflow improvement backlog

Organized from the raw brain-dump list, 2026-07-25. Groups related items,
flags conflicts, and records what the code and live data actually support.

Status key: **Ready** (clear enough to build), **Needs a decision**
(blocked on one answer), **Needs design** (a real feature, deserves its own
brainstorm).

---

## Part A: Near-term improvements

### A1. Analytics screen (raw items 2, 3, 11, 12, and part of 10)

These all touch the same screen and should be built as one pass, not four.
Rebuilding the screen four times means re-QA'ing it four times.

| # | Item | Status |
|---|------|--------|
| 2 | All-time stats across all platforms | Needs a decision, see C5 |
| 2 | Fix 1M / 100K / 10K buckets | **Not a bug**, see below |
| 3 | Per-platform tabs, overall + per-network, color coded | Ready |
| 11 | More detailed views-over-time graph | Needs design |
| 12 | Video counters for 30 / 60 / 90 days | Ready |
| 10 | Refresh button for stats and uploads | Ready |

**The buckets are not broken.** Live check of the 134 posts we can see: the
highest-viewed video is 450,384 views. The 1M+ tier is empty because no
video has crossed 1M yet, not because the code is wrong. The 100K-999K tier
correctly holds 4 videos and 10K-99K holds 11.

**Raw item 12 says "within the month, within 90 days, and within 60 days."**
Reading that as 30 / 60 / 90 to match the range selector already on the
dashboard.

**Refresh button (10)** has two layers: bust the 5-minute cache on the posts
endpoint, and trigger a fresh provider ingest rather than waiting for the
daily job. Both are straightforward.

### A2. Upload and schedule flow (raw items 4, 5, 6, 7, 8)

| # | Item | Status |
|---|------|--------|
| 4 | Remove burned-in captions; generate descriptions instead | Needs a decision, see C1 |
| 5 | Replace AI "hook" with a title field | Ready, pair with 4 |
| 6 | Drag and drop | Needs a decision, see C2 |
| 7 | Schedule modal: blurred/darker backdrop | Ready |
| 7 | "Post Now" button | Ready |
| 8 | Best upload times per platform, graphed, timezone aware | Needs a decision, see C6 |

**Items 4 and 5 are one change, not two.** Both rewrite what the AI produces
for a video. Today it returns `{hook, caption, hashtags}`. After: a title
you control and a generated description. Doing them separately means
changing the same schema, worker prompt, and Upload screen twice.

**Good news on item 4:** the vertical 1080x1920 reframe and the caption burn
are separate arguments to the same render function. Captions can be removed
without losing the reformat.

### A3. Reports (raw item 9)

Better-decorated PDF export, auto-reporting stats across all accounts.
Status: Ready, but worth a design pass on layout since it is client-facing.
Current report is a logo header, KPI boxes, and a per-platform table.

Ideas to consider: per-platform sections with the network's color, top-5
videos with thumbnails, period-over-period deltas ("views up 23% vs the
previous 30 days"), a plain-language summary paragraph, and your branding
on a cover page.

### A4. App chrome (raw item 1)

Profile picture on the "Active brand" pill in the bottom-left sidebar.
Status: Ready, small. The `clientAvatarUrl()` helper already exists and is
used by the Accounts and Analytics screens; this is the last place still
showing a letter tile.

---

## Part B: Future features

Grouped into themes. Each theme is its own project with its own design pass.

### B1. Business and finance module (raw items 31-36)

The single largest theme, and the most self-contained. Six raw items that
are really one subsystem:

- Per-client monthly price, shown in Accounts (31)
- Dashboard revenue per client per month, adjustable pricing (32)
- Budgeting system for the business (32)
- Stripe overview inside the app (33)
- Expense tracker: add an app or service, auto-calculate cost (34, 36)
- Cash flow tracking, overall finance view (35)
- Interactive income-vs-expense math (36)

This needs new data models (Subscription, Expense, Revenue) and a new
screen. It does not depend on any other theme, so it can be built whenever.

### B2. Content intelligence (raw items 22, 23, 29)

- Script generator trained on high-performing transcripts (22)
- Automated niche market research, form-driven (23)
- Competitor scraper and content game plan (29)

Items 23 and 29 heavily overlap: both research a niche and produce a
plan. Recommend treating them as one feature with two entry points
(client-facing form, and your own manual run).

### B3. Creative generation (raw items 21, 26)

- Thumbnail generator with character sheet, via Higgsfield, for YouTube
  long-form (21)
- Carousel image generator posting to Instagram, driven by a per-client
  knowledge base (26)

Both depend on a **client knowledge base**, which does not exist yet and is
really the prerequisite feature for this theme and arguably for B2.

### B4. Client onboarding (raw item 28)

Paid client receives a link, self-serves their intake form, and connects
their own social accounts. Removes you from the manual enrollment loop.
**Architecturally significant, see C3.**

### B5. Platform and reach (raw items 24, 25)

- Drop Docker, standalone downloadable app (24)
- Personal mobile app (25)

**Architecturally significant and in tension with B4, see C3.**

### B6. Look and feel (raw items 27, 30)

- Dynamic animations throughout (27)
- Match your website's colors (30)

Item 30 needs your website URL or hex values, and a decision about the
current liquid-glass palette, see C7.

---

## Part C: Conflicts and things to resolve

### C1. Removing captions contradicts shipped M2 work

Item 4 removes a headline feature built in M2 (Bold pop captions burned into
the video). That is your call to make, but it raises three questions the
answer changes:

1. Keep the 1080x1920 vertical reframe, or upload the original file
   untouched?
2. Keep transcription? Descriptions are generated *from* the transcript, so
   dropping Whisper would remove the source material. Recommend keeping.
3. If both captions and reframe go, the entire render step disappears and
   the pipeline gets much simpler.

### C2. "Drag and drop" is ambiguous

Raw item 6 says only "a drag and drop feature." The calendar already has
drag-to-reschedule. Most likely meaning: drop a video file onto the Upload
screen to start an upload. Needs confirmation.

### C3. Standalone local app conflicts with client onboarding and mobile

This is the most important conflict in the list.

- Item 24 wants no Docker, a standalone app that runs anywhere.
- Item 28 wants clients to open a link and connect their own accounts.
- Item 25 wants a mobile app.

A client cannot open a link into an app running only on your desktop, and a
phone cannot reach your local Postgres. Items 28 and 25 require a hosted
backend on the internet; item 24 pushes the opposite direction.

Both can be true, but only with a deliberate split: a hosted API and
database in the cloud, with the desktop app as one client of it, the phone
as another, and the onboarding link as a small public web page. That is a
significant re-architecture and should be decided before building either.

The narrower reading of item 24, "stop needing Docker Desktop running
locally," is achievable on its own by embedding the database and dropping
Redis. Worth separating that from the full cloud question.

### C4. Item 26 contradicts itself on Canva

The raw note says the carousel generator will be "connected through Canva
Scratch Chat" and then "It won't be connected through Canva." Needs
clarification on what the actual output should be: a Canva design, a CSV
for an existing automation, or images generated directly in-app.

### C5. "All-time" stats may not be available

Item 2 asks for all-time statistics. Live check: the provider returns 134
posts spanning 2026-04-27 through today, roughly 90 days. We are nowhere
near the 500-post pagination cap, so this is the provider's own window, not
our limit. Before promising all-time numbers, we need to establish whether
history further back is retrievable at all. If it is not, the honest fix is
to label the range accurately rather than call it all-time.

### C6. Best upload times cannot be read from the platforms

Item 8 describes going into each platform's analytics to find their
recommended posting times. Those native recommendations are not exposed to
us through the provider. What we *can* do, and what is arguably better, is
derive best times from your own history: we have publish timestamps and
view counts per post, so we can compute which hours and weekdays actually
perform best for each account, then chart it. Same outcome, based on real
performance instead of a generic recommendation. Note this gets stronger as
more data accumulates.

### C7. Website colors versus the liquid-glass design

Item 30 wants the app to match your website. The current purple/blue
liquid-glass palette is the spec's stated design source of truth and every
screen is built on its tokens. Re-skinning is very doable since it is all
CSS variables, but it is a deliberate change of direction, not a tweak.
Need the website's colors and confirmation that you want to move off the
current palette.

### C8. Analytics rework versus M6 theme QA

Items 2, 3, 11, and 12 all rebuild parts of the Analytics screen. M6's
theme-parity and empty-state pass is quality assurance over finished UI.
Running that QA before the analytics rework means doing it twice. See the
sequencing note below.

---

## Recommended sequencing

M6 splits cleanly into infrastructure and QA, and they want opposite
positions in the order:

1. **M6 infrastructure first**: auto-update and error toasts. Toasts in
   particular pay off immediately, since every feature built afterward
   surfaces its failures for free instead of needing error handling
   retrofitted later.
2. **Then the backlog**, one item at a time, grouped as in Part A so each
   screen is touched once: analytics pass, then upload/schedule pass, then
   reports, then chrome.
3. **M6 QA last**: theme parity, empty and loading states, run over
   everything including the new work, then tag the milestone.

This still finishes M6 last, as intended, and avoids QA'ing the same
screens twice.
