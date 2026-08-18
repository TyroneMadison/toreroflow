# The long-form uploader: what each control can actually do

Written 2026-08-18, before the first line of the feature. Sources: Google's
videos resource docs (fetched 2026-08-18, writable properties listed), Zernio's
YouTube platform docs (fetched 2026-08-18), and the live account. Every control
on the wish list is classified before being built, because a toggle that
stores a choice nothing executes is a lie with good styling.

## The architecture decision that shapes everything

**The video file keeps going through Zernio. Our own Google OAuth enriches the
metadata afterwards.**

Uploading directly through the YouTube Data API would let us set everything at
insert time, but videos inserted by API projects that have not passed Google's
audit are **locked to private** (policy since 28 July 2020). Our project is
unaudited. Every client upload would arrive private and stay private, which is
a dead client deliverable. Zernio is an audited partner, so its uploads publish
normally.

`videos.update`, however, has no such lock. And the app already holds
channel-owner OAuth (PlatformConnection, built for Analytics). So:

1. Zernio publishes the video with everything its API carries.
2. confirmPublishing (already running every 60s) captures the platform video id.
3. A new enrichment job uses the owner's OAuth to `videos.update` the rest:
   tags, license, embeddable, recording date, language, paid promotion.

Cost of this route: the OAuth connection needs the `youtube` scope added
(today it is analytics-readonly), which means one fresh consent link per
channel. The connect flow for that already exists.

## The truth table

Verdicts: **Zernio now** (ships in piece 1) · **Direct API** (piece 2 job) ·
**Studio checklist** (no API exists; the wizard records the choice and compiles
a finish-in-Studio list with a deep link on the published post) · **Impossible**.

| Control | Verdict | Notes |
| --- | --- | --- |
| Title | Zernio now | max 100 chars |
| Description | Zernio now | max 5,000 chars |
| Tags (500-char pool) | Direct API | `snippet.tags`; Zernio has no field |
| Thumbnail upload | Zernio now | long-form only; already wired (mediaThumbnail) |
| Category dropdown | Zernio now | `categoryId`; list already in the app |
| Made for kids | Zernio now | already wired |
| Paid promotion | Direct API | `paidProductPlacementDetails.hasPaidProductPlacement` |
| Branded partnership / share code | Direct API, verify | `brandPartner` appears in Google's writable list; confirm on a real call in piece 2 |
| AI-generated label | Zernio now | `containsSyntheticMedia`; already wired |
| Invite a collaborator | Studio checklist | no API anywhere |
| Automatic chapters toggle | Studio checklist | no API |
| Featured places | Studio checklist | no API |
| Automatic concepts | Studio checklist | no API |
| Captions language | Direct API | `defaultLanguage` via update |
| Upload subtitles (manual) | Direct API (piece 4) | `captions.insert` is real |
| Captions FCC certification | Studio checklist | no API |
| Recording date | Direct API, verify | `recordingDetails.recordingDate`; historically writable, absent from the 2026 fetch, confirm in piece 2 |
| Recording location | Studio checklist | deprecated out of the API in 2017 |
| License (standard / CC) | Direct API | `status.license` |
| Distribution (everywhere / monetized) | Studio checklist | not in the API |
| Allow embedding | Direct API | `status.embeddable` |
| Publish to subscriptions feed / notify | Studio checklist | `notifySubscribers` exists only at insert time, which is Zernio's call to make, and they do not expose it |
| Add to playlist | Zernio now | already wired |
| Comments on/off/pause | Studio checklist | no per-video API |
| Moderation level | Studio checklist | no API |
| Who can comment | Studio checklist | no API |
| Sort by | Studio checklist | no API |
| Fundraiser | Studio checklist | YouTube Giving has no API |
| End screens / video elements | Studio checklist | no API |
| Related video | Studio checklist | established 2026-08-18, removed from the short-form scheduler the same day |
| Ad suitability questionnaire | Wizard-native | it gates OUR publish and prints on the checklist; Google offers no API to submit it |
| Checks phase | Wizard-native | real preflight of everything we can verify locally; YouTube's own copyright check has no API |
| Visibility public/unlisted/private | Zernio now | already wired |
| Members-only | Studio checklist | API has three privacy states; publishes private + checklist line |
| Schedule + best times | Zernio now | existing pipeline, existing BestTimes |
| ToreIQ ranking | Piece 5 | VidIQ has no public API; built on our own 750-video catalogue instead |
| Thumbnail A/B testing | Piece 6 | Studio's Test & Compare has no API; buildable ourselves: `thumbnails.set` rotation + Analytics API CTR comparison, both already reachable |
| 5-day source auto-delete | Piece 7 | server-side sweep, per-video clock from upload |

## Piece plan

1. **Foundations** (this piece): capability map, horizontal detection, wizard
   shell with Details, Checks, Visibility live; schedules through the existing
   pipeline; extended metadata stored on the target for piece 2.
2. **Enrichment**: youtube scope on the OAuth flow, worker job after publish
   confirmation, verify recordingDate and brandPartner on a real video.
3. **Ad Suitability phase** + the compiled Studio checklist on published posts.
4. **Video Elements phase**: subtitle upload via captions.insert; the rest
   is checklist.
5. **ToreIQ**: title/description/tags/thumbnail scoring from the client's own
   catalogue and analytics.
6. **A/B thumbnails**: rotation + Analytics CTR readout.
7. **Retention**: 5-day per-video source deletion on the server.

## Standing rule

A control the API cannot execute is never presented as if it publishes. It is
recorded, and it surfaces on the post's finish-in-Studio checklist, two clicks
from the exact page where a human can do it. That is the difference between
replicating Studio's screen and faking it.
