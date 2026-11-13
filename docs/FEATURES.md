# Opus Clip → Toreroflow: complete feature inventory

Every feature we could find in Opus Clip (2026-10-26). It's mapped to what Toreroflow already has and to how we'd build it.

**Evidence**:
- **L**: seen live in your account (the 2 runs).
- **C**: found in their app code or API calls.
- **S**: UI text only.
- **D**: their public docs.

**Toreroflow status**:
- ✅ has it
- 🟡 partial
- ❌ missing

**Priority**:
- **P0**: core of "Opus-class"; build first.
- **P1**: strong value.
- **P2**: nice to have.
- **P3**: needs a paid vendor or heavy ML.
- **Skip**: not worth building.

**Phase** refers to MASTER-PROMPT.md §5. **Phases 7–9** are new and listed at the bottom.

---

## A. Intake & project creation

| # | Feature | What Opus does | Ev | Toreroflow | How we build it | Pri | Phase |
|---|---|---|---|---|---|---|---|
| A1 | Large file upload | Browser uploads straight to cloud storage in 32 MB parts, resumable, up to 100 GB per file | L | 🟡 4 GB multipart through the API | Chunked upload with retry per chunk, stored straight to `STORAGE_DIR`; raise the cap; show per-file progress | P0 | 1 |
| A2 | Preflight probe | Before submitting: shows duration, resolution, language, thumbnail and **credit cost** | L | 🟡 probe runs after upload | `POST /clip-jobs/preflight` returns probe + estimated minutes/time before the job starts | P1 | 4 |
| A3 | Link import (YouTube, Zoom, Vimeo, Twitch, Rumble, FB, LinkedIn, X) | Paste a URL instead of uploading | S/C | ❌ (deferred for ToS reasons) | Allow **your own** YouTube channel only, via the YouTube API you already have; no generic downloader | P2 | 8 |
| A4 | Google Drive import | Pick a file from Drive | S/C | ❌ | Google Picker + Drive API download to storage | P2 | 8 |
| A5 | Upload your own .SRT | Skip transcription; use the user's captions | L | 🟡 SRT upload exists for long-form YouTube only | Accept SRT/VTT on clip jobs and parse it to words (even word spread inside each cue) | P2 | 6 |
| A6 | Speech language picker | Auto-detect or pick from about 25 languages | L | ❌ (auto only) | `language` param to whisper; dropdown | P1 | 1 |
| A7 | Processing timeframe ("credit saver") | Slider to clip only part of the video | L | ❌ | `options.range` on ClipJob; transcribe only that span | P0 | 4 |
| A8 | Workflow picker on home | One-click entry tiles: Long to shorts, Edit video, AI Captions, AI B-roll, AI Reframe, Auto SFX, Upscale, Voice dubbing, Enhance speech, Voiceover hook, Script to video, AI Producer | L | 🟡 Studio + Analyze + Ideas pills | Clips home with tiles for the workflows we support; each tile pre-fills a Recipe | P1 | 6 |
| A9 | "Don't clip" mode | Run captions/reframe/AI tools on the whole video without clipping | L | ✅ Studio is this (one video, no clipping) | Make Recipes able to target Studio too | — | 6 |
| A10 | Short-video rule | Under 1 min: captions and reframe only, no clipping | S | ❌ | Validation on ClipJob create | P1 | 4 |
| A11 | Auto-import from YouTube | Watches your channel or specific playlists and clips every new upload automatically with a Recipe | S/C | ❌ | Cron in worker polling the YouTube Data API for each connected client's channel; enqueue ClipJob with the default Recipe | P2 | 8 |
| A12 | Processing progress + ETA | Progress %, queue position, target delivery time; the tab title shows "% · Clipping" | L | 🟡 status rows + polling | `pct`, `stage`, `etaAt` on ClipJob; update document.title | P1 | 4 |
| A13 | Done notifications | Email/webhook on done or failed; in-app toast "project is done" | L/D | 🟡 desktop has notifications infra | Desktop notification + optional email via existing mailer | P2 | 6 |
| A14 | Source retention | Source kept 7 days ("TEMPORARY"), then deleted; clips kept | L | 🟡 retention sweeps exist for media | Reuse the `sourceDeletedAt` sweep pattern for ClipJob sources | P1 | 6 |

## B. AI clipping (long → shorts)

| # | Feature | What Opus does | Ev | Toreroflow | How we build it | Pri | Phase |
|---|---|---|---|---|---|---|---|
| B1 | Clip finding (ClipBasic) | Transcript-driven LLM curation; 24 clips from 18 min | L | ❌ | `clips/curate.ts` (master prompt §3.7) | P0 | 4 |
| B2 | Multi-range stitching | A clip = 1–5 source ranges, skipping tangents | L | ❌ | `ranges[]` per candidate; EditDoc v2 multi-segment | P0 | 2+4 |
| B3 | Hook pull-forward | Opens with a strong 1–4 s line from later in the source | L | ❌ | Curation may emit an extra leading range | P0 | 4 |
| B4 | Multiple length targets | Runs 15–120 s and 0–180 s buckets in one job | L | ❌ | One curation pass per bucket | P0 | 4 |
| B5 | Overlapping variants | Short and long cuts of the same moment both kept | L | ❌ | Dedupe only above 80% overlap within the same bucket | P1 | 4 |
| B6 | Clip length picker | Auto, <30s, 30–60s, 60–90s, 90s–3m, 3–5m, 5–10m, 10–15m | L/C | ❌ | Options form | P0 | 4 |
| B7 | Genre | Auto-detect (it said "Podcast") or pick: Podcast, Q&A, Marketing, Motivational, Academic, Product review, Comedy, Church, Vlog, Gaming, Others | L/S | ❌ | Genre-specific guidance in the curation system prompt | P1 | 4 |
| B8 | Prompted clipping (ClipAnything) | "Find moments about X / funny moments"; adds a relevance score | S/C/D | ❌ | `prompt` option + relevance in judge | P1 | 4 |
| B9 | Topic keywords | Bias curation toward keywords | C/D | ❌ | `keywords` option | P2 | 4 |
| B10 | Multimodal clip finding | ClipAnything also uses visual/audio/sentiment cues | D | ❌ | Give curation scene cuts + sampled frames per window (Claude vision) | P2 | 9 |
| B11 | Virality score | Judge gives Hook/Flow/Value/Trend 0–10 + comment each; raw sum; shown 0–99 curved by rank | L | 🟡 Analyzer scores whole videos | `clips/judge.ts` + `clipScore.ts` | P0 | 4 |
| B12 | Score breakdown UI | Hover shows 4 sub-scores with comments | L/S | 🟡 ScoreDial exists | Reuse ScoreDial + bars | P0 | 4 |
| B13 | Per-clip title, description, hashtags | Generated with each clip | L | 🟡 copy generator exists for MediaAsset | Generate in curation; reuse when sending to Uploads | P0 | 4 |
| B14 | Sort & filter clips | Sort by score or chronological; filter liked/disliked/edited/dubbed/length/keywords | L/C | ❌ | ClipJobView toolbar | P0 | 4 |
| B15 | Search clips | "Find keywords or moments…" across clip transcripts; cross-project semantic search | L/C | ❌ | In-job text search (P0); cross-project search via Postgres full-text on candidate transcripts (P2) | P0/P2 | 4/8 |
| B16 | Like / dislike + reasons | Thumbs plus a reasons survey (bad topic, wrong length, caption errors…), collected for training | L/C | ❌ | `feedback` + `feedbackReasons` on ClipCandidate; later feeds a judge-prompt tuning loop | P1 | 4 |
| B17 | Refine / find more in range | Re-run curation on a time window or with a new prompt ("Create more from your original video") | C/S | ❌ | `POST /clip-jobs/:id/refine` | P1 | 4 |
| B18 | Duplicate clip | Copy a clip to make a variant | L/C | 🟡 project copy exists | `POST /clip-candidates/:id/duplicate` | P1 | 4 |
| B19 | Re-run project | Re-process with a newer model or settings | S | ❌ | `POST /clip-jobs/:id/rerun` reuses transcript/faces | P2 | 6 |
| B20 | Bonus clips | Extra lower-ranked clips as a toggle | C | ❌ | Return clips past the cutoff, flagged `bonus` | P2 | 4 |
| B21 | "Tools applied" summary | Per clip: which AI tools ran, which were skipped and why, with no charge for skipped ones | L/S | ❌ | `autoEdit` map in seeded doc (`applied`/`skipped` + reason) | P1 | 4 |
| B22 | Trending in your content | Matches your clips against live Reddit-style trending topics ("12 trending topics, 3h ago, 2.1k upvotes") | S | 🟡 hook mining uses web search | Daily worker job: pull trends per client niche (web_search tool) and match against candidate transcripts; feeds the Trend score | P2 | 9 |

## C. Reframe & layout

| # | Feature | What Opus does | Ev | Toreroflow | How we build it | Pri | Phase |
|---|---|---|---|---|---|---|---|
| C1 | Aspect ratios | Portrait 9:16, square 1:1, 4:5, landscape 16:9; brand kits store all 4 | L | ❌ (9:16 only, letterboxed) | `doc.output.aspect` | P0 | 2 |
| C2 | Shot detection | Scene cuts split the clip into shots (`sceneDetThresh 3`) | L | ❌ | ffmpeg scene filter | P0 | 3 |
| C3 | Face + person detection | Per-shot faces/people with confidence; fake-face filter (posters, screens) | L | ❌ | `/faces` in captions service (MediaPipe) + `isFake` rule | P0 | 3 |
| C4 | Active speaker | `activeness` score per face (mouth motion) | L | ❌ | Mouth-motion variance z-score | P0 | 3 |
| C5 | Fill layout | Static 9:16 crop per shot centered on the active speaker | L | ❌ | `Shot.crops[0]` | P0 | 3 |
| C6 | Split layout | Two face crops stacked when both are on screen and active | L | ❌ | `Shot.crops[0..1]`, `vstack` | P0 | 3 |
| C7 | Fit layout | Whole frame over blurred/colored background; fit crop ratio 4:3 | L | 🟡 letterbox only (black) | blur/color/image background | P0 | 2 |
| C8 | Screenshare layout | Screen on top, face below; needs screenshare content + one speaker | S/C | ❌ | Layout detector (big text/screen region + small face) | P1 | 3 |
| C9 | Three / Four layouts | 3 or 4 people grid | L/S | ❌ | `crops[0..3]` grid | P2 | 3 |
| C10 | Gameplay layout | Gameplay full, facecam in a box | S | ❌ | Facecam corner detection + PiP | P2 | 7 |
| C11 | Mixed / Auto layout | Layout switches per shot automatically | L | ❌ | Per-shot layout pick | P0 | 3 |
| C12 | Moving speaker tracking | Smooth tracking only when the subject moves | C/D | ❌ | `Shot.keys` | P1 | 3 |
| C13 | Manual crop / layout override | Drag crop in preview; pick layout per shot; "Tracker: ON/OFF" | L | 🟡 clipFx x/y/zoom (preview only) | `shotAdjust`; render honors it | P0 | 2 |
| C14 | Layout timeline lane | Labelled blocks (Fill/Split) per shot | L | ❌ | Timeline lane | P1 | 3 |
| C15 | Background options | Blur, color, image, video background, with crop | S | ❌ | Fit layout background settings | P1 | 2 |
| C16 | Rotation / corner radius / spacing | Per-shot adjustments | C | 🟡 rotate exists | Add radius/spacing for split/PiP | P2 | 7 |
| C17 | PiP avatar area | Small face bubble over B-roll/screen | C | ❌ | `pip` layout | P2 | 7 |
| C18 | Safe zone overlay | Shows platform UI zones; "Show platform UI" preview | L/S | ✅ safe-zone toggle | Add per-platform overlays (TikTok/IG/YT) | P2 | 7 |

## D. Captions & transcript

| # | Feature | What Opus does | Ev | Toreroflow | How we build it | Pri | Phase |
|---|---|---|---|---|---|---|---|
| D1 | Word-level transcription | Words + `__silence` tokens; stutters kept | L | ✅ whisper base (no silence tokens) | Better model + silence/filler flags | P0 | 1 |
| D2 | Transcript editor | Edit text, delete words to cut video, restore | L | ✅ WordEditor | Keep | — | — |
| D3 | Word-timed animated captions | Karaoke fill-pop, pop, highlight, etc. driven by real word timing | L | 🟡 7 animations, karaoke timing faked | Per-word ASS events | P0 | 1 |
| D4 | Caption template gallery | ~20 presets (Karaoke, Deep Diver, Mozi, Popline, Think Media…) with preview video | L | ✅ 12 templates | Add preview thumbnails; more presets | P1 | 5 |
| D5 | Keyword highlight | Per-word level 0/1/2 with primary/secondary color; AI-picked | L | ❌ | AI highlight pass | P0 | 5 |
| D6 | AI emojis | Contextual emoji anchored to a word, about 1 per 20 s | L | ❌ | AI emoji pass + ASS/overlay | P1 | 5 |
| D7 | Caption styling | Font, weight, size, color, stroke width, shadow (x/y/blur), uppercase, background box with padding/opacity/radius, line spacing, lines per page (1–3), max width, position (top/middle/bottom/auto) | L/S | ✅ mostly; background box always square, no line spacing | Close the ASS approximations; rounded box via drawing | P1 | 5 |
| D8 | Auto caption placement | Avoids speaker faces | S/C | ❌ | Use shot face boxes | P1 | 5 |
| D9 | Speaker colors | Color captions by speaker (diarization), up to 6 speakers, merge speakers | L/S | ❌ | Diarization (pyannote, P3) or speaker = active face per shot (P1 cheap route) | P1 | 7 |
| D10 | Censor | Curse-word lists, auto-censor captions with dashes, audio bleep or mute | S/C | ❌ | Word library + `volume=0`/sine bleep in render | P1 | 7 |
| D11 | Brand vocabulary | Proper nouns list to fix transcription spelling | S/C | ❌ | Whisper `initial_prompt` + post-replace map per client | P1 | 1 |
| D12 | Transcript search | Find in script, Enter/Shift+Enter | S | ❌ | WordEditor search | P1 | 6 |
| D13 | Filter view | Hide trimmed content / show only kept words | S | 🟡 | Toggle | P2 | 6 |
| D14 | Export SRT / TXT | Subtitles and transcript download | S/C | 🟡 SRT for long-form only | `GET /edit-projects/:id/subtitles.srt|.txt` | P1 | 6 |
| D15 | Regenerate captions | Re-transcribe a clip | C | ❌ | Endpoint re-runs whisper on the clip span | P2 | 6 |
| D16 | Translation | Translate captions into another language | S | ❌ | Claude translation of caption pages, keep timing | P1 | 7 |
| D17 | Custom fonts | Upload brand fonts | S | ❌ | Font upload per client to `assets/fonts/<client>` + fontsdir | P1 | 7 |
| D18 | Add section from transcript | Select words in transcript → extend clip with that section | C | 🟡 restore cuts | Selection → add range | P2 | 6 |

## E. Speech & audio cleanup

| # | Feature | What Opus does | Ev | Toreroflow | How we build it | Pri | Phase |
|---|---|---|---|---|---|---|---|
| E1 | Filler word removal | Detects single and multi-word fillers; filter by phrase; keep/remove each; counts | L | 🟡 5 single words | Multi-word list + panel | P0 | 5 |
| E2 | Pause removal | Remove pauses longer than X s (slider); counts | L | 🟡 fixed 0.6 s | Slider + silence tokens | P0 | 5 |
| E3 | Bad takes / retakes | AI detects restarted sentences, keeps the last good take; "Detect now"; daily quota | S/C | ❌ | Claude pass over sentences | P1 | 5 |
| E4 | Enhance speech | One-click voice clarity + noise removal | S/C | 🟡 Demucs isolation (≤4 min) | Isolation + loudnorm + highpass/deesser chain in ffmpeg; lift 4 min cap via chunking | P1 | 7 |
| E5 | Music library | Licensed music with search, volume, split | S/C | ❌ | Upload your own (exists) + optional free library (P3) | P3 | — |
| E6 | Audio from video link | Import a video's audio as a track | S | ❌ | Upload audio from a video file (extract with ffmpeg); skip links | P2 | 7 |
| E7 | Auto SFX | AI places sound effects synced to captions; prompt-to-SFX generator | S/C | ❌ | Needs an SFX library or generator API | P3 | — |
| E8 | AI voiceover hook | AI-voiced hook line at the start (ElevenLabs-style voices) | S/C | ❌ | Needs a TTS vendor | P3 | — |
| E9 | Voiceover recording | Record over the clip | — | ✅ | Keep | — | — |
| E10 | Waveform | Server-precomputed audio peaks per clip | L | ❌ | Peaks JSON at processing | P1 | 1 |

## F. Visual effects & graphics

| # | Feature | What Opus does | Ev | Toreroflow | How we build it | Pri | Phase |
|---|---|---|---|---|---|---|---|
| F1 | Auto zoom | Keyframed zoom curves (`slow_push`), about 1 per 30 s, face-anchored | L | 🟡 manual center zooms | AI emphasis pass + curves | P0 | 5 |
| F2 | Auto headline (hook) | 5 s white rounded-box headline; top 10 clips | L | ❌ | AI hook pass + text overlay | P0 | 5 |
| F3 | Hook styles | Gallery of hook styles (lead/speech/emphasis elements, highlight color, hide captions while showing) | S | ❌ | Several TextStyle presets for the hook | P1 | 7 |
| F4 | Transitions | ~30: cross fade/zoom/dissolve, blur dissolve, push/slide (4 directions), dip/flash black/white, film burn, glitch zoom…; auto transitions at cuts; duration control | S/C | ❌ | ffmpeg `xfade` between EDL segments; auto = at range joins | P1 | 7 |
| F5 | Text overlays | Free text with presets and categories, animate in/out | S | ✅ TextPanel | Add preset gallery | P2 | 7 |
| F6 | Lower thirds | Name/title/location bars, direction, accent color, image variant | S | ❌ | Templates over text overlays (ASS drawing or PNG generated with @napi-rs/canvas) | P1 | 7 |
| F7 | Motion graphics | Template library (animated text, data, CTAs), auto-placed by AI, person-mask "text behind subject" | S/C | ❌ | Lottie templates rendered server-side to transparent video (lottie + canvas) | P3 | — |
| F8 | Elements | GIFs, stickers, emoji, arrows, progress bar, social icons search | S | 🟡 graphics upload | Bundled sticker pack + progress bar generator (P2); GIF search needs Giphy key (P3) | P2 | 7 |
| F9 | Progress bar | Animated progress bar element | S | ❌ | ffmpeg `drawbox` with width expression | P2 | 7 |
| F10 | Logo / CTA overlay | Image overlay, warns if no transparency, auto-downscale | S | ✅ graphics lane | Add to brand kit | P1 | 6 |
| F11 | Filters / looks | Named looks with intensity | S | 🟡 color sliders | LUT-style presets over eq/curves | P2 | 7 |
| F12 | Auto color correction | Fix brightness/contrast/color per scene; skips HDR | S/C | 🟡 manual color | Per-shot auto levels (ffmpeg `signalstats` → eq) | P2 | 7 |
| F13 | Eye contact correction | AI eye redirection | S/C | ❌ | Heavy ML | Skip | — |
| F14 | Upscale to HD/4K | AI upscaling under 5 min, credits | S/C | ❌ | Real-ESRGAN on GPU only | P3 | — |
| F15 | Intro / outro | Per brand kit | S/C | ❌ | Concat intro/outro assets in render | P1 | 6 |
| F16 | Watermark | Free tier watermark | L | n/a | Skip | Skip | — |

## G. B-roll

| # | Feature | What Opus does | Ev | Toreroflow | How we build it | Pri | Phase |
|---|---|---|---|---|---|---|---|
| G1 | Find B-roll spots | AI plans spots ("12 spots found"), add/replace at the playhead | S/C | ❌ | AI spots pass | P1 | 5 |
| G2 | Stock B-roll | Copyright-free stock search (Pexels-type) | S | ❌ | Pexels API (free key) | P1 | 5 |
| G3 | AI image B-roll | Generated images, 1 credit each | S | ❌ | Image-gen vendor | P3 | — |
| G4 | AI video B-roll | Generated video clips with style/model pick, free regenerations | S/C | ❌ | Video-gen vendor | P3 | — |
| G5 | Your library | Upload media for B-roll, intro, outro | S | ✅ drawers | Keep | — | — |
| G6 | B-roll layouts | B-roll full or split with speaker | C | 🟡 position/scale/shape | Add split-with-speaker preset | P2 | 7 |

## H. Editor UX

| # | Feature | What Opus does | Ev | Toreroflow | How we build it | Pri | Phase |
|---|---|---|---|---|---|---|---|
| H1 | Multi-track timeline | Video/layout, captions, emoji, effects, text, B-roll, audio, SFX, voiceover lanes; thumbnails; waveform | L | ✅ (fewer lanes) | Add Layout/Zoom/Hook/Emoji lanes | P1 | 3/5 |
| H2 | Split / merge / delete | D or Ctrl+B split, M or Ctrl+Shift+B merge, Backspace | S | ✅ split/delete; ❌ merge | Add merge | P2 | 6 |
| H3 | Snap editing | Snap to cuts/playhead, toggle | S | ❌ | Snap points in Timeline drag | P2 | 6 |
| H4 | Keyboard shortcuts panel | Frame step, home/end, fit timeline | S | ✅ KeymapModal | Add missing keys | P2 | 6 |
| H5 | Undo/redo | Snapshot stack | L | ✅ | Keep | — | — |
| H6 | Version history | Named versions, restore, who/when | S | ❌ | EditVersion | P1 | 6 |
| H7 | Comments | Timestamped comments, replies, resolve, filter unresolved, markers on timeline | S | ❌ | `EditComment` model + timeline markers (agency/client review) | P1 | 8 |
| H8 | Unsaved changes guard | "Save changes" button + leave warning | L | ✅ autosave | Keep autosave | — | — |
| H9 | Onboarding tours | Step-by-step guide cards | L | ❌ | Skip or a minimal first-run tip | Skip | — |
| H10 | Preview loop | Loop the start or end of a clip to check the cut | C | ❌ | Loop toggle in PhonePreview | P2 | 6 |
| H11 | In-browser engine | WASM engine with WebCodecs for frame-accurate preview | C | 🟡 `<video>` + CSS | Keep ours; out of scope | Skip | — |

## I. Brand kits & recipes

| # | Feature | What Opus does | Ev | Toreroflow | How we build it | Pri | Phase |
|---|---|---|---|---|---|---|---|
| I1 | Brand kit | Fonts, caption style, highlight colors, logo, intro/outro, layouts, headline style; **one kit stores all 4 aspect ratios separately** | L/S | 🟡 caption templates (localStorage) | `Recipe.settings.brand` with per-aspect blocks | P0 | 6 |
| I2 | Recipes | Saved pipeline presets (clip settings + AI tools + brand kit); set default; "Applied to top N clips" options | L/S | ❌ | `Recipe` model | P0 | 6 |
| I3 | Template versions | Version history on brand templates, restore | S/C | ❌ | Reuse EditVersion pattern | P2 | 6 |
| I4 | Per-feature scope | Apply headline/hook/B-roll to top N clips only | L/S | ❌ | `topN` per tool in Recipe | P1 | 6 |

## J. Export, publish, distribution

| # | Feature | What Opus does | Ev | Toreroflow | How we build it | Pri | Phase |
|---|---|---|---|---|---|---|---|
| J1 | Render & download | Server render; HD and 4K; original-quality download | L/C | ✅ 720–1440 | Add 2160 when source allows | P1 | 6 |
| J2 | Bulk select & download | Select many → download/schedule | L | ❌ | Batch render + zip | P0 | 6 |
| J3 | Premiere / XML export | Export Adobe XML of the cut | C/S | ❌ | FCPXML/Premiere XML from EDL (pure text) | P2 | 8 |
| J4 | Publish & schedule | TikTok (incl. draft/inbox), YouTube, IG, FB, LinkedIn, X, Bluesky; per-post thumbnail; timezone; "every N hours" bulk schedule | S/C | ✅ via Zernio (no Bluesky) | Bulk schedule with interval from the clip list → Uploads | P0 | 6 |
| J5 | Social copy | AI caption/title/hashtags per post | L/C | ✅ | Prefill from candidate | — | 6 |
| J6 | Custom thumbnail | Pick or upload cover per post | S | ✅ CoverModal | Keep | — | — |
| J7 | Calendar | Auto-post calendar view | C | ✅ scheduling | Keep | — | — |
| J8 | Analytics | YouTube/TikTok account analytics + "posted through app" video stats | S | ✅ Reports | Add per-clip performance back onto ClipCandidate (feeds the score loop) | P1 | 8 |
| J9 | Share link | Public project/clip share for review | S/C | ❌ | Signed read-only review page (pairs with H7) | P1 | 8 |
| J10 | Dubbing | Translate speech in your own voice, 20+ languages | S/C | ❌ | Voice-clone vendor | P3 | — |

## K. Workspace & team

| # | Feature | What Opus does | Ev | Toreroflow | How we build it | Pri | Phase |
|---|---|---|---|---|---|---|---|
| K1 | Collections | Folders for clips/projects; favorites | S/C | ❌ | `Collection` model per client | P2 | 8 |
| K2 | Team activity | Who favorited/exported/scheduled/posted which clip | S | 🟡 activity exists elsewhere? | Activity rows on clip actions | P2 | 8 |
| K3 | Members & roles | Org members, roles, project visibility (private/public) | S/C | ✅ agency/clients | Keep | — | — |
| K4 | Campaigns (clipper marketplace) | Brands post source videos; clippers join, submit clips for review | S/C | ❌ | Agency-to-client review flow could reuse this idea; full marketplace out of scope | Skip | — |
| K5 | Public API + webhooks | API key, create-project API, webhooks with signatures | D/S | ✅ bot tokens | Whitelist clip-job routes for bot tokens | P2 | 8 |
| K6 | MCP / agent approvals | AI agents request actions; the user approves | S | ✅ bot tokens | Out of scope | Skip | — |

## L. Not worth copying

Billing/credits/coupons/wallet, trial upsells, NPS and result surveys (keep only like/dislike reasons), ad pixels, cookie banners, Agent Opus, mini apps, "Script to video", "AI Producer", Viral Presets admin (an internal style-prompt editor), free SEO tools (`/tools/*` title/hashtag/bio generators and file converters), referral/affiliate, Discord tips.

---

## New phases for the master prompt (after phase 6)

- **Phase 7: Polish & effects.** Transitions (F4) + auto transitions at range joins; lower thirds (F6); hook styles (F3); caption translation (D16); censor + bleep (D10); custom fonts (D17); speaker colors via active face (D9); enhance speech chain (E4); audio from video file (E6); auto color (F12); looks (F11); progress bar + bundled stickers (F8, F9); gameplay and PiP layouts (C10, C17); per-platform safe zones (C18); radius/spacing (C16); B-roll split preset (G6).
- **Phase 8: Collaboration & distribution.** Comments + review share link (H7, J9); collections + favorites (K1); team activity (K2); per-clip performance analytics back onto candidates (J8); auto-import from your YouTube channel (A11, A3); Google Drive import (A4); Premiere XML export (J3); cross-project clip search (B15); bot-token access to clip jobs (K5).
- **Phase 9: Smarter AI.** Multimodal curation with frames (B10); trending topics matched to clips (B22); a judge-tuning loop from likes/dislikes + real performance (B16 + J8).
- **Vendor-gated (P3, only with a paid API key):** AI voiceover hook (E8), auto SFX (E7), music library (E5), AI image/video B-roll (G3, G4), motion graphics (F7), upscale (F14), dubbing (J10), GIF search (F8).

## Count

135 features total.

| Priority | Features |
|---|---|
| P0 | 32 (B15 is P0 in-job, P2 cross-project) |
| P1 | 45 |
| P2 | 34 |
| P3 (vendor-gated) | 8 |
| Already have, keep as is (—) | 10 |
| Skip | 6 (plus everything in section L) |
