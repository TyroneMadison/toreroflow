# Changelog

All notable changes to Toreroflow are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Until v1.0, minor versions map to the build-spec milestones (spec §12):
`0.1 = M0`, `0.2 = M1`, … `0.7 = M6`. Every milestone lands as one tagged
release with its acceptance checks listed.

## [Unreleased]

### Up next — M1 · Clients & connections

- Client CRUD wired from the Add Client modal to the API
- Publishing provider integration (evaluating Ayrshare / Blotato / Zernio / self-hosted Postiz — Snapchat coverage and per-account pricing decide it)
- Per-platform OAuth connect flow with encrypted token storage
- Connection health states (connected / needs reconnect / error) live in the Accounts screen

---

## [0.1.0] — 2026-07-24 · M0 "Scaffold & shell"

### Added

- **Monorepo** (pnpm workspaces): `apps/desktop`, `apps/api`, `apps/worker`, `apps/captions`, `packages/db`, `packages/core`, `packages/publishers`, `packages/media` (spec §6)
- **Database**: full Prisma schema for all 12 entities — Agency, User, Client, SocialAccount, MediaAsset, Render, Post, PostTarget, ScheduleSlot, MetricSnapshot, PostMetric, Job — with `init` migration applied to PostgreSQL (spec §7)
- **API** (Fastify 5): `GET /health`, first-run operator auth — `POST /auth/register` (locks after the first operator), `POST /auth/login`, `GET /auth/me` — bcrypt password hashing, JWT sessions, zod validation
- **Desktop app** (Tauri v2 + React 18 + Vite): faithful port of the liquid-glass prototype — Upload & Schedule, Content Calendar, Client Analytics, and Accounts screens plus the Add Client and Post Composer modals, dark/light themes, and a live API health indicator in the sidebar
- **Publishing adapter** interface with a dry-run provider, so the entire pipeline can run without touching live accounts (spec §8)
- **Media profiles**: per-platform 9:16 encode profile table, ready for the M2 ffmpeg pipeline (spec §9)
- **Dev infra**: Docker Compose for Postgres 16 + Redis 7, `.env.example`, brand icon set generated from the violet→blue thumbs-up tile

### Fixed

- Vite dev-server crash on Windows (`EBUSY` watching cargo's locked build artifacts) — `src-tauri/**` excluded from the file watcher

### Acceptance

- App launches on Windows as a native Tauri window
- All four screens navigate with working modals, theme toggle, and prototype-identical styling
- Sidebar health pill polls the live API (`API online`)
- Auth verified end-to-end: register → login → me, duplicate register 409, bad credentials/token 401

[Unreleased]: https://github.com/TyroneMadison/toreroflow/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/TyroneMadison/toreroflow/releases/tag/v0.1.0
