# MASTER PROMPT — Toreroflow Studio "Clips" upgrade (Opus Clip–class editing)

This file lives at `docs/MASTER-PROMPT.md`. The feature-by-feature inventory it builds on is `docs/FEATURES.md`.

---

## 0. Who you are and what you are building

You are a senior engineer working in the **Toreroflow** monorepo (`E:/Claude Stuff/Toreroflow`, GitHub-hosted, pnpm workspaces,
TypeScript ESM, Node ≥ 20). Your job is to upgrade the **Edit → Studio** feature so it works like Opus Clip: drop one long video,
get back a ranked list of short vertical clips with virality scores, each one opening in the existing word-based editor already
cut, reframed to the speaker, captioned word by word, and ready to render in batch and send to Uploads.

This is a **clean-room build**. Opus Clip was studied from the outside only (UI strings, network shapes, public API docs). Do not copy
any Opus code, names of their internal modules, assets, fonts, Lottie/Rive files, or copy. Use the behavior notes in section 2 as a
product spec, not as code to clone.

Ship in **phases** (section 5). Each phase is one branch + one PR, leaves the app working, and passes `pnpm -r test`. Do not start
a phase until the previous one is merged, unless section 7 says the workstreams are independent.

## 1. Read these first (do not skip)

Read fully before writing code. Trace the real flow end to end.

- `docs/FEATURES.md` (the 135-feature inventory: status, priority and phase for every feature this prompt refers to)
- `README.md`, `CHANGELOG.md`, `docs/superpowers/specs/2026-08-07-edit-tab-design.md`, `docs/research-private/format-finder/studio-architecture.md`
- `packages/core/src/editDoc.ts` (EditDoc v1 types, `emptyDoc`, `addCut`, `normalizeCuts`, `toggleWordRemoved`, `splitAt`, `applyTemplate`, `CAPTION_TEMPLATES`, `ZOOM`, `DEFAULT_CLIP_FX`)
- `packages/core/src/edl.ts` (`edlFromDoc`, `outputDuration`, `locate`, `outputWords`, `toOutputTime`)
- `packages/core/src/autoCut.ts`, `captionChunks.ts`, `captionsToAss.ts`, `analysis.ts` and every sibling `*.check.ts`
- `packages/media/src/renderEdit.ts` (`buildRenderPlan`, `renderEdit`), `packages/media/src/ffmpeg.ts`
- `apps/api/src/routes/editor.ts`, `apps/api/src/routes/analysis.ts`, `apps/api/src/server.ts`, `apps/api/src/auth/botAccess.ts`, `apps/api/src/env.ts`
- `apps/worker/src/index.ts` (queue dispatch ~:956), `apps/worker/src/edit.ts`, `apps/worker/src/analyze.ts`, `apps/worker/src/transcribe.ts`
- `apps/captions/main.py` (FastAPI, faster-whisper, demucs)
- `packages/db/prisma/schema.prisma` (`EditProject`, `EditAsset`, `MediaAsset`, `VideoAnalysis`), `packages/db/src/queue.ts`
- `apps/desktop/src/editor/**` (StudioHome, StudioEditor, useEditDoc, WordEditor, Timeline, PhonePreview, steps/*, panels/*), `apps/desktop/src/screens/EditScreen.tsx`, `apps/desktop/src/lib/api.ts`, `apps/desktop/src/lib/routes.ts`

### What exists today (verified)
- Studio = 4 steps: Auto cut → Edit (Word editor | Timeline) → Caption style → Export. One `EditProject.doc` JSON blob (EditDoc v1), autosaved by debounced whole-doc `PATCH /edit-projects/:id`, undo/redo in `useEditDoc`.
- Transcription: `apps/captions` faster-whisper **base**, CPU int8, `vad_filter`, `word_timestamps`; no language param; worker `transcribe()` has **no timeout** and returns `null` on failure (long files silently get zero words).
- Render: worker `renderProject` → `buildRenderPlan` → ffmpeg: trim/setpts, eq, colortemperature, rotate, then **fit+pad letterbox to 9:16** (`renderEdit.ts:170`), center-anchored `zoompan`, concat, overlays, ASS `subtitles`, amix, libx264. Output is **always 9:16**.
- Preview (`PhonePreview.tsx`) applies `clipFx.zoom/x/y`, but **render ignores them** (preview/export mismatch).
- Main track allows **one entry per asset** (`clips: {assetId}[]`), so one long source cannot yield several separate segments.
- Captions: 12 templates, 7 animations, ASS burn-in; karaoke `\k` divides chunk time **evenly** instead of using word timings; custom templates live in **localStorage** only; fonts are woff2 (libass/brotli support unverified in Docker).
- B-roll audio is not mixed; a main clip with **no audio stream breaks render** (`renderEdit.ts:~200`).
- AI: Anthropic only (`@anthropic-ai/sdk`), model from `env.SUGGESTIONS_MODEL` (api) / `env.COPY_MODEL` (worker). Analyzer scores whole videos (hook/retention/payoff); Shorten trims one video by sentences. **No long→short clip finding, no per-clip scores, no face detection, no reframe.**

## 2. Product spec (what "Opus-class" means here)

Observed Opus Clip behavior, translated to our feature set. Build these, in our own design language.

**A. Long → shorts clipping ("Clips")**
- Input: one long video (upload; URL import is out of scope, ToS). Options: **range** (start/end sec), **clip length** buckets (`<30s`, `30–60s`, `60–90s`, `90s–3m`, or custom min–max), **genre** (Auto, Podcast, Interview, Talking head, Vlog, Education, Comedy, Motivational, Marketing, Product review, Church, Gaming, Q&A), optional **prompt** ("find moments about X / funny moments"), **topic keywords**, **aspect ratio** (9:16, 1:1, 4:5, 16:9), **caption template**, toggles (auto hook headline, remove fillers, remove pauses, auto zoom, keyword highlight, emojis).
- Output: N candidate clips. Opus returned **24 clips from an 18-minute podcast**, so aim for about 1 clip per 45 s of source (minimum 5). Each clip has:
  - **An ordered list of source ranges**, not one start/end. A clip can stitch 1–5 pieces, skip tangents, and **pull a strong 1–4 s line forward as the opening hook** (Opus clip #3 opened with a 2 s line from 12:36, then played 9:40–11:19). Every range is snapped to word boundaries.
  - A **title**, a one-line **why**, a 1–2 sentence **description**, and **hashtags**.
  - A **length target** it was made for. Opus ran several targets in one job (15–120 s and 0–180 s) even when the user picked "Auto".
- **Overlapping variants are allowed on purpose.** A 28 s cut and a 102 s cut of the same moment can both appear (Opus #1 sits inside #9). Only drop near-duplicates: over 80% overlap within the same length target.
- **Scoring (observed exactly):** an LLM *judge* pass gives four **0–10 integer** sub-scores, each with a one-sentence comment. **Hook**: do the first seconds grab attention and set up the topic. **Flow**: claim, development and payoff in order, with no dangling reference. **Value**: a useful, emotional or personal takeaway. **Trend**: does the topic fit what the audience cares about now. Add a fifth **Relevance** score when a prompt was given, and an optional **Sponsorship** flag. Raw score = the sum. **The 0–99 number users see is curved by rank inside the job**: the top clip always shows about 99 and the median about 79. Store raw and shown separately; raw is the only one comparable across jobs.
- Clip list UI: sort by score or chronological; filter liked/disliked/edited/rendered; thumbs up/down per clip (stored, for later tuning); keyword search across clip transcripts; select many → batch render / batch send to Uploads; per-clip "Open in editor", "Duplicate", "Re-score".
- **Refine**: from a clip, "extend/shrink" by sentence and "find another clip in this range" (re-run curation over a time window).

**B. Editor (per clip) — keep the current Studio, add:**
- Word-based editing stays the spine: deleting words deletes video; captions, cuts, zooms, hooks, B-roll spots all key off word indices.
- **Speech cleanup panel**: filler words (configurable list incl. multi-word "you know", "I mean", "kind of"), pauses longer than X s (slider), **bad takes / retakes** (AI finds restarted sentences and keeps the last good take). Show counts, per-item keep/remove, "remove all", fully undoable.
- **Layouts**: Fill (crop to speaker), Fit (letterbox/blur background), Split (two speakers stacked), Screenshare (screen on top, face below). Per segment, with an "Auto" default chosen from face analysis.
- **Auto reframe (observed: one static crop per camera shot).** Split the clip into shots at scene cuts. For each shot, pick the layout and **one fixed crop**:
  - **Fill**: a full-height window at the output aspect, centered horizontally on the active speaker's face. For 16:9 to 9:16 the width is 0.316 of the frame.
  - **Split**: a wide shot where two faces are both active, as two face-centered crops stacked. Each crop is 9:8 for 9:16 output.
  - **Fit**: no usable face. Letterbox over a blurred copy.
  - **Screenshare**: a screen region plus a face.
  - Only when a speaker visibly moves inside one shot do you use smooth tracking keys (Opus flags this `movingSpeaker`). A multi-camera podcast is mostly hard cuts between static crops, so it looks like an edit, not a robot camera.
  - Manual override: drag the crop in preview. The drag is stored as an adjustment on that shot.
- **Captions upgrade**: true per-word timing (highlight/karaoke/pop driven by real word start/end), **AI keyword highlight** (1–2 words per chunk in accent color), **AI emojis** (optional, per chunk), auto vertical placement that avoids the face box, lines per page, line spacing, background box with padding/radius, export **SRT** and **TXT**.
- **Auto hook headline**: AI writes a short attention line (5–8 words, title case) shown for the **first 5 s**. Observed style: black heavy sans (800 weight) on a white rounded box (radius 10), centered near the top third. Editable and regenerable. Applied automatically to the **top 10 clips only**.
- **Auto zoom**: AI picks emphasis moments; about 1 zoom per 30 s. Use keyframed zoom curves anchored on the face, not the frame center. The observed preset `slow_push`: 1.0 → 1.18 linear over 3 s, hold about 1 s, snap back out in about 0.2 s. Also offer `punch_in` (fast in, hold) and keep our existing push/punch/quick presets as named curves.
- **Keyword highlight (observed)**: each caption word has a highlight level of 0 (none), 1 (primary color) or 2 (secondary color). Opus highlighted about 6% of words primary and 4% secondary, always content keywords, never fillers. About 1 contextual emoji per 20 s, anchored to a word.
- **Auto B-roll spots** (no stock API required): AI marks moments + search keywords; user fills from their own uploaded clips/graphics; optional Pexels stock search behind an env key.
- **Brand kit / Recipes**: save a named preset (caption template + style, layout, aspect, toggles, fonts, logo overlay, intro/outro asset) per client in the DB; apply on new clip jobs; "set as default".
- **Version history**: named snapshots of the doc you can restore.
- **Transcript search** in the Word editor (Enter / Shift+Enter to step matches).

**C. Render**
- Exactly what preview shows: per-shot crops (and tracking keys), clipFx zoom/x/y, layout, real word-timed captions, B-roll audio, silent clips.
- Any of 4 aspect ratios. Batch render of many clips through the existing queue with per-clip progress.

**D. Observed details from a live Opus editor session (adopt the idea, not the names)**
- Every timed item keeps **two clocks**: source time and output time. Toreroflow already does this (`cuts` in source time, overlays in output time). Keep it, and make every new item explicit about which clock it uses.
- The transcript stores **silence as tokens** (`__silence` with start/end) next to words. Do the same in our word list (`{start,end,word:"", kind:"silence"}`), so pause removal, caption pages and B-roll spots all work from one list.
- Words carry flags, not separate cut lists: `deleted`, `kind: "filler"` (including multi-word "you know"; 6% of words in a real podcast clip), a highlight level 0/1/2, an optional speaker id, and an optional edited text. Cuts are derived from deleted words plus manual cuts, so every word edit is reversible.
- Stutters and false starts stay in the transcript ("I, I, I've", "in- integrate"). That's what bad-take and filler cleanup work on, so don't let transcription smooth them away. Use `word_timestamps` with no text normalization.
- One caption "page" is one timeline segment holding its words. This matches our `chunksFor` plus `breaks`.
- Emojis and keyword highlights are **anchored to a word id or index**, so they move with retiming and cuts.
- Positions are **center-relative percent rects** (x/y offset from center, w/h as a fraction of the frame), the same convention as our `TextStyle.x/y`. Use it for crop rects, emoji rects and caption boxes.
- Face and people analysis is stored **per keyframe span**, next to the crop rect derived from it. Manual edits go into separate `adjustment` fields, so re-running auto reframe never loses user tweaks.
- Opus samples faces at **15 fps**. Default ours to 5 fps for CPU cost, and make it configurable (`FACE_FPS`).
- The server precomputes a **proxy**, audio and **waveform peaks** per clip, so the timeline draws instantly. Add a peaks JSON to `processEditAsset`.
- The per-clip preference **is** the brand-kit shape: caption animation name, highlight primary/secondary colors, uppercase, font with stroke width and shadow, layout enable flags, fit-layout crop ratio, and speaker colors. Model `Recipe.settings` on this, so a recipe applies to a clip without translation.

## 3. Architecture decisions (follow these)

1. **EditDoc v2** in `packages/core/src/editDoc.ts` with a pure `migrateDoc(v1) → v2` (and a `.check.ts`). `useEditDoc` and the worker call `migrateDoc` on load. Changes from v1:
   - `clips: { id: string; assetId: string; srcIn: number; srcOut: number }[]` — multiple segments per asset allowed. `cuts`, `wordEdits` stay keyed by **assetId in source time** so word edits survive re-segmenting. `edlFromDoc` intersects each clip segment with that asset's cuts.
   - `output: { aspect: "9:16" | "1:1" | "4:5" | "16:9" }` (default `"9:16"` for migrated docs). `export.resolution` becomes the short edge.
   - `layout: Record<clipId, { kind: "auto" | "fill" | "fit" | "split" | "screenshare"; fitBg: "blur" | "black" | "color"; bgColor?: string }>`
   - `shots: Record<assetId, Shot[]>` where `Shot = { start: number; end: number /*source sec, scene-cut bounded*/; layout: "fill" | "split" | "fit" | "screenshare"; crops: Rect[] /*1 for fill, 2 for split/screenshare*/; auto: true; keys?: ReframeKey[] /*only for moving speakers*/ }` and `Rect = { x, y, w, h }` as center-relative fractions (the same convention as `TextStyle.x/y`). `ReframeKey = { t /*source sec*/; x; y; zoom; ease: "hold" | "linear" }`. Shots are keyed by source time, so cuts don't move them.
   - `faces?: Record<assetId, string>` storage key of the face-track JSON (do not inline large arrays in the doc).
   - `captions.highlight: { keywords: Record<assetId, number[] /*word indices*/>; emojis: Record<assetId, Record<number, string>> }`
   - `shotAdjust: Record<assetId, { start: number; end: number; layout?: Shot["layout"]; crops?: Rect[] }[]>` holds manual overrides separately from auto `shots`; manual wins inside its span. Re-running auto reframe only rewrites `shots`.
   - Words gain optional flags, stored on the asset's word list, not in the doc: `kind?: "word" | "silence" | "filler"`, `speaker?: number`. Worker inserts silence tokens for gaps ≥ 0.3 s and marks fillers (single and multi-word) at transcription time. Highlight levels live in the doc (`captions.highlight.keywords` becomes `Record<assetId, Record<wordIndex, 1 | 2>>`).
   - `hook?: { text: string; dur: number /*default 5*/; style: TextStyle }`
   - `zooms[]` items gain `curve?: { t: number /*sec from item start*/; scale: number }[]` and `anchor: "face" | "center"`; existing `kind`/`size` presets expand to curves.
   - A clip seeded from a candidate is just `clips` segments in **candidate order**, possibly out of source order, which is how a pulled-forward hook line works.
   - Keep everything else from v1. Bump `v: 2`.
2. **New Prisma models** (hand-written migration folder, never edit applied ones):
   - `ClipJob` — `id, clientId, sourceAssetId (EditAsset, kind clip), status (queued|transcribing|analyzing|curating|scoring|ready|failed), stage String?, pct Int?, error String?, options Json (range, lengths, genre, prompt, keywords, aspect, recipeId, toggles), createdAt, updatedAt`.
   - `ClipCandidate` — `id, jobId, rank Int, ranges Json ([[startSec,endSec], …] in play order), duration Float, lengthTarget String, title, why, description, hashtags String, hook Int, flow Int, value Int, trend Int (0–10 each), relevance Int?, sponsorship Int?, raw Int (sum), score Int (shown 0–99, curved by rank in job), comments Json ({hook,flow,value,trend,relevance?}), feedback String? (up|down), editProjectId String? (set when opened), createdAt`.
   - `Recipe` — `id, clientId, name, isDefault Boolean, settings Json, createdAt, updatedAt`.
   - `EditVersion` — `id, projectId, n Int, name String?, doc Json, createdAt` (cap 50 per project, oldest pruned).
   - `CaptionTemplate` — `id, clientId, name, style Json` (replace localStorage customs; migrate them up on first load, then clear localStorage).
   - Long-video transcripts: store full words in a JSON **file** under `storage/<clientId>/edit/<projectId>/<assetId>-words.json` and keep `EditAsset.words` for clips under 15 min; add `EditAsset.wordsKey String?` and `language String?`.
3. **Queues**: add `clips` to `QUEUE_NAMES` (`packages/db/src/queue.ts:30`). Worker handler branches on `data.job`: `"analyze"` (transcribe + scenes + faces), `"curate"`, `"score"`, `"seed"` (create EditProjects for chosen candidates). Rendering stays on the `edit` queue; batch render enqueues one `edit {job:"render"}` per project with a dedupe `key`. Keep `edit` concurrency 1 by default but make it `EDIT_CONCURRENCY` env.
4. **Captions service** (`apps/captions/main.py`) gains:
   - `POST /transcribe {path, language?, model?}`: model from env `WHISPER_MODEL` (default `small`, allow `base|small|medium|large-v3`), `device` from env (`cpu`/`cuda`), returns same shape plus `language`. For files > 20 min, transcribe in 10-min windows with 2 s overlap and stitch words by time (dedupe overlap), so no single request blocks for long.
   - `POST /faces {path, fps=env FACE_FPS (default 5), out}`: face boxes per sampled frame using **MediaPipe Face Detection** (or OpenCV YuNet if MediaPipe won't install on python:3.11-slim) plus a mouth-openness value per face (MediaPipe Face Mesh lip distance / face height). Writes JSON `{fps, w, h, frames:[{t, faces:[{x,y,w,h,score,mouth}]}]}` to `out`, returns `{out, frames}`.
   - `POST /scenes {path, threshold=0.3}`: scene cut times via ffmpeg `select='gt(scene,T)',showinfo` (can also live in `packages/media` — pick one, put it in `ffmpeg.ts` if pure ffmpeg).
   - Worker `transcribe()` gets an `AbortSignal` timeout (env `TRANSCRIBE_TIMEOUT_MS`, default 45 min) and **throws** a clear error instead of returning `null` silently; job status shows the reason.
5. **Reframe engine** (pure TS, `packages/core/src/reframe.ts` + `reframe.check.ts`): input face-track JSON + scene cuts + output aspect → `Shot[]`.
   - Shots = intervals between scene cuts. Split a shot further only if the active speaker changes and the faces are far apart (more than one crop width).
   - Per face per shot: `faceness` (detector confidence), `activeness` (z-scored mouth-motion variance over the shot; Opus showed +1.6 for the talker and -0.83 for the listener), and `isFake` (face that never moves its mouth and holds still across the whole source: posters, screens, photos; drop these).
   - Layout: one active real face → `fill` crop centered on it (full height, headroom with the face center around 40% from the top). Two faces, both active within the shot and too far apart for one crop → `split`, with two face-centered crops at half the output height. A large text or screen region plus a small face → `screenshare`. No real face → `fit`.
   - **Moving speaker**: only if the active face's center moves more than 15% of the frame width within one shot, emit `keys` with dead-zone (4%), max pan speed (25% width/s) and EMA α 0.15. Otherwise the crop is static.
   - Checks: single-cam talking head (one fill shot), two-camera podcast (alternating fill shots, no pans), wide two-shot (split), poster in background (dropped as fake), walking vlog (keys present).
6. **Render** (`packages/media/src/renderEdit.ts`, keep `buildRenderPlan` pure and covered):
   - Output size from `doc.output.aspect` + resolution (short edge). Even dimensions.
   - Split each EDL segment further at shot boundaries, so every render piece has one shot. Replace the fit+pad step with a layout step: **fill** = a static `crop` from the shot's rect (piecewise-linear `x`/`y` expressions only when the shot has `keys`), then `scale`; **fit** = scaled foreground over a `boxblur`/color background (`split` + `overlay`); **split** = two crops stacked (`vstack`); **screenshare** = top crop of screen + bottom crop of face.
   - Apply `clipFx.zoom/x/y` inside the crop math (so preview == export). Anchor `zoompan`/zoom items on the reframe center, not frame center.
   - Main clip with no audio stream → feed `anullsrc` for that segment (`probe` already knows). Mix B-roll audio (respect `volume`, fades) into `amix`.
   - Captions: generate ASS with **per-word events** (or `\k` with real per-word centiseconds from word start/end) so highlight/karaoke/pop match speech; keyword words get accent color; emojis as separate events. Move caption Y away from the face box when "auto placement" is on (use the reframe/face data).
   - Fonts: ship **TTF/OTF** copies alongside woff2 under `assets/fonts` and point libass `fontsdir` at them (woff2 is not reliable in libass). Verify inside the Docker image.
7. **AI calls** (all Claude, existing pattern — copy it exactly):
   ```ts
   const res = await anthropic.messages.create({
     model: env.COPY_MODEL /* worker */ , max_tokens: 4096,
     thinking: { type: "adaptive" },
     output_config: { effort: "low" | "medium", format: { type: "json_schema", schema: SCHEMA } },
     system: SYSTEM, messages: [{ role: "user", content }],
   });
   // check stop_reason for "refusal"/"max_tokens", JSON.parse the text block, then validate + clamp by hand.
   ```
   - JSON schemas must **not** use array `minItems`/`maxItems` (structured output rejects them); enforce counts after parsing. No em dashes or arrows in prompts or AI output strings (repo rule).
   - **Curation** (`apps/worker/src/clips/curate.ts`): first detect the genre in one cheap call if it's "Auto" (Opus detected "Podcast"). Send the timed transcript as numbered lines `[i] (12.40–15.10) text` in windows of about 12 min with 1 min overlap (parallel, max 3 concurrent). Run once per length target (e.g. 15–60 s and 60–180 s). Ask for clips as `{ranges: [[startLine, endLine], …] /*play order, 1–5 ranges*/, title, why, description, hashtags}`:
     - Each clip stands alone: no dangling "he/that" at the start, and it ends on a resolved thought.
     - It may skip tangents between ranges, and may open with one 1–4 s line pulled from later in the source as a hook.
     - It honors genre guidance, prompt, keywords and range.
     - After merging windows, snap ranges to word boundaries: start at the first word minus 0.15 s, end at the last word plus 0.25 s. Merge ranges less than 0.3 s apart. Enforce the length bounds. Drop only near-duplicates (over 80% overlap within the same length target).
   - **Judge** (`clips/judge.ts`, a separate pass, as in Opus): one call per batch of up to 8 candidates. Include each candidate's stitched transcript plus 4 sampled frames (first 1 s, 25%, 60%, last 1 s, as JPEG via `sampleFrames`). It returns `hook, flow, value, trend` (plus `relevance` with a prompt, and `sponsorship`) as **0–10 integers**, each with a one-sentence comment written as a strength plus one concrete improvement (Opus style: "The point develops clearly…; a concrete example would strengthen it"). Write a calibrated rubric (anchors for 3/5/7/9) like `ANALYST_SYSTEM` in `analyze.ts`. Trend uses the client's niche/brand info already in the DB; do not call web search per clip (cost).
   - **Score math** (pure, `packages/core/src/clipScore.ts` + check):
     - `raw = hook + flow + value + trend` (with a prompt: `raw = round(0.8 * that + 0.2 * relevance * 4)`).
     - Rank by raw; break ties by hook, then flow.
     - `shown = round(99 - 40 * (rank - 1) / max(1, N - 1))`. This matches Opus's observed top 99 and median about 79.
     - Store both. The UI shows `shown`; anything compared across jobs (feedback analytics, "best clips ever") uses `raw`.
   - **Hook headline**, **keyword highlight + emojis**, **auto zoom emphasis**, **bad takes**, **B-roll spots**: one small structured call each. Input is the clip's kept words with indices; output is word indices plus levels and text, never free-form times. Validate that indices are in range and kept. Targets from the observed Opus output: highlights about 6% primary and 4% secondary of words, emojis about 1 per 20 s, zooms about 1 per 30 s, headline 5–8 words. Hooks auto-apply to the top 10 clips only.
8. **API** (`apps/api/src/routes/clips.ts`, register in `server.ts`; `requireAuth`; bot-closed by default; tenant scope via `client: { agencyId: request.user.agencyId }`; zod `safeParse` → 400 `{error, detail}`; long work → **202 + status row + poll**):
   - `POST /clients/:clientId/clip-jobs` multipart upload (reuse the editor upload streaming code, create an `EditAsset` on a hidden holder `EditProject` or a nullable project — pick one and justify in the PR) + `options` → 202 `{jobId}`
   - `POST /clients/:clientId/clip-jobs/from-asset {editAssetId|mediaAssetId, options}` → 202
   - `GET /clients/:clientId/clip-jobs`, `GET /clip-jobs/:id` (status, stage, pct, candidates sorted), `DELETE /clip-jobs/:id`
   - `POST /clip-jobs/:id/refine {start, end, prompt?}` → 202 (curate + score a window, append candidates)
   - `PATCH /clip-candidates/:id {feedback}`; `POST /clip-candidates/:id/rescore`
   - `POST /clip-candidates/open {ids[]}` → creates one `EditProject` per candidate with a seeded v2 doc (the candidate's ranges as `clips` segments in play order, auto cuts per toggles, `shots` from faces, captions from recipe, hook for top-10 ranks, highlights, emojis, zooms; set `autoEdit: {tool: "applied" | "skipped"}` so the UI can say what ran) → returns project ids
   - `POST /edit-projects/render-batch {ids[], export}`; `GET /edit-projects/:id/subtitles.srt|.txt`
   - `GET/POST/PATCH/DELETE /clients/:clientId/recipes`, `/clients/:clientId/caption-templates`
   - `GET/POST /edit-projects/:id/versions`, `POST /edit-projects/:id/versions/:n/restore`
   - Per-clip AI: `POST /edit-projects/:id/ai/{hook|highlights|zooms|bad-takes|broll-spots}` → returns suggestions; the **desktop applies them as normal undoable doc edits** (same pattern as Shorten today).
9. **Desktop** (`apps/desktop/src/editor/`): React 18, no new state or router libraries, reuse `panels/index.tsx` controls and `lib/api.ts`.
   - `EditScreen` gets a fourth pill **Clips** (`?area=clips`). `clips/ClipsHome.tsx` (job list + drop zone + options form with Recipe picker), `clips/ClipJobView.tsx` (progress by stage, candidate grid: thumbnail strip, score dial reusing `analyze/ScoreDial`, sub-score bars with comments on hover, title, length, thumbs, checkbox, Open/Duplicate/Rescore; toolbar: sort, filter, search, batch Open, batch Render, batch Send to Uploads).
   - `PhonePreview` becomes aspect-aware (frame from `doc.output.aspect`) and renders crop/reframe exactly like the render math (share one pure function from `packages/core/src/reframe.ts` for "layout + crop rects at source time t"). Drag in preview edits the crop of the shot under the playhead and writes a `shotAdjust` entry.
   - Timeline: main track renders v2 `clips` segments (several from one asset), a **Layout** lane (one block per shot labelled Fill/Split/Fit/Screen, tracking keys as diamonds), a **Zoom** lane, and a **Hook** lane.
   - New panels: `SpeechCleanupPanel`, `LayoutPanel`, upgraded `CaptionStep` (word-timed animations, keyword/emoji toggles, auto placement, SRT/TXT buttons, DB templates), `VersionsPanel`.
   - Keyboard: keep `lib/keymap.ts`; add Enter/Shift+Enter for transcript search.

## 4. Repo conventions (non-negotiable)

- Pure logic in `packages/core` with a sibling `*.check.ts` using the existing hand-rolled `eq`/`deepEq` asserts, added to that package's `test` script chain. One small runnable check per non-trivial function (parsers, blends, reframe smoothing, EDL v2, migration, crop math, ASS word events). No new test framework.
- Immutable doc ops return the **same reference** when nothing changed (so `update()` skips undo pushes).
- Errors: `{ error: "short", detail: "full sentence for the operator" }`. Plain English in UI strings.
- Comments explain *why*; mark deliberate simplifications with `// ponytail: <ceiling>, <upgrade path>`.
- Prisma via `getPrisma()`, `Prisma.InputJsonValue`, `Prisma.DbNull`. Migrations hand-written under `packages/db/prisma/migrations/<timestamp>_<name>/migration.sql`.
- Jobs: `enqueue(queue, data, { key })` with explicit keys for idempotent work; handlers throw on failure; write status/stage/pct rows; desktop polls every 3 s.
- Files: everything under `STORAGE_DIR/<clientId>/edit/<projectId>/…`; served via signed `fileLink`/`fileLinkVersioned`. Never put large arrays (faces, long transcripts) in `EditProject.doc`.
- No new npm deps unless a few lines can't do it. Python deps go in `apps/captions/requirements.txt` and `infra/Dockerfile.captions`.
- Security: tenant scoping on every query; validate every path/ID from the client; signed URLs only; bot tokens closed unless whitelisted in `botAccess.ts`.
- Release: every user-visible change ships to web (rebuild webapp container) **and** desktop (bump `apps/desktop/package.json` + `apps/desktop/src-tauri/tauri.conf.json`, tag `v0.3.x`). Commit subjects carry the desktop version. Do not add AI co-author trailers to commits.

## 5. Phases (each = one PR, in order)

**Phase 1 — Foundations & fidelity (no new UI surface)**
- `transcribe()` timeout + thrown errors + status reason; `WHISPER_MODEL`/device env; `language` param; windowed transcription for > 20 min; `wordsKey` file storage; silence tokens and filler flags on words; waveform peaks JSON per asset (ffmpeg `astats` or a small PCM downsample) for the timeline.
- Render: honor `clipFx.zoom/x/y` (fill crop instead of letterbox when zoom ≥ 1), silent-clip `anullsrc`, B-roll audio mix, TTF fonts for libass (verify in Docker), per-word ASS timing for karaoke/highlight.
- Caption templates → DB (`CaptionTemplate`), one-time localStorage upload.
- Accept: a 60-min talk transcribes without silent failure; preview and export match for zoomed/moved clips (render a test project and compare 3 frames); a silent clip renders; karaoke highlight lands on each spoken word within ±80 ms.

**Phase 2 — EditDoc v2 + aspect ratios + layouts (manual)**
- `migrateDoc`, multi-segment main track (including out-of-source-order segments), `output.aspect`, `layout`, manual shot crops (drag in preview), aspect-aware PhonePreview, render for fill/fit(blur)/split/screenshare.
- Accept: old projects open unchanged and render identically (golden `buildRenderPlan` check on a v1 fixture); one 10-min source can produce 3 separate segments on the timeline; 1:1, 4:5, 16:9 render correctly.

**Phase 3 — Face tracking + auto reframe**
- `/faces`, `/scenes`, `packages/core/src/reframe.ts` (+ the 5 checks listed in section 3.5), "Auto reframe" button per clip, and a **Layout lane** on the timeline that shows each shot's layout (Fill/Split/…) like Opus's.
- Accept: on a two-camera podcast every shot is a static crop centered on whoever is talking, with layout changes only at camera cuts (no pans); a wide two-shot becomes Split; a poster face is never chosen; a walking vlog gets smooth tracking keys.

**Phase 4 — Clips: long → shorts with virality scores**
- `ClipJob`/`ClipCandidate`, `clips` queue (analyze → curate → score), `clipScore.ts`, API routes, ClipsHome + ClipJobView, open-in-editor seeding, refine, feedback, keyword search.
- Accept: an 18-min podcast yields about 20 candidates across at least 2 length targets. At least some candidates stitch several ranges, and at least one opens with a pulled-forward hook line. Each starts on a complete thought. Judge sub-scores spread over 4–9, not all 7. Shown scores run 99 at the top to about 79 at the median; opening a candidate gives a ready doc with reframe + captions; rerunning a finished job stage is idempotent.

**Phase 5 — AI editing passes**
- Speech cleanup panel (multi-word fillers, pause slider, bad takes), auto hook headline, keyword highlight + emojis, auto zoom on emphasis (face-anchored), B-roll spots (+ optional Pexels via `PEXELS_API_KEY`).
- Accept: each pass is one click, shows what it changed, and is fully undoable; all outputs are word-index based and survive later cuts.

**Phase 6 — Throughput & workflow**
- Recipes (apply on job create, set default), batch render with per-clip progress, batch Send to Uploads with AI title/description via existing `POST /media/:id/caption`, version history, SRT/TXT export, `EDIT_CONCURRENCY`.
- Accept: select 10 clips → one click renders all and lands them in Uploads with copy drafted.

**Phase 7: Polish & effects**
- Transitions with ffmpeg `xfade`: about 30 presets (cross fade/zoom/dissolve, blur dissolve, push and slide in 4 directions, dip/flash black or white, film burn). Add auto transitions at range joins, with a duration control.
- Lower thirds: name, title or location bar, entry direction, accent color.
- Hook style presets.
- Caption translation: Claude translates each caption page and keeps its timing.
- Censor: per-client curse-word lists; captions masked with dashes; audio bleeped (sine) or muted.
- Per-client custom font upload.
- Speaker colors: speaker = the active face of each shot.
- Enhance-speech ffmpeg chain: Demucs isolation + `highpass` + `afftdn` + `loudnorm`. Chunk it to lift the 4-minute cap.
- Import audio from an uploaded video file.
- Auto color per shot (`signalstats` → `eq`).
- Named looks.
- Progress bar (`drawbox` width expression) and a bundled sticker pack.
- Gameplay and PiP layouts, corner radius and spacing.
- Per-platform safe-zone overlays.
- B-roll split-with-speaker preset.

**Phase 8: Collaboration & distribution**
- Timestamped comments with replies and resolve, plus timeline markers. Pair them with a signed read-only review link for clients.
- Collections and favorites; team activity on clip actions.
- Per-clip performance pulled back onto `ClipCandidate` from existing analytics.
- Auto-import new uploads from the client's own YouTube channel or playlists (YouTube Data API, worker cron, default Recipe).
- Google Drive import.
- Premiere/FCP XML export generated from the EDL.
- Cross-project clip search (Postgres full-text).
- Bot-token access to the clip-job routes.

**Phase 9: Smarter AI**
- Multimodal curation that also sees scene cuts and sampled frames.
- Daily trending topics per client niche (the `web_search` tool), matched against candidate transcripts to feed the Trend score.
- A judge-tuning loop: likes/dislikes with reasons plus real post performance adjust the judge rubric and examples.

**Vendor-gated (do not build unless the owner adds a key):** AI voiceover hook (TTS), auto SFX, music library, AI image/video B-roll, Lottie motion graphics with person mask, AI upscale, dubbing, GIF search.

The full feature-by-feature inventory (135 rows with status and priority) is in `docs/FEATURES.md`.

## 6. Definition of done (every phase)

- `pnpm -r test` passes; new pure functions have checks that fail if the logic breaks.
- Typecheck clean across the workspace.
- Manually exercised in the desktop dev build against a local stack (`start.cmd`), including one long real video for phases 1, 3, 4.
- No preview/export mismatch for anything the phase touches.
- PR description: what changed, why, screenshots/GIF of the UI, the test video used, known ceilings (`ponytail:` notes), and the desktop version bump.
- No secrets, no keys in code, no files outside `STORAGE_DIR`.

## 7. If several bots work in parallel

Split by file ownership, never two bots on the same files:
- **Bot A (media/render):** `packages/media/**`, `packages/core/src/captionsToAss.ts`, `edl.ts`, fonts, Docker. Phases 1-render, 2-render.
- **Bot B (ML service):** `apps/captions/**`, `infra/Dockerfile.captions`, `apps/worker/src/transcribe.ts`, `packages/core/src/reframe.ts`. Phases 1-transcribe, 3.
- **Bot C (backend):** `packages/db/**`, `apps/api/src/routes/clips.ts`, `apps/worker/src/clips/**`, `packages/core/src/clipScore.ts`. Phase 4 backend, 5/6 endpoints.
- **Bot D (desktop):** `apps/desktop/**`. All UI, after the backend contract for that phase is merged.
- `packages/core/src/editDoc.ts` (v2 types + `migrateDoc`) is written **once, first, by Bot A**, reviewed, merged; everyone else builds on it.

## 8. Out of scope

URL import from platforms (ToS), AI-generated video B-roll, voice cloning/dubbing, eye-contact correction, in-browser WASM render engine (our preview stays `<video>` + CSS/canvas, final render stays server ffmpeg), auto-posting from the clip list (go through Uploads).

## 9. Start

Reply first with: (1) the files you read, (2) the phase you are taking, (3) your plan for it as a short checklist with the exact files you will touch, (4) any conflict you found between this prompt and the code (the code wins on facts; flag it). Then implement.
