# Upload copy: a named video, a caption, and YouTube's own title and description

Date: 2026-07-28
Status: approved
Source: "List of improvments for the app.md", item 9 (line 179), folded
together with item 15 (line 215) and its blueprint `BluePrintUploadUI.png`
at Tyrone's direction.

## Context

Item 9 asks that uploading not carry the file name as the video's name,
that the operator be able to rename it, and that YouTube's title and
description be treated separately from the platforms that only take a
caption. Item 15 asks for a dedicated YouTube title and description
section on the upload window, per the attached blueprint. Tyrone asked
that the YouTube section appear only when a YouTube toggle is on, and
agreed to fold the two items together, since they are one piece of work.

What the code does today:

- The file name is never copied into the Title field. It is displayed as
  the card's bold heading (`UploadSchedule.tsx:433-447`) and reaches the
  UI as `assetView`'s `name: a.originalName` (`media.ts:80`). So the
  complaint is real but it is a presentation problem, not a prefill.
- One Title does double duty. `posts.ts:65` computes
  `caption = body.caption ?? draft.title ?? draft.hook ?? ""`, and
  `posts.ts:94` gives that caption to every non-YouTube target. So the
  Title is the entire Instagram and TikTok caption, and the Description
  reaches YouTube only. That is backwards from how those platforms work.
- The draft prompt (`worker/index.ts:69-76`) tells the model the title is
  used verbatim as both the YouTube title and the Instagram caption, so
  AI drafts are written for the wrong contract.
- Typing a title and pressing Schedule without pressing Save copy
  publishes the previously saved text: `saveDraft` is only called by its
  own button (`UploadSchedule.tsx:191-208`), Schedule just opens the
  modal (`:583`), and the modal posts no caption
  (`ScheduleModal.tsx:152-157`), so the route falls back to the stored
  draft.
- `draftCopy` is a Json column with a read-time normalizer for legacy
  shapes (`media.ts:46-58`), so new fields need no migration.

## Decisions

- **Four named things, each with one job.**
  - `name`: the video's label. Blank on upload, editable in the card
    heading, and shown wherever the app currently shows the file name.
  - `description`: the caption for Instagram, TikTok, Facebook and
    Snapchat.
  - `youtubeTitle` and `youtubeDescription`: YouTube's own two fields.
- **The file name is never content.** It stays on `MediaAsset.originalName`
  because the revision heuristic reads it (`media.ts:125`) and because an
  unnamed video still has to be identifiable. It moves to small muted
  text under the heading.
- **Fallbacks are shallow and explicit**, so nothing posts empty and no
  operator has to fill four boxes:
  - Caption platforms: `description`, else `name`.
  - YouTube title: `youtubeTitle`, else `name`. When both are blank the
    title key is omitted and Zernio titles the upload from the first line
    of the content, which is its documented default.
  - YouTube description: `youtubeDescription`, else `description`, else
    `name`.
- **The YouTube toggle shows and hides, it does not choose platforms.**
  Platform choice belongs to the schedule modal, and a card-level picker
  would be a second source of truth that can disagree with it. The toggle
  defaults on when the brand has a connected YouTube account.
- **Scheduling saves first.** The Schedule button persists pending edits
  before opening the modal, and does not open it if that save fails.
- **The AI prompt is corrected** to write a YouTube title and a
  description that reads as the caption elsewhere.
- **Legacy drafts keep working.** The existing `title` maps to `name` on
  read, so every video already drafted keeps its text and behaves as
  before.

## Design

### 1. Storage and the read shape

`draftCopy` gains `name`, `youtubeTitle` and `youtubeDescription`
alongside the existing `description` and `hashtags`. No migration: it is
a Json column.

`normalizeDraft` (`apps/api/src/routes/media.ts:46-58`) becomes the one
place that maps any stored shape to the current one:

- `name`: `d.name`, else `d.title`, else `d.hook`, else `""`.
- `description`: `d.description`, else `d.caption`, else `""`.
- `youtubeTitle`: `d.youtubeTitle`, else `""`.
- `youtubeDescription`: `d.youtubeDescription`, else `""`.
- `hashtags` unchanged.

`draftSchema` (`media.ts:25-30`) accepts the same keys, all optional, so
the existing shallow merge keeps distinguishing "not provided" from
"cleared to empty".

### 2. The per-platform text, as one pure function

New `packages/core/src/postCopy.ts`:

```ts
export interface DraftCopy {
  name?: string;
  description?: string;
  youtubeTitle?: string;
  youtubeDescription?: string;
}

/** The caption body this platform receives. */
export function captionFor(platform: string, draft: DraftCopy): string

/** YouTube's title, or "" when nothing was written and the provider should name it. */
export function youtubeTitleFor(draft: DraftCopy): string
```

`captionFor` returns the YouTube description chain for `"youtube"` and
the caption chain for every other platform. Both trim, and treat a
whitespace-only field as blank. This is the only place the rules live.

### 3. The schedule route

`apps/api/src/routes/posts.ts` replaces its single `caption` variable
with a per-target call:

- `caption: captionFor(platform, draft)`, then the existing watch-next
  append for YouTube only.
- `options.youtubeTitle: youtubeTitleFor(draft)`; the builder already
  drops an empty title, so an unnamed video simply carries no title key.

`body.caption` and `body.hashtags` keep their existing override role.

### 4. The card

`apps/desktop/src/screens/UploadSchedule.tsx`:

- The heading becomes an input styled as the heading (borderless until
  focused), bound to `name`, placeholder "Name this video". The existing
  tags (Revision, Transcribed, AI copy drafted) stay beside it.
- Directly under it, the file name in small muted text.
- The separate Title input is removed. The Description textarea stays,
  its hint restated as the caption for Instagram, TikTok, Facebook and
  Snapchat.
- A "YouTube" toggle pill sits with the format and quota pills. It
  defaults on when the selected brand has a connected YouTube account.
  Toggling it reveals a panel holding "Title for YouTube upload" and
  "Description", following the blueprint's second card and reusing the
  existing `.field-in` and `.flabel` styles.
- The Schedule button awaits `saveDraft` when there are pending edits and
  opens the modal only on success.

The toggle's state is per asset and lives in component state, not in the
database: it controls disclosure only, and the YouTube fields it reveals
are persisted like any other draft field.

### 5. The name replaces the file name in the app

Where the app shows a video's file name to describe a post, it shows the
name when one exists and falls back to the file name:

- The queue rows and calendar chips read `assetName`
  (`posts.ts:174`), which becomes
  `draftCopy.name || mediaAsset.originalName`.
- `ScheduleModal` and `CoverModal` subtitles, and `PostDetailModal`'s
  heading, follow the same rule.

### 6. The draft prompt

`apps/worker/src/index.ts` `DRAFT_SCHEMA` and the system prompt produce
`{ name, description, hashtags }`: a short name for the video, and a
description written to work as the caption on Instagram, TikTok,
Facebook and Snapchat. YouTube's two fields are left for the operator,
falling back as described. The existing "never fail the pipeline for a
draft" behavior is unchanged.

### 7. Checks

`packages/core/src/postCopy.check.ts`, assert style under tsx, wired into
core's test script. It pins: each caption platform gets the description;
a blank description falls back to the name; YouTube gets its own
description, then the card description, then the name; the YouTube title
falls back to the name and is empty when both are blank; and
whitespace-only fields count as blank.

## Out of scope, recorded so it is not lost

- Making the card's YouTube toggle decide which platforms a video posts
  to. Platform choice stays in the schedule modal, and item 12 covers
  making that selection reliable.
- Any change to hashtags, the format picker, the quota toggle, or covers.
- Renaming the stored file on disk. `originalName` remains the file's
  identity.
- Per-platform captions beyond the YouTube split. Instagram, TikTok,
  Facebook and Snapchat continue to share one description.

## Verification

On the installed app with the full stack running:

1. Upload a video: the heading is blank with its placeholder, the file
   name sits small underneath, and no field carries the file name.
2. Type a name, a description, and YouTube's title and description, then
   reload the screen: all four persist.
3. With the YouTube toggle off the panel is hidden; toggling it on
   reveals both fields with their saved text intact.
4. Type into a field and press Schedule without pressing Save copy: the
   scheduled post carries what is on screen.
5. Prove the wire with a dry run: YouTube receives its own title and
   description, and the other platforms receive the card's description.
   No real post is made.
6. A video with only a name posts that name everywhere, and YouTube
   still receives a title.
7. The queue and calendar show the typed name rather than the file name.
8. `pnpm --filter @toreroflow/core test`, the api and desktop checks, and
   `pnpm -r typecheck` all pass.
