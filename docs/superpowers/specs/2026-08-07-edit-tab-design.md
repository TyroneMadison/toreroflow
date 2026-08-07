# The Edit tab: an in-app video studio, analyzer and idea engine

Date: 2026-08-07. Status: approved for build (Tyrone's standing instruction: make the
call, build the whole thing, report decisions at the end).

## What this is

A new sidebar tab, **Edit**, with a film icon, holding three connected areas:

1. **Studio.** Drop raw footage, get an auto-cut, caption-styled, viral-ready vertical
   video. Word-level transcript editing, a real timeline (clips, B-roll, graphics,
   audio, text), per-clip zoom moves and color, twelve caption templates plus full
   custom styling, and a CapCut-grade export that renders on the server and lands
   straight in Upload & Schedule.
2. **Analyze.** Drop any video (or pick one already uploaded) and get an AI
   second-by-second breakdown: hook, retention and payoff scores on gauges, a
   key-moments strip on the video's own timeline, what worked, a four-step action
   plan of concrete fixes, and spin-off ideas with ready-to-say hooks.
3. **Ideas.** A per-brand niche profile, AI-generated formats and hooks, a
   brainstorm chat, and an ideas list with statuses (Idea, Scripting, Ready to Film,
   Posted, Analyzed) and one-press script/storyboard generation. Fed by, and feeding,
   the Account Overview "what to do next" plans.

All three read from the same **knowledge base**: the existing per-client knowledge
notes, extended with drag-and-drop files (PDFs, text, videos, images) whose contents
are extracted once and ground every AI feature.

The design follows Toreroflow's liquid-glass language throughout: glass panels with
`--lg-rim`/`--lg-sheen`, trough inputs, coral (`--v`) for selection and primary
actions, compositor-only motion. Layout and interactions mirror the reference
walkthrough in `docs/research-private/format-finder/` (gitignored); every visual
surface is restyled, nothing is copied pixel-for-pixel.

## Decisions

- **One sidebar tab, three sub-areas.** The sidebar stays readable. The Edit screen
  opens on Studio with a segmented pill row: Studio, Analyze, Ideas. The tab is
  brand-scoped (`key={edit-${selectedClientId}}`) like Upload; projects, analyses,
  ideas and knowledge all belong to the active brand.
- **New `i-film` icon** in the sprite (stroke style, matching the set).
- **Editor sources are their own thing, not MediaAssets.** A project owns its clips,
  audio, and graphics (`EditAsset` rows under `storage/<clientId>/edit/<projectId>/`).
  MediaAsset stays the publish pipeline with its quota counts and retention sweeps
  untouched. The bridge is explicit: exporting with "Send to Uploads" plays the
  rendered file through the normal upload pipe, producing an ordinary `kind:"video"`
  MediaAsset that gets its own thumbnail, transcript and quota slot.
- **Preview is client-side, render is server-side.** The webview previews a
  browser-safe 1080p proxy of each clip (conformed at intake, same recipe as
  carousel slides) with captions, text, graphics, color and zooms drawn as DOM/CSS
  on top. The export renders from the ORIGINAL files with ffmpeg on the worker, so
  preview cost never limits output quality.
- **The edit document is one JSON blob** (`EditProject.doc`, versioned `v:1`),
  autosaved with a debounce like Format Finder autosaves, with in-memory undo/redo.
  Past renders never mutate: Save Copy forks the project row.
- **Word-level timestamps come from the captions service.** `word_timestamps=True`
  in faster-whisper, a `words` array per segment, and a new API endpoint that hands
  a transcript to the desktop (today only `hasTranscript` crosses the wire).
- **Auto-cut is local math, not billed AI.** Silence gaps and filler words
  ("um", "uh", "er", "uhm") fall out of the word timestamps; Tighten removes them.
  **Shorten is the billed one**: a button-gated model call picks the least
  load-bearing sentences to hit the chosen cut (10-20s, 20-30s, 30-40s), and the cut
  is shown as removed words the operator can restore. Nothing bills automatically.
- **Captions burn in via ASS subtitles** (libass ships in the server's ffmpeg).
  ASS natively covers fonts, outline, shadow, glow-approximation, background boxes,
  positioning, karaoke word-highlight and per-word timing, which is exactly the
  caption style surface. Text blocks render the same way. One`captionsToAss()`
  pure function owns the mapping, with a runnable check.
- **The analyzer is AI content analysis and says so.** No platform exposes
  per-second retention (proven in research: the reference app fully scores a
  zero-view video). Ours reads the transcript plus sampled frames and scores
  against a written rubric grounded in the brand's knowledge base. The screen
  never claims platform data.
- **Analysis, render and knowledge extraction run as worker queues** with the
  established 202 + status row + poll triad. Renders report percent progress
  parsed from ffmpeg.
- **Four action-plan cards, not three** (Tyrone's explicit delta), each a titled
  step with one concrete, video-specific fix.
- **Ideas are rows, not prose.** `ContentIdea` per brand with status lifecycle,
  source tag (brainstorm, analysis, overview, custom), optional hook and generated
  script. Analyze's spin-offs and Brainstorm's hooks both land here through
  "+ Add to ideas". The Account Overview insights job now receives the brand's
  open ideas and knowledge in its prompt, so the game plan and the Ideas store
  stop being strangers.
- **The knowledge base extends, never duplicates.** `KnowledgeNote` stays. New
  `KnowledgeFile` rows carry dropped files; extraction is automatic on drop
  (PDFs and text locally, video via local whisper - both free; images get one
  vision description call, the single AI cost in ingestion, noted in the UI).
  Every existing consumer (carousel writer, insights) plus all new ones read
  notes + extracted file text through one shared `knowledgeContext()` helper.
- **Editor caps:** 4GB per source file (the multipart limit already in place),
  500MB per analyzer upload, mirroring the reference app's own limits.
- **Deferred, recorded:** vocal isolation (needs a source-separation model;
  UI slot reserved), paste-a-platform-link analyzer intake (ToS + downloader
  fragility; analyzer takes files and existing uploads), the refine-niche quiz's
  full five-step wizard ships as a single editable niche profile form first.

## The build, in five milestones

### M-A: plumbing and the tab
Schema (`EditProject`, `EditAsset`, `VideoAnalysis`, `ContentIdea`, `KnowledgeFile`,
`Client.nicheProfile Json?`), hand-written migration, captions word timestamps,
transcript endpoint, the Edit tab + film icon + segmented shell, the `edit` and
`analyze` and `knowledge` worker queues (empty handlers), route groups
(`editor.ts`, `analysis.ts`, `ideas.ts` + knowledge file routes beside the note
routes), signed-URL wiring, checks for the new pure modules as they land.

### M-B: Studio
Intake (multi-drop, order, per-clip duration and delete, conform + strip + words),
the four-step stepper, Word Editor (remove/restore/edit words), Timeline (lanes,
filmstrip, playhead, transport with zoom, clip select strip: split, move to B-roll,
delete), clip quick actions (push in, punch in, quick zoom S/M/L), clip adjustments
(zoom, position, rotate, volume), universal + per-clip color, audio lane
(upload, record voiceover at playhead, presets), graphics lane, text blocks with the
full style grid and animate in/out, phone preview with EDL playback, safe-zone eye,
undo/redo, autosave. Pure core: `editDoc.ts` (doc model + invariants),
`autoCut.ts`, `edlFromDoc.ts` - each with checks.

### M-C: captions and export
Caption templates (twelve + custom saved from current settings), style accordion
(font, color, size, spacing, position, case, alignment, word/line 1-5, lines 1-2,
accent, shadow, outline, glow, background), caption breaks editor, `captionsToAss()`
with check, the render pipeline (`renderEdit()` filter graph builder with check,
progress reporting, success/failure states), the export panel (name, resolution
720/1080/1440 capped at source, 30/60 fps, MP4/MOV, bitrate presets with researched
defaults), Send to Uploads handoff via the pendingDraft pattern, Download via
signed URL. Render is non-blocking: leave the screen, a status chip keeps working.

### M-D: Analyze
Intake (drop up to 500MB or pick an existing ready upload), the analysis worker
(probe, transcribe, sample 12 frames, one schema-locked model call), the detail
screen (three SVG arc gauges with Details, the key-moments strip with clickable
insights, peak score bar, Overview with viewer value + what worked, transcript
card with timestamps and copy, four-card Action Plan, Spin-Off Ideas with add-to-
ideas and generate-more), the scoring rubric document, list screen with stat cards.

### M-E: Ideas, knowledge, and the overview sync
Niche profile card + edit form, Generate formats/hooks (categories: Challenge,
Educational, Storytelling, Skits, Wait For It, Talking Head POV; pick-for-me),
hooks list with + Ideas collector, brainstorm chat grounded on knowledge, the ideas
table (filters, search, status dropdown, generate script/storyboard, delete,
add custom), knowledge section (notes as today + file drop zone with extraction
status), `knowledgeContext()` adopted by carousel writer and insights, insights
prompt fed with open ideas, loading screens with the playful status lines.

Each milestone lands as reviewed commits with runnable checks; the whole feature
walks through the visual preview harness before anything is pushed.
