# YouTube upload options: visibility, audience, extras, and the related video picker

Date: 2026-07-28
Status: approved
Source: "List of improvments for the app.md", item 6 (lines 160-171).

## Context

Item 6 asks for YouTube Shorts upload options in the scheduling flow:
visibility (public, members-only, unlisted, private), the made-for-kids
audience choice, description editing, location geotagging, and linking a
"Related Video" from the account's existing uploads.

Capability truth, established from docs.zernio.com/platforms/youtube,
docs.zernio.com/posts/create-post, the YouTube Data API v3 reference, and
Google's own support and forum posts:

- Zernio accepts for YouTube: `title` (max 100 chars), `visibility`
  ("public" | "private" | "unlisted", default public), `madeForKids`
  (boolean, default false), `containsSyntheticMedia` (boolean),
  `categoryId` (string, default "22" People and Blogs), `playlistId`,
  `firstComment` (max 10,000 chars, auto-posted and pinned), and
  root-level `tags`. `content` is the description (5,000 chars, matching
  YouTube's own cap). `mediaItems[].thumbnail` is long-form only; Shorts
  never get a custom thumbnail (already enforced since item 4).
- The WALLS (YouTube's, not Zernio's; accepted by Tyrone):
  - **Members-only visibility** is Studio-only. The Data API's privacy
    enum is public/private/unlisted, confirmed by a Google developer
    forum answer from April 2025.
  - **Location geotagging** is dead: every `recordingDetails.location`
    child field has been deprecated since 2017-2018.
  - **The Shorts "Related video" pin** is Studio-only. No public API
    anywhere can set it; Google's help doc describes it purely as a
    Studio UI action and third-party tools carry open feature requests.
- The description ask is already satisfied: since item 4, the upload
  card's Description box posts as the YouTube description verbatim.

Tyrone chose Option A: full extension of item 4's options pipeline, all
four Zernio extras (first comment, category, playlist, AI label), and the
buildable substitute for the related video: a picker over the account's
own catalogue (the item-5 `ExternalVideo` store) whose chosen video is
linked from the end of the description.

One carried caveat: Zernio's docs confirmed every field name but the
create-post page truncated before showing exactly how YouTube fields nest
in the request. Item 4 proved `platformSpecificData.title` works for
YouTube, so the new fields ride the same object; the full wire shape is
proven through dry-run logging at package level before any real post, and
no real post is made during this item. Tyrone's own first-publish test
remains the final proof.

## Decisions

- **A `youtube` options object rides the existing pipeline** exactly as
  `instagram` does: collected in ScheduleModal, zod-validated at the API,
  stored in `PostTarget.options` alongside the existing `youtubeTitle`,
  mapped by `buildPostExtras` into `platformSpecificData`, passed through
  the provider verbatim. No provider change.
- **Fields:** `visibility` ("public" | "unlisted" | "private"),
  `madeForKids` (boolean), `firstComment` (string), `categoryId`
  (string), `playlistId` (string), `aiLabel` (boolean, mapped to
  `containsSyntheticMedia`), `relatedVideoUrl` (string, consumed by the
  route, never sent to Zernio).
- **Untouched controls send nothing.** A sparse object, same as
  Instagram; Zernio's defaults apply. An untouched section sends no
  `youtube` key at all.
- **Made for kids permanently disables comments on the video** (Zernio's
  doc says so explicitly), so a pinned first comment cannot coexist with
  it. The UI disables the first-comment input with a hint when Made for
  kids is on, and `buildPostExtras` also drops `firstComment` whenever
  `madeForKids` is true, so the request can never carry the
  contradiction even if a stale UI sends one.
- **The related video is a description link, not the Studio pin.** The
  route appends one line, `Watch next: <url>`, to the end of the YouTube
  description when `relatedVideoUrl` is present. Appending happens
  server-side in the one place the description is assembled. The wall is
  named in the UI copy so the operator knows the real pin stays a manual
  Studio step.
- **The picker reads our own store.** A new endpoint lists the client's
  `ExternalVideo` YouTube rows (title, thumbnail, views, publishedAt,
  url, platformVideoId), newest first. The item-5 catalogue is the data
  source; no live YouTube call on open.
- **Playlists are a dropdown, not a typed id.** `YouTubeProvider` gains
  `listPlaylists(handle)` (Data API `playlists.list` by channel, API key,
  public playlists, first 50). A small endpoint serves `{ id, title }`
  pairs; the modal loads them lazily when the YouTube section first
  renders and falls back to a disabled control with a hint when the
  fetch fails or returns none.
- **Category is a fixed dropdown** of YouTube's standard categories
  (hardcoded id/label pairs; the ids are stable YouTube constants),
  defaulting to "Default (People and Blogs)" which sends nothing.
- **No second place to edit the description.** The upload card's
  Description box remains the only editor; the modal only ever appends
  the watch-next line at schedule time.
- **Both worker call sites** of `buildPostExtras` (live and dry-run) get
  the new field, so dry-run output stays truthful to the live wire.

## Design

### 1. Schema and options object

- `packages/core/src/schemas.ts`: `youtubeOptionsSchema` mirroring the
  fields above (all optional; `visibility` an enum; `firstComment`
  length-capped at 10,000; `relatedVideoUrl` a URL string), added to
  `schedulePostSchema` as `youtube?`.
- `packages/publishers/src/options.ts`: `YouTubeScheduleOptions`
  interface, `TargetOptionsInput` gains `youtube?`, and the YouTube
  branch of `buildPostExtras` builds `platformSpecificData` from title
  plus the sparse options, mapping `aiLabel` to
  `containsSyntheticMedia` and dropping `firstComment` when
  `madeForKids` is true. `relatedVideoUrl` is deliberately not mapped
  (the route consumes it before the worker ever sees the options).

### 2. Route

`apps/api/src/routes/posts.ts` schedule handler:

- Parse `body.youtube` through the new schema.
- For the YouTube target: when `relatedVideoUrl` is present, append
  `\n\nWatch next: <url>` to the description before it becomes
  `target.caption`, exactly once.
- Store `options: { youtubeTitle, youtube }` for YouTube targets (the
  stored `youtube` object keeps `relatedVideoUrl` for audit, the builder
  ignores it).

### 3. Catalogue and playlist endpoints

- `GET /clients/:id/external/youtube/videos`: agency-scoped like every
  clients route; `ExternalVideo.findMany` on the client's YouTube
  accounts, `select` of `platformVideoId, title, thumbnailUrl, url,
  publishedAt, views`, newest first. Indexed by the existing
  `[socialAccountId, publishedAt]` index.
- `GET /clients/:id/external/youtube/playlists`: resolves the client's
  YouTube account handle, calls `youtube.listPlaylists(handle)`, returns
  `{ id, title }[]`. Returns an empty list rather than erroring when the
  provider is unconfigured or the channel has no public playlists.
- `packages/publishers/src/youtube.ts`: `listPlaylists(handle)` using
  `playlists.list?part=snippet&channelId=...&maxResults=50`, reusing the
  existing channel resolution.

### 4. ScheduleModal

`apps/desktop/src/modals/ScheduleModal.tsx`, following the Instagram
section's exact pattern (conditional block, pill toggles, flabel plus
hint):

- Rendered when YouTube is among the selected platforms: pills for Made
  for kids and AI label; selects for Visibility (Public default),
  Category, Playlist; a first-comment input (disabled with a hint while
  Made for kids is on); and the Related video row.
- The Related video row holds a button that expands an inline list of
  the catalogue (thumbnail, title, views, date) with a client-side
  search box over titles; choosing a video collapses the list and shows
  a removable chip with the title. The section's copy notes the link
  lands at the end of the description and that the Studio pin remains
  manual.
- The catalogue and playlists load lazily on first render of the
  section, each with a quiet failure state (hint text, no toast; the
  operator can schedule without them).
- `youtubeBody()` mirrors `instagramBody()`: sparse, `undefined` when
  untouched.

### 5. Worker

`apps/worker/src/index.ts`: the stored-options read widens to
`{ instagram?, youtubeTitle?, youtube? }`, and both `buildPostExtras`
call sites (live and dry-run) pass `youtube` through.

### 6. Checks

Extend `packages/publishers/src/options.check.ts` in the existing style:

- Full YouTube options map to the expected `platformSpecificData`
  (including `aiLabel` to `containsSyntheticMedia` renaming).
- Sparse options: untouched fields absent from the output, no
  `platformSpecificData` at all when nothing is set and no title exists.
- `madeForKids: true` drops `firstComment`.
- `relatedVideoUrl` never appears in the wire output.
- The Shorts no-thumbnail rule is unchanged.

The description append in the route is one line beside the existing
caption assembly; the whole-branch review and the live dry-run walk
cover it.

## Out of scope, recorded so it is not lost

- Members-only visibility, the true Studio Related-video pin, and
  geotagging: Studio-only walls, no API anywhere. Accepted by Tyrone
  ("it is what it is").
- Root-level `tags`: Zernio supports them but nothing in the app
  produces tags today; not worth a field nobody fills.
- Private playlists in the dropdown (the API-key path sees public ones).
- A per-target description editor in the modal.
- Any change to the Instagram options section.

## Verification

On the installed app with the full stack running:

1. Schedule a YouTube short in dry-run with every option set and a
   related video picked: the worker's dry-run log shows
   `platformSpecificData` carrying visibility, madeForKids, categoryId,
   playlistId, containsSyntheticMedia, firstComment, and title, and the
   caption ends with the `Watch next:` line. No real post.
2. Toggle Made for kids on: the first-comment input disables in the
   modal, and a stale first comment does not survive into the dry-run
   wire output.
3. The Related video list shows the account's catalogue with search;
   picking and removing a video updates the chip.
4. The playlist dropdown lists the channel's public playlists; with the
   provider unconfigured it degrades to the hint state.
5. `pnpm --filter @toreroflow/publishers test`, api and desktop tests,
   and all seven workspace projects typecheck.
6. Tyrone's manual step, unchanged from item 4's pattern: the first real
   publish with options set, verified on YouTube itself.
