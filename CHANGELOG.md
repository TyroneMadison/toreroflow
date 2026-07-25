# Changelog

All notable changes to Toreroflow are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Until v1.0, minor versions map to the build-spec milestones (spec §12):
`0.1 = M0`, `0.2 = M1`, … `0.7 = M6`. Every milestone lands as one tagged
release with its acceptance checks listed.

## [Unreleased]

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
