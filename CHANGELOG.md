# Changelog

All notable changes to Toreroflow are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Until v1.0, minor versions map to the build-spec milestones (spec §12):
`0.1 = M0`, `0.2 = M1`, … `0.7 = M6`. Every milestone lands as one tagged
release with its acceptance checks listed.

## [Unreleased]

### Added - best times to post

- The Upload screen's timing card now shows the hours that actually perform best for the selected brand, per platform, measured from its own published history rather than a generic recommendation
- Ranked bars of average views per hour, in your local time zone, with the number of posts behind each row so a lucky single post is not mistaken for a pattern. Rows with a thin sample are faded and flagged

### Added - reschedule and remove from the queue

- Each row in "Up next in queue" gets two controls: change the day and time, or remove that post from the queue
- Scheduled posts opened from the calendar can also be removed, with a confirm step
- Removal is per platform: pulling a video from Instagram leaves its YouTube slot alone, and the post disappears only once its last platform is gone. Already-published posts cannot be removed

### Fixed - broken emoji in saved captions

- Captions written before emoji decoding landed rendered escape text like `🚗`. They now display correctly, and half-emoji left behind by truncated model output are dropped instead of showing as broken glyphs

### Added - post details from the calendar

- Click any post in day, week, or month view for a quick overview: thumbnail, platform, status, caption, and publish time
- Scheduled posts can have their day and time edited right there with the glass picker, and the calendar updates immediately. Published and in-flight posts are read-only

### Changed

- Dashboard range selector drops the 180-day option, leaving 30, 60, and 90 days

### Fixed - drag and drop

- Dropping a video onto the Upload screen now works in the desktop app. Tauri was intercepting OS file drops itself and suppressing the page's own drop events, so the feature only ever worked in the browser
- Queue items can be dragged onto one another to swap their scheduled times; the delayed publish jobs move with them
- Month view posts can finally be dragged. The month cells accepted drops but the posts inside them were never drag sources, so rescheduling by drag only ever worked in week view
- Day view now accepts drops as well, and dropping a post back on its own day no longer makes a pointless round trip
- Already-published posts stay locked in place across every view

### Removed - videos are no longer re-encoded

- Burned-in captions and the automatic 9:16 reframe are gone. Videos publish exactly as exported, with no re-encode, no crop, and no second file on disk
- Processing is much faster as a result (the re-encode was nearly all of it) and quality is untouched, since nothing is transcoded
- Transcription stays: it is what feeds the AI title and description
- Preview and publishing both use the original upload
- ffmpeg is retained for probing and thumbnails

### Changed - video title replaces the AI hook

- The AI "hook" is gone. Videos now have an editable **Title**, pre-filled by AI from the transcript, which posts verbatim as the YouTube title and as the Instagram and TikTok caption
- The old caption field is now **Description**, drafted from the transcript
- Copy drafted before this change still displays: the old hook maps to Title and the old caption to Description on read, no data migration needed
- Fixed emoji arriving as literal escape text (`😈` instead of the character) in AI-drafted copy, both for new drafts and existing ones

### Added - glass date and time picker

- The schedule dialog uses a custom liquid-glass date and time picker instead of the browser's native popup, which could not be themed. Translucent panel, month navigation, hour/minute/AM-PM columns, past dates disabled, and it opens upward when there is no room below

### Added - quick wins from the improvement backlog

- Refresh button on Analytics: pulls the newest uploads and view counts from every platform on demand instead of waiting for the daily job
- Videos-uploaded counters for the last 30, 60, and 90 days, across all connected platforms
- "Post now" button in the schedule dialog, with a confirm step since publishing is irreversible
- Modal backdrop is far darker and more blurred, so dialogs no longer blend into the page behind them
- The "Active brand" pill in the sidebar shows the brand's real profile picture

### Added - Analytics command center redesign

- Brand dropdown in the Analytics topbar (with "+ Enroll a client"), so a brand can be picked right on the page instead of only from the sidebar
- New three-column analytics layout in the app's liquid glass style: KPI tiles (views, watch-time hours, YouTube subscribers, non-YouTube followers), per-video views chart colored by platform, circular color-coded views-share pie, and the brand's profile picture card top right
- Last 10 uploads table: thumbnail, title, upload date, platform, views, average view duration, and video length per row
- Recent followers panel (every platform except YouTube) and recent subscribers panel (YouTube), each showing current counts and the 30-day change
- Most viewed videos list plus view-milestone rankings: top 10 videos at 1M+, 100K to 999K, and 10K to 99K views, all pulled across every platform connected under the brand (new platforms join automatically)
- New API endpoint `GET /clients/:id/analytics/posts`: live provider post analytics (titles, thumbnails, publish dates, metrics) scoped to the client's profile, briefly cached; video length backfills from our own media when the post was produced in Toreroflow

### Fixed - screen scrolling and Accounts avatars

- Screens scroll properly: the content area below the top bar is now a real scroll container, so tall pages (like Settings with an expanded profile card) reach the bottom instead of clipping at the window edge
- Accounts page brand cards show the client's real profile picture (Instagram first, then any connected platform), matching Dashboard and Settings; letter initials remain the fallback until a platform is connected

### Added - live account data, profile cards, Facebook

- Facebook added as a full platform across connect, workflows, scheduling, and calendar
- Fixed provider account sync (Zernio returns profile ids as objects); connected platforms now show correctly everywhere, with auto-sync when Settings opens
- Accounts import their real profile picture, display name, and follower count; avatars show on Dashboard and Settings cards
- Instant history backfill: connecting an account immediately ingests the provider's existing post history (paginated) into daily metrics, so 30/60/90/180-day analytics appear right away
- Dashboard range selector (30/60/90/180 days) with real windowed views, retention, likes, and comments
- Profile cards in Settings > Connected Accounts: avatar, verified badge, animated Expand with a 30-day overview (followers, views, likes, comments, engagement, retention), per-card style toggle between tile and full-bleed cover layouts, and inline connect/disconnect
- Workflow source platform now highlighted green with a SOURCE tag
- Instagram watch time normalized from milliseconds to seconds

### Added - calendar polish and analytics

- Drag-to-reschedule: drag any scheduled post to another day in the week or month view; the delayed publish job moves with it
- Daily analytics ingestion: a scheduled worker job pulls provider metrics per connected account into snapshots (plus per-post likes/comments/shares) with same-day dedupe
- Analytics screen renders real charts from snapshots: views-over-time trend, platform mix donut, reach bars, engagement summary
- Dashboard cards show live views, retention (avg watch), likes, and comments per brand
- Branded PDF report export: one click builds a logo-headed report with KPI cards and a per-platform table, then opens it

### Added - scheduling and publishing

- Schedule button on processed videos: pick connected platforms and a time; one post fans out to a target per platform
- Delayed publish jobs with automatic retries (3 attempts, exponential backoff) and failure surfacing
- Publishing through Zernio for real connected accounts (presigned media upload + post creation); dry-run accounts log instead of posting
- Content Calendar shows the real week: platform color-coded events with status (publishing, posted, failed with error on hover)
- Up next in queue lists upcoming scheduled posts live
- Verified: a post scheduled 90 seconds out published 0.3 seconds after its target time

### Added - media pipeline

- Real uploads to local storage with a BullMQ job queue and worker service
- Local transcription (faster-whisper) with Bold pop captions burned into a 1080x1920 vertical render, plus thumbnails
- AI post copy per upload (hook, caption, hashtags) with in-app caption editing
- Upload screen shows live processing status and plays the captioned render

### Added - clients and connections

- Zernio publishing provider: one provider profile per client, hosted OAuth connect opened in the system browser, account sync back into the app
- Dashboard screen (default landing): per-brand quick stats with click-through to full analytics
- Opaque brand dropdown menu, green On/Off autostart toggle, milestone labels removed from all copy

### Added - M1 foundation

- Operator auth in the app: first-run register / login gate with JWT sessions
- Real client (brand) management end-to-end: enroll, list, delete - demo data removed from every screen
- Sidebar brand dropdown: empty until a brand is added, per-brand selection drives the whole app
- Settings screen: **Run upon startup** (Tauri autostart) and **Connected Accounts** with per-platform connect/disconnect per client (dry-run provider until the real provider is chosen)
- Workflows: repurpose-style fan-out rules (source platform → destinations) with enable/pause/delete; rules execute when M3 publishing lands
- Upload: real drag & drop, thumbnails extracted from the dropped video, click-to-preview player, platform toggles bound to connected accounts
- Per-client analytics modal with AI growth suggestions (Claude-powered; needs `ANTHROPIC_API_KEY`)
- API: client/account/workflow routes, `GET /clients/:id/analytics`, `POST /clients/:id/suggestions`, `GET /auth/bootstrap`

### Still open for M1

- Publishing provider decision (Ayrshare / Blotato / Zernio / self-hosted Postiz - Snapchat coverage and per-account pricing decide it) → real OAuth replaces dry-run connections

---

## [0.1.0] - 2026-07-24 · M0 "Scaffold & shell"

### Added

- **Monorepo** (pnpm workspaces): `apps/desktop`, `apps/api`, `apps/worker`, `apps/captions`, `packages/db`, `packages/core`, `packages/publishers`, `packages/media` (spec §6)
- **Database**: full Prisma schema for all 12 entities - Agency, User, Client, SocialAccount, MediaAsset, Render, Post, PostTarget, ScheduleSlot, MetricSnapshot, PostMetric, Job - with `init` migration applied to PostgreSQL (spec §7)
- **API** (Fastify 5): `GET /health`, first-run operator auth - `POST /auth/register` (locks after the first operator), `POST /auth/login`, `GET /auth/me` - bcrypt password hashing, JWT sessions, zod validation
- **Desktop app** (Tauri v2 + React 18 + Vite): faithful port of the liquid-glass prototype - Upload & Schedule, Content Calendar, Client Analytics, and Accounts screens plus the Add Client and Post Composer modals, dark/light themes, and a live API health indicator in the sidebar
- **Publishing adapter** interface with a dry-run provider, so the entire pipeline can run without touching live accounts (spec §8)
- **Media profiles**: per-platform 9:16 encode profile table, ready for the M2 ffmpeg pipeline (spec §9)
- **Dev infra**: Docker Compose for Postgres 16 + Redis 7, `.env.example`, brand icon set generated from the violet→blue thumbs-up tile

### Fixed

- Vite dev-server crash on Windows (`EBUSY` watching cargo's locked build artifacts) - `src-tauri/**` excluded from the file watcher

### Acceptance

- App launches on Windows as a native Tauri window
- All four screens navigate with working modals, theme toggle, and prototype-identical styling
- Sidebar health pill polls the live API (`API online`)
- Auth verified end-to-end: register → login → me, duplicate register 409, bad credentials/token 401

[Unreleased]: https://github.com/TyroneMadison/toreroflow/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/TyroneMadison/toreroflow/releases/tag/v0.1.0
