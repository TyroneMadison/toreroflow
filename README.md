# Toreroflow

Social media command center for the Torerone agency: a desktop app (Tauri + React)
backed by a cloud API that captions, formats, schedules, auto-posts, and reports on
short-form video across Instagram, TikTok, YouTube, and Snapchat for many client accounts.

The build follows `07-24-2026-toreroflow-build-spec.md`. Visual source of truth:
`design/toreroflow-liquid-glass-v4.html`.

## Layout

```
apps/
  desktop/    Tauri v2 + React client
  api/        Fastify API (health + operator auth in M0)
  worker/     BullMQ workers (M3+)
  captions/   Python faster-whisper microservice (M2+)
packages/
  db/         Prisma schema + client + migrations
  core/       shared types, zod schemas, design tokens
  publishers/ publishing adapter interface + dry-run provider
  media/      ffmpeg helpers (M2+)
infra/        docker-compose for dev Postgres + Redis
design/       liquid-glass prototype (source of truth)
```

## Dev quickstart

Prereqs: Node 20+, pnpm, Docker Desktop, Rust toolchain (for the desktop shell).

```
pnpm install
copy .env.example .env        # then fill in secrets
pnpm infra:up                 # Postgres + Redis
pnpm db:migrate               # first migration
pnpm dev:api                  # API on :4700
pnpm --filter @toreroflow/desktop tauri dev   # desktop app
```
