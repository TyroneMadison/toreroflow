# Platform metrics, phase 1: everything the provider already sends

Written 2026-08-11. Phase 1 of the analytics depth project.

## Why this phase exists

The goal is every metric the platforms allow, on the Analytics tab, on the
published report page, and on each card in the report's Video Breakdown.

The measurement that shaped this phase: the app has no direct connection to
Instagram, TikTok or Facebook. Everything arrives through Zernio.
`SocialAccount.tokensEncrypted` is a `provider:zernio` sentinel, not a platform
token. YouTube has a second path, our own catalogue sync, but it runs on a
plain API key and cannot reach the YouTube Analytics API.

So before any direct integration is worth designing, there is free work on the
table: fields the provider already sends that nothing in the app reads, and a
daily history table that already accumulates rows that nothing queries.

Phase 1 is exactly that work. It needs no new API access, and it is the
foundation the direct integrations plug into. Phases 2 and 3 (a Meta app,
YouTube Analytics OAuth, TikTok Business API) are scoped separately.

## What the provider actually sends

Measured 2026-08-11 against the live account, 800 posts over a full year.
Reading is nonzero/present out of that platform's post count.

| Metric | Facebook (40) | Instagram (279) | TikTok (238) | YouTube (243) |
| --- | --- | --- | --- | --- |
| views | 37/40 | 275/279 | 238/238 | 242/243 |
| likes | 39/40 | 279/279 | 237/238 | 242/243 |
| comments | 17/40 | 155/279 | 96/238 | 154/243 |
| shares | 18/40 | 161/279 | 57/238 | 0/243 |
| saves | 0/40 | 185/279 | 0/238 | 0/243 |
| reach | 40/40 | 275/279 | 0/238 | 0/243 |
| impressions | 40/40 | 275/279 | 0/238 | 0/243 |
| clicks | 33/40 | 0/279 | 0/238 | 0/243 |
| engagementRate | 39/40 | 275/279 | 237/238 | 242/243 |
| igReelsAvgWatchTime | 0/40 | 274/279 | 0/238 | 0/243 |
| igReelsVideoViewTotalTime | 0/40 | 274/279 | 0/238 | 0/243 |
| videoDurationSeconds | 0/40 | 278/279 | 0/238 | 0/243 |
| follows | 0/40 | 0/279 | 0/238 | 0/243 |

Per-platform figures live on `post.platforms[].analytics`, keyed by
`platformPostId`, which is the platform's own id. That is the same id the
Graph API returns and the same id our YouTube sync writes, which is why a
direct integration later merges into these rows instead of beside them.

## The five findings this phase acts on

1. **Four fields arrive and nothing reads them:** `impressions`, `clicks`,
   `igReelsVideoViewTotalTime` and `engagementRate`, plus a `lastUpdated`
   stamp that says how fresh the numbers are.
2. **Average watch time is never stored.** `ExternalVideo` has `durationSec`
   but no watch field. Watch time is read off the live provider post only, so
   an Instagram post that ages out of the provider's rolling window loses its
   watch time permanently. Every post older than the window already has.
3. **The Watch time KPI is partly invented.** `AnalyticsScreen.tsx:310`
   computes `views x avgWatchSec` and, when a post reports no watch time,
   substitutes the account-wide average. TikTok and YouTube report none, so
   their posts currently inherit an Instagram average. Meanwhile the real
   measured total arrives on 274 of 279 Instagram posts and is thrown away.
4. **`ExternalVideoMetric` has rows and no readers.** One row per video per UTC
   day, accumulating since it shipped. It is the only per-video history the app
   will ever have for the window the provider no longer serves.
5. **`follows` is zero on all 800 posts, every platform.** Followers gained per
   video is not obtainable from this provider at all. It stays hidden until a
   direct integration, and the improvements-list item cannot close in phase 1.

## Design

### 1. Capture the fields that already arrive

New columns on `ExternalVideo`, all nullable. New columns rather than widening
existing ones, because a nullable new column has no history to misrepresent,
while flipping an existing `Int @default(0)` to nullable would leave 1,682 rows
whose `0` cannot be told apart from a real zero.

| Column | Type | Source | Notes |
| --- | --- | --- | --- |
| `impressions` | `Int?` | `analytics.impressions` | Facebook only in practice. Deprecated by Meta for Instagram media created after 2 July 2024 and observed equal to views there, so it is surfaced for Facebook and not for Instagram. |
| `clicks` | `Int?` | `analytics.clicks` | Facebook only. |
| `avgWatchSec` | `Float?` | `igReelsAvgWatchTime` / 1000 | Closes finding 2. |
| `totalWatchSec` | `Float?` | `igReelsVideoViewTotalTime` / 1000 | The measured total, replacing the estimate. |
| `engagementRate` | `Float?` | `analytics.engagementRate` | Provider computed, all four platforms. Stored for comparison, not used as the displayed figure; see below. |
| `metricsUpdatedAt` | `DateTime?` | `analytics.lastUpdated` | Lets a report state when its numbers were last refreshed. |
| `source` | `String` default `"zernio"` | write path | `zernio` or `youtube` today. Phases 2 and 3 add `instagram`, `tiktok`, `facebook` without another migration. |

The same six metric columns are added to `ExternalVideoMetric`, so the daily
series carries them too. Without that, the history for the new fields starts
empty and the charts in section 4 have nothing to draw for months.

`engagementRate` is stored but the displayed engagement figure stays our own
computation, because ours is defined and theirs is not. Storing both means the
day they disagree materially we can see it rather than discover it in a client
meeting. Every "engagement" figure named elsewhere in this spec is ours.

**Merge behaviour for `avgWatchSec`.** `MergedPost.avgWatchSec` is read off the
live provider post today. It now prefers the live value and falls back to the
stored one, so a post inside the provider's window is unchanged while a post
that has aged out keeps the watch time captured when it was still visible.
This is the only per-field precedence rule phase 1 introduces; the general
per-field merge belongs to the phase that adds a third source.

### 2. One capability matrix, extended from what exists

`packages/core/src/platformMetrics.ts` already answers "which platform reports
which metric" for saves and follows, and both the Analytics screen and the
report builder already ask it rather than reading a zero. Phase 1 widens that
file into the full matrix from the measurement table above.

```
METRIC_REPORTED_BY: Record<MetricName, ReadonlySet<PlatformName>>
reportsMetric(metric, platforms): boolean
```

This is deliberately chosen over migrating the existing metric columns to
nullable. It is a smaller change, it is the idiom already in the codebase, and
it answers correctly for the 1,682 historical rows that a migration could not.

The rule every surface follows: a platform that does not report a metric shows
nothing for it. Not a zero, and not an explanation.

### 3. Remove the placeholder copy

Two blocks come out of `assets/report-template.html`:

- Line 793, the "Not shared by any platform / DMs from this video" pill.
  Deleted outright. No platform reports per-post DMs and saying so on every
  card taught the client nothing.
- Line 767, the "The platforms this went to do not report watch time for it,
  so no retention figure is shown rather than an invented one" note. The block
  renders nothing at all when there is no measured retention.

The stale comment at `buildReportData.ts:463` describing the old behaviour is
rewritten in the same change.

The principle does not change, only its expression: an unmeasured metric is
still never shown as a zero. It is simply absent rather than annotated.

### 4. Give the daily series its first readers

`ExternalVideoMetric` gains an endpoint returning a video's day rows, and two
surfaces read it:

- **Per-video views over time** on the expanded Video Breakdown card, drawn as
  a small inline SVG line in the existing hand-rolled chart style. No chart
  library, matching the Financials screen precedent.
- **Views added this period**, the difference between the first and last
  captured day inside the report window, which is a genuinely different fact
  from lifetime views on a card that has always shown only the lifetime total.

A video with fewer than two captured days shows neither. That is most videos
today and it corrects itself daily, which is the argument for shipping the
capture before the direct integrations rather than after.

**The delta measures capture, not publication.** Daily capture began when
`ExternalVideoMetric` shipped, so for any video published before its first
captured day the figure is views added since we started watching, not views
added since it went up. The label says "since we started tracking" whenever
the first captured day is later than the publish date, so the number is never
read as lifetime growth.

### 5. Rebuild the video card around the real metric set

The expanded card carries, for each metric the card's platforms actually
report: views, engagement, likes, comments, shares and reposts, saves, reach,
impressions, clicks, average watch, total watch, retention ring, views added
this period, and the views-over-time line.

**Per-platform split.** A cross-posted video currently collapses to one set of
numbers. `MergedPost.byPlatform` already exists but carries only
`{ platform, views, accountId }`, so it widens to the full metric set, filled
from the provider's `platforms[].analytics` entries live and from the stored
per-platform rows otherwise. The card then renders one row per platform for
posts that went to more than one place, each row obeying the section 2 matrix
so a TikTok row does not show an empty Saves column. Single-platform posts
render exactly as now, with no empty splitter.

### 6. Fix the watch time KPI

`watchHours` stops extrapolating. It sums `totalWatchSec` where the platform
reports it, falls back to `views x avgWatchSec` only for posts that report
their own `avgWatchSec`, and contributes nothing for posts that report neither.
The KPI is labelled to say it covers the platforms that measure it.

This will make the number drop. That is the point: the current figure counts
TikTok and YouTube watch time that was never measured.

## Where each number appears

| Surface | File | Change |
| --- | --- | --- |
| Analytics tab | `apps/desktop/src/screens/AnalyticsScreen.tsx` | KPI row gains measured watch time and, per tab, impressions and clicks. Engagement row gains reach and impressions honesty via the matrix. |
| Report page | `apps/api/src/reports/buildReportData.ts` | Same figures from the same merge, so the page cannot disagree with the screen. |
| Video Breakdown | `assets/report-template.html` | Sections 3 and 5. |

All three read `buildMergedPosts`, which is what keeps them consistent. That
property is preserved: no surface gets its own query.

## Out of scope, explicitly

- No new platform API access. No Meta app, no YouTube OAuth, no TikTok app.
- `follows` stays hidden. Zero on all 800 posts.
- No second-by-second retention curve. That needs the YouTube Analytics API.
- No demographics, no traffic sources, no DMs. None are obtainable here.
- No migration of existing metric columns to nullable. Section 2 instead.

## Runnable checks

Following the repo convention: `assert`-based `.check.ts` under `tsx`, no test
framework.

- `platformMetrics.check.ts`, extended: every metric in the matrix pins its
  platform set, so a wrong entry cannot ship silently. This is the file that
  decides whether a client sees a number or a blank.
- `externalStore.check.ts`, extended: `mapProviderEntry` maps each new field,
  converts both watch fields from milliseconds to seconds, and yields null
  rather than zero when the field is absent from the payload.
- A new check on the watch-time math: a post with no watch data contributes
  zero hours and does not inherit another post's average.
- A new check on the period delta: fewer than two captured days yields null.

## Risks

- **The watch time KPI drops visibly.** Expected and correct. Worth telling
  Tyrone the number was previously overstated rather than letting him find it.
- **Milliseconds.** Both watch fields arrive in milliseconds while the app is
  seconds throughout. Converted once, in `mapProviderEntry`, pinned by a check.
  The sample read 4948 ms on a 13 second video, so a missed conversion would
  render as 4,948 seconds and be obvious, but only if someone looks.
- **Instagram `impressions` is a mirror of `views`.** Surfacing it on Instagram
  would show the same number twice under two names. Facebook only.
- **Empty cards.** A TikTok-only video reports four metrics, so its card is
  sparse where an Instagram card is dense. That is honest, and it is the
  argument for phases 2 and 3 rather than a defect in this one.
