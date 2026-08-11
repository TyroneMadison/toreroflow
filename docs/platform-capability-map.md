# What we can and cannot measure, per platform, per source

Written 2026-08-11. The reference the analytics code mirrors.

## How to read this

Three sources feed the app, and they are additive rather than alternatives.

- **Zernio** is the publishing provider. It is how posts go out, and it returns
  a fixed set of figures for every platform. Measured empirically on 2026-08-11
  across 800 posts and a full year, so the "today" column is observation, not
  documentation.
- **Direct** is the platform's own API, reached with our own credentials.
  Documented capability, not yet measured, because we do not have access yet.
- **Neither** means no API offers it at any price. Those are in section 6.

Zernio is never removed. An account with no direct connection keeps working
exactly as it does now.

Legend: **yes** confirmed working, **no** confirmed absent, **?** documented but
unverified.

---

## 1. Instagram

| Metric | Zernio today | Direct (Graph API) |
| --- | --- | --- |
| views | yes, 275/279 | yes |
| likes | yes, 279/279 | yes |
| comments | yes, 155/279 | yes |
| shares | yes, 161/279 | yes |
| saves | yes, 185/279 | yes |
| reach | yes, 275/279 | yes |
| impressions | yes, but deprecated by Meta for media after 2 Jul 2024 and observed equal to views | same limitation |
| average watch time | yes, 274/279 | yes |
| total watch time | yes, 274/279, currently discarded by the app | yes |
| video duration | yes, 278/279 | yes |
| **followers gained** | **no**, 0/279 | **? see below** |
| **profile visits** | no | yes, Feed and Stories |
| **profile activity** | no | yes, Feed and Stories |
| **reels skip rate** | no | yes, Reels |
| **reposts** | no | yes |
| **total interactions** | no | yes |
| **crossposted views** | no | yes, Reels |
| **story exits, taps forward, taps back** | no | yes, Stories |
| **story replies** | no | yes, returns 0 for EU and Japan creators |
| **audience demographics** | no | yes, account level, aggregated by age, gender, city, country |
| **follower online hours** | no | yes, account level |

### The followers-gained correction

I told you earlier that a Meta app delivers followers gained per video. That was
too confident and I want to correct it before you spend a review cycle on it.

Meta's media insights reference lists `follows` for **Feed posts and Stories**.
The Reels breakdown does not list it. Almost everything you post is a Reel, so
the metric you actually want may not exist on the media type you actually use.

This is verifiable the day the Meta app is live, on one real Reel, and it costs
nothing to check. Until then it stays a question mark rather than a promise.
The improvements-list item for followers gained per video does not close on
Instagram evidence alone.

What does work regardless: `profile_visits` and `profile_activity` per post,
which is the nearest honest answer to "did this video win me anything", and
YouTube's `subscribersGained`, which is unambiguous.

---

## 2. TikTok

The largest gap between what we have and what exists.

| Metric | Zernio today | Direct (Business Account API) |
| --- | --- | --- |
| views | yes, 238/238 | yes |
| likes | yes, 237/238 | yes |
| comments | yes, 96/238 | yes |
| shares | yes, 57/238 | yes |
| **reach** | **no**, 0/238 | **yes** |
| **average time watched** | **no** | **yes** |
| **full video watched rate** | **no** | **yes**, the completion rate |
| **total time watched** | **no** | **yes** |
| **traffic attribution** | **no** | **yes**, FYP vs search vs profile vs sound |
| **audience countries** | **no** | **yes** |
| saves | no, 0/238 despite the button existing | ? not documented on the video insights fields |
| followers gained | no | no, not offered per video |

**This data expires.** Those fields stop being returned once a video has been
inactive for 7 days. TikTok history cannot be backfilled. Every week without the
integration is a week of TikTok retention permanently lost.

---

## 3. YouTube

Today's YouTube numbers come from our own Data API key, which is public data
only. The Analytics API is a different product and needs channel-owner OAuth.

| Metric | Today (Data API + Zernio) | Direct (Analytics API) |
| --- | --- | --- |
| views | yes | yes |
| likes | yes | yes |
| comments | yes | yes |
| **shares** | **no**, 0/243 from Zernio | **yes** |
| **estimated minutes watched** | **no** | **yes** |
| **average view duration** | **no** | **yes** |
| **average view percentage** | **no** | **yes** |
| **subscribers gained** | **no** | **yes**, per video |
| **audience retention curve** | **no** | **yes**, the only true per-second curve on any platform |
| **traffic sources** | **no** | **yes**, search vs suggested vs browse vs external, with keywords |
| **geography, device, OS** | **no** | **yes** |
| **videos added to playlists** | **no** | **yes**, YouTube's nearest thing to a save |
| revenue and RPM | no | yes, if monetized and the monetary scope is granted |

YouTube is the single biggest unlock, and it is also the least gated of the
three. No review is required to start.

---

## 4. Facebook

| Metric | Zernio today | Direct (Page Insights) |
| --- | --- | --- |
| views | yes, 37/40 | yes |
| likes | yes, 39/40 | yes |
| comments | yes, 17/40 | yes |
| shares | yes, 18/40 | yes |
| reach | yes, 40/40 | yes |
| impressions | yes, 40/40 | yes |
| link clicks | yes, 33/40 | yes |
| **average video watch time** | **no** | **yes** |
| **reactions split by type** | **no** | **yes**, love vs haha vs angry rather than one total |
| **audience demographics** | **no** | **yes**, Page level |
| followers gained | no | Page level only, never per post |

Facebook is the smallest volume of the four and rides the same Meta app as
Instagram, so it costs nothing extra once that app exists.

---

## 5. What this changes on each surface

**Analytics tab.** Real watch time instead of an estimate. Retention per
platform. Traffic sources on YouTube, which answers "is search finding us or is
the algorithm pushing us", a question the app cannot ask today at all. Audience
demographics, which is the first time the app can say anything about who is
watching rather than only how many.

**Report page.** The same numbers, from the same store, because every surface
reads one merge.

**Video Breakdown.** This is where the difference is starkest. A card today
carries between three and nine numbers depending on platform. With direct
access an Instagram Reel carries roughly fifteen, a YouTube Short carries a
retention curve and the traffic that found it, and a TikTok carries completion
rate and whether the FYP picked it up.

---

## 6. What no API gives, at any price

Worth writing down so it stops being re-litigated.

- **DMs attributed to a specific video.** No platform models this. Instagram's
  Messaging API can read the conversation, but nothing anywhere says which video
  caused a message. The report was right to say so, and that stays true with
  full access on every platform.
- **Per-second retention outside YouTube.** Instagram, TikTok and Facebook give
  averages and rates, never a curve.
- **Followers gained per video on TikTok.** Not offered.
- **Followers gained per Facebook post.** Page level only.
- **Posting to a personal Facebook profile.** Established separately;
  `publish_actions` died in 2018 and was never replaced.
- **Posting to a personal Instagram account.** Professional accounts only.
- **TikTok public data on accounts you do not manage.** The Research API is
  academic-only and prohibits commercial use, which is what makes the
  competitor research feature a broker job rather than a direct one.

---

## 7. How the sources merge

One row per video per account, keyed `(socialAccountId, platformVideoId)`.
Zernio hands us `platformPostId`, which **is** the platform's own id, and our
YouTube sync already writes real video ids, so both sources land on the same key
with nothing to reconcile.

The rules:

1. **Per field, not per row.** The platform API wins for any field it reports.
   Zernio fills what the platform does not return. A field neither reports stays
   absent, never zero.
2. **Every field records its source**, so any surface can say where a number
   came from and a disagreement between sources is visible rather than silent.
3. **Non-scalar data gets its own tables.** Retention curves, traffic sources
   and demographics are not one number per video and do not belong on the video
   row.
4. **Daily capture continues regardless of source**, so history accumulates from
   whichever source is connected. This is what makes the TikTok 7-day window
   survivable, and why the capture has to ship before the integrations.
5. **Zernio is the floor.** Accounts without a direct connection behave exactly
   as they do today.

The capability matrix in `packages/core/src/platformMetrics.ts` is the code form
of this document. When one changes, the other changes.
