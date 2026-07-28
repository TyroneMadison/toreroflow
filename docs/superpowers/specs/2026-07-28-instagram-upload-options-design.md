# Instagram upload options: covers, trial reels, collaborators, and the options pipeline

Date: 2026-07-28
Status: approved
Source: "List of improvments for the app.md", item 4, plus the seven
reference screenshots in docs/improvements/.

## Context

Item 4 asks for Instagram's native upload options inside the app's
scheduling flow: cover editing (for every platform), linking a previous
reel, tagging users, location tagging, polls, trial reels, and the
translation toggle.

The pipeline today sends Zernio exactly six fields (content, one video
mediaItem, platform+accountId, publishNow, scheduledFor, timezone); the
worker publishes one target per call. Zernio's live documentation
(docs.zernio.com/platforms/instagram, /platforms/youtube,
/platforms/tiktok, /posts/create-post) confirms a much richer surface:

- Per-entry `platformSpecificData` inside `platforms[]`.
- Instagram: `contentType` ("reels"/"story"), `shareToFeed`,
  `collaborators` (max 3 usernames, public business/creator accounts),
  `firstComment`, `audioName`, `thumbOffset` (ms),
  `instagramThumbnail` (image URL, overrides thumbOffset),
  `trialParams { graduationStrategy: "MANUAL" | "SS_PERFORMANCE" }`,
  `isAiGenerated`.
- YouTube: `platformSpecificData.title`, plus `mediaItems[].thumbnail`
  (regular videos only, never Shorts); `content` is the description.
- TikTok: top-level `tiktokSettings.video_cover_timestamp_ms` and
  `video_cover_image_url`.

Confirmed walls (Meta's API, no provider can cross them): location
tagging, polls/story stickers, the translation toggle, user tags on
videos (images only), and link-a-reel (an Instagram Edits app feature
with no API anywhere, and no endpoint exists to browse an account's
reels). Tyrone accepted these limits and chose collaborators as the
tagging path.

Found gap folded in: `draftCopy.description` is edited, saved, AI-drafted,
and then never sent to the publisher; YouTube posts currently go out with
the title as their entire description.

## Decisions

- The cover is chosen once per video and applies on every platform that
  accepts one: Instagram reels, TikTok, and YouTube long-form. YouTube
  Shorts never get one (YouTube's rule); short-form videos simply send no
  YouTube thumbnail.
- Cover choice is either a frame of the video (scrubbed visually in a
  modal, stored as a millisecond offset) or an uploaded image. Both
  produce a cover.jpg stored beside the asset; the server extracts the
  frame with the existing extractThumbnail at the chosen offset. The
  card thumbnail everywhere in the app switches to the chosen cover, so
  what the operator sees is what posts.
- Instagram options are chosen at schedule time in the schedule modal,
  not persisted on the asset: Trial reel (with graduation choice), up to
  three collaborators, Rename audio, Share to feed (default on), First
  comment, AI label. They apply to that scheduling action only.
- Collaborators are typed usernames. No username lookup or validation API
  exists at Zernio or Meta; the client strips a leading @ and whitespace,
  and Instagram validates at publish, surfacing failures through the
  existing failed-target path.
- Options travel on a new `PostTarget.options Json?` column, following
  the `draftCopy` precedent. One column, no per-option schema.
- Every Instagram video post is sent explicitly as `contentType: "reels"`.
- The YouTube mapping becomes truthful: `platformSpecificData.title`
  carries the draft title, `content` carries the draft description
  (falling back to the title when no description exists).
- A pure options-builder function assembles the Zernio request additions
  from (platform, asset format, cover state, options) and carries a
  runnable check, so the money-adjacent mapping logic never lives only in
  the route or worker.

## Design

### 1. Cover picker

The upload card gains an "Edit cover" affordance (per the blueprint
image). It opens a modal with the video loaded in a player: a slider
scrubs frames visually, "Use this frame" saves the offset, and "Upload an
image instead" accepts a JPEG/PNG. Saving calls a new
`PATCH /media/:id/cover` with either `{ offsetMs }` or multipart image
upload; the API extracts or stores cover.jpg in the asset's storage
folder, records the choice on `MediaAsset` (`coverOffsetMs Int?`,
`coverKey String?`), and the asset's `thumbUrl` starts preferring the
cover. Clearing the cover reverts to the auto thumbnail.

### 2. The options pipeline

`schedulePostSchema` gains an optional `instagram` object (trial,
graduationStrategy, collaborators, audioName, shareToFeed, firstComment,
aiLabel). The schedule route writes it, filtered per platform, into the
new `PostTarget.options` column. The worker reads it, and the
options-builder produces: the per-entry `platformSpecificData` (Instagram
and YouTube), the top-level `tiktokSettings` (safe because the worker
publishes exactly one target per call), and the `mediaItems[].thumbnail`
for YouTube long-form. `ZernioProvider.createPost` widens to accept and
pass these through. The dry-run publisher logs the built options so a
dry-run walk can verify the exact shape without posting anywhere.

### 3. Cover delivery at publish

When a cover exists, the worker uploads cover.jpg through the existing
presign+PUT path with content type image/jpeg (currently hardcoded to
video/mp4; the presign call gains a content-type parameter) and uses the
returned URL as `instagramThumbnail`, `tiktokSettings.video_cover_image_url`,
and YouTube long-form `mediaItems[].thumbnail`. With a frame-chosen cover
and no upload needed for Instagram alone, `thumbOffset` would suffice,
but one uniform URL path keeps all three platforms identical; the offset
is still stored for re-extraction.

### 4. Schedule modal: Instagram options section

When Instagram is among the selected platforms, the modal shows an
"Instagram options" group: Trial reel toggle with a "share to everyone
if it performs" sub-choice (maps to MANUAL vs SS_PERFORMANCE),
three collaborator inputs, Rename audio text field, Share to feed toggle
(on by default), First comment textarea, AI label toggle. All optional;
an untouched section sends nothing beyond `contentType`.

### 5. YouTube truthfulness

The schedule route assigns the YouTube target its real description as
caption and passes the title through options so the worker can set
`platformSpecificData.title`. Other platforms keep the existing
title-as-caption behavior. (The full per-platform naming UI is item 9's
scope; this makes the pipeline stop discarding the description.)

## Out of scope, recorded so it is not lost

- Location tagging, polls, translation toggle, link-a-reel: impossible
  via any API today. Only doable by hand in the Instagram app after
  posting.
- User tags (tap-style) on image posts: the app publishes no image posts
  yet; revisit with the carousel item.
- YouTube visibility, madeForKids, category, playlist, related video:
  item 6's scope.
- Per-platform caption/title editing UI: item 9 and item 15.
- Zernio queues, recycling, drafts, crossposting flags.

## Verification

- A `.check.ts` for the options-builder: Instagram short-form with every
  option set, Instagram with none (only contentType), YouTube long-form
  with cover and title+description mapping, YouTube short-form never
  carrying a thumbnail, TikTok cover mapping to top-level settings, and
  no options object at all producing the legacy body.
- `pnpm -r typecheck` and all package checks.
- Live walk: pick a frame cover on a real asset and confirm the card
  thumbnail changes and cover.jpg exists; upload-image path too; schedule
  a dry-run post with Instagram options and read the dry-run log showing
  the exact platformSpecificData; confirm a short-form YouTube target
  carries no thumbnail while Instagram and TikTok do; clean up test
  posts and covers afterward. A real publish with a trial reel to
  Caleb's account is Tyrone's call, not part of the automated walk.
