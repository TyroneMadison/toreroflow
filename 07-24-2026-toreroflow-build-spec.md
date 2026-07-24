# Toreroflow: Build Specification

A complete, buildable technical plan for Toreroflow, a downloadable desktop app that ingests videos, auto captions and formats them, schedules and auto posts them to Instagram, TikTok, YouTube, and Snapchat across many client accounts, and aggregates all the analytics into client ready reports.

Version 1.0 · Prepared for Claude Code · Brand: Torerone

---

## 0. For Claude Code: how to use this document

You are building the product described below. Work in the milestone order in Section 12. At the start, do these things:

1. Read this whole file before writing any code.
2. Scaffold the monorepo in Section 6 first, then build milestone by milestone.
3. After each milestone, run the acceptance checks listed for it, then stop and summarize what you built and what is next.
4. The visual design is already done. The file `toreroflow-liquid-glass-v4.html` is the design source of truth. Port its layout, components, and design tokens (Section 11) into the real frontend. Match it closely.
5. Do not invent platform credentials or post to live accounts during development. Use the sandbox and dry run modes described in Section 8.
6. When a decision in Section 14 (Open Decisions) is unresolved, pick the recommended default, note the assumption in code comments, and keep moving.

Guiding principle: the desktop app is the control room, and a small always on cloud backend is the engine that actually posts on schedule and pulls analytics. Build both.

---

## 1. Product overview

Toreroflow is a social media command center for a content agency. The operator (Torerone) manages many client accounts. For each client the operator drops in a video, and Toreroflow captions it, reframes it per platform, schedules it days ahead, and posts it automatically to that client's connected Instagram, TikTok, YouTube, and Snapchat profiles. A dashboard rolls up every account's metrics into a report the operator can show clients.

Primary users:
- Operator / admin: the agency owner, connects clients, uploads content, sets schedules, reads analytics.
- Client viewer (later, optional): a read only shared report link.

Non goals for v1: a paid multi tenant SaaS with billing, a mobile app, AI video editing. Design the data model so these are possible later, but do not build them now.

---

## 2. Core features (v1 scope)

1. Multi account management. Create clients, connect their four platforms, group profiles under a client, show connection health.
2. Video intake. Drag and drop one or many videos into the app, with a local media library.
3. Auto captioning. Transcribe audio, generate styled captions, burn them into the video or attach a caption track.
4. Auto formatting. Reframe and transcode to each platform's spec (vertical 9:16, resolution, duration, bitrate).
5. AI caption and hook text. Generate the post caption, hook, and hashtags per platform using Claude, with human approval before posting.
6. Scheduling. A calendar and queue to place posts days in advance, per client and per platform.
7. Auto publishing. At the scheduled time the cloud backend posts to each selected platform.
8. Best time suggestions. Compute each account's best posting windows from its own history and audience activity.
9. Analytics. Pull views, reach, watch time, followers, and engagement per account, store snapshots, and render per client dashboards and exportable reports.

The four primary screens plus two modals already exist in the prototype: Upload and Schedule, Content Calendar, Client Analytics, Accounts, plus the Add Client connect modal and the Post Composer modal.

---

## 3. Architecture overview

Three layers:

```
 Desktop app (Tauri + React)            Cloud backend (API + workers)             External
 ---------------------------            -----------------------------             --------
 - Drag drop intake                     - REST/tRPC API                           - Publishing provider
 - Composer, calendar, dashboards  <->  - Auth + client/account store       <->   - Whisper/Deepgram (captions)
 - Local media cache                    - Media pipeline workers                  - Object storage (R2/S3)
 - Talks to backend over HTTPS          - Scheduler + publish workers             - Platform analytics
                                        - Analytics ingestion jobs
                                        - Postgres + Redis
```

Why a cloud backend and not a pure desktop app: a desktop app that is closed or asleep cannot fire a post at 6:40 PM. All scheduled posting, retries, and analytics pulls must run on an always on server. The desktop app is a thin, beautiful client over that backend. For a solo operator this backend can be a single small server plus managed Postgres, Redis, and object storage.

Publishing is behind an adapter interface (Section 8) so the engine underneath can be a unified provider first and direct platform integrations later, without changing the rest of the app.

---

## 4. Recommended tech stack

Pick these defaults unless Section 14 says otherwise.

Desktop shell: Tauri v2 (Rust core, web frontend). Lighter and more secure than Electron, produces small signed installers for Windows (.msi/.exe) and macOS (.dmg), has an auto updater, native drag and drop, and deep link handling for OAuth callbacks. If a required capability is missing, Electron is the fallback, but start with Tauri.

Frontend: React + TypeScript + Vite. Port the prototype's CSS and design tokens directly (the liquid glass look is plain CSS with backdrop-filter, so it moves over cleanly). State and data with Zustand plus TanStack Query. Charts with a lightweight lib (uPlot or Recharts) styled to the tokens.

Backend: Node.js + TypeScript with Fastify (or NestJS if you prefer structure). One language across the stack.

Database: PostgreSQL with Prisma ORM.

Queue and scheduler: BullMQ on Redis for delayed jobs, retries with backoff, and idempotency. A single delayed job per scheduled post is the core primitive.

Object storage: Cloudflare R2 or AWS S3 for source and rendered video.

Media: FFmpeg via fluent-ffmpeg for reframe and transcode. Captioning via a Python microservice running faster-whisper for local transcription, or Deepgram/AssemblyAI as a hosted option. Caption burn in via FFmpeg with ASS subtitle styling for v1; upgrade to Remotion for fully animated word by word captions later.

Publishing: a unified social posting provider behind an adapter (Section 8).

Auth: the operator logs into the app (email plus password or a device token). Per social account OAuth is handled through the publishing provider. Encrypt all tokens at rest.

Hosting: backend on Fly.io, Render, or Railway. Managed Postgres and Redis. R2 for storage.

---

## 5. High level user flows

Connect a client:
1. Operator clicks Add client, names it, clicks Connect on each platform.
2. The connect action opens the provider's OAuth flow for that platform in the system browser and returns via a deep link back into the app.
3. Tokens are stored server side against a SocialAccount row. Health shows connected or needs reconnect.

Upload and schedule:
1. Operator drops a video. It uploads to object storage and a MediaAsset row is created.
2. A pipeline job transcribes, generates caption text with Claude, reframes to 9:16, and renders a captioned preview.
3. Operator opens the composer, edits per platform captions, picks a caption style, picks platforms and a time (best time or custom), and clicks Schedule.
4. One Post row plus one PostTarget row per platform is created, and a delayed BullMQ job is enqueued for each target at its scheduled time.

Publish:
1. At the scheduled time the publish worker loads the PostTarget, calls the publishing adapter for that platform, and records the returned remote id and status.
2. On failure it retries with backoff and surfaces the error on the calendar.

Analytics:
1. A scheduled job pulls metrics per account daily and writes MetricSnapshot rows.
2. The dashboard aggregates snapshots per client and renders KPIs, trends, platform mix, and top posts, exportable as a branded PDF or a shareable link.

---

## 6. Repository structure

A pnpm monorepo:

```
toreroflow/
  apps/
    desktop/            Tauri + React client (ports the prototype)
    api/                Fastify API + auth + REST/tRPC
    worker/             BullMQ workers: media, publish, analytics
    captions/           Python faster-whisper microservice (FastAPI)
  packages/
    db/                 Prisma schema + client + migrations
    core/               shared types, zod schemas, design tokens
    publishers/         adapter interface + provider implementations
    media/              ffmpeg reframe/transcode + caption burn-in helpers
  infra/                deploy config (fly/render), env samples
  design/               toreroflow-liquid-glass-v4.html (source of truth)
  README.md
```

---

## 7. Data model

Prisma style entities. Add timestamps and soft delete where sensible.

```
Agency        id, name, ownerEmail, createdAt
User          id, agencyId, email, passwordHash, role (owner|viewer)
Client        id, agencyId, name, avatarSeed, plan, createdAt
SocialAccount id, clientId, platform (instagram|tiktok|youtube|snapchat),
              handle, providerAccountId, status (connected|needs_reconnect|error),
              tokensEncrypted, scopes, connectedAt
MediaAsset    id, clientId, storageKey, originalName, durationSec, width, height,
              status (uploaded|processing|ready|failed), transcript, createdAt
Render        id, mediaAssetId, platform, aspect, storageKey, captionStyle, status
Post          id, clientId, mediaAssetId, createdBy, status (draft|scheduled|publishing|posted|failed)
PostTarget    id, postId, socialAccountId, platform, caption, hashtags[],
              scheduledAt, status (scheduled|publishing|posted|failed),
              remotePostId, remoteUrl, error, publishedAt
ScheduleSlot  id, clientId, platform, dayOfWeek, hourLocal, source (best_time|manual)
MetricSnapshot id, socialAccountId, capturedAt, views, reach, followers,
              engagementRate, avgWatchSec, raw JSON
PostMetric    id, postTargetId, capturedAt, views, likes, comments, shares, saves
Job           id, type, refId, status, attempts, lastError (mirror of queue state for UI)
```

Key rules: tokens are always encrypted with a KMS key or libsodium sealed box, never stored plaintext. A Post fans out to one PostTarget per selected platform, each independently schedulable and retryable.

---

## 8. Publishing path (the part people underestimate)

Two paths. Build Path A first behind an adapter, so Path B can replace individual platforms later with zero changes elsewhere.

Path A, unified provider (recommended for v1). One integration posts to Instagram, TikTok, YouTube, and Snapchat, including Snapchat Stories and Spotlight, with scheduling and analytics. This absorbs the per platform OAuth, review, and formatting mess and is the fastest route to a working product. Evaluate Ayrshare, Blotato, and Zernio as hosted options, and Postiz as an open source self host option. Choose based on confirmed Snapchat support, per account pricing, and analytics coverage. Cost is a monthly or per account fee.

Path B, direct integrations (later, for margin at scale). Register your own developer apps and post through each platform's official API. More control and lower per post cost, but each platform needs its own review and approval, and that paperwork, not the code, is the real timeline.

Per platform reality to bake into the adapter and the UI:

- YouTube: official Data API v3 upload. Default quota is 10,000 units per day per project and a video upload costs about 1,600 units, so plan for roughly a handful of uploads per project per day and request a quota increase for scale. OAuth with the YouTube upload scope.
- Instagram: official Content Publishing via the Graph API, business or creator accounts only, connected to a Facebook Page. Two step container then publish flow. There is a limit of about 25 API published posts per account per 24 hours. Reels, images, and carousels are supported. Requires Meta app review.
- TikTok: official Content Posting API with Direct Post. Until your app passes TikTok's audit, posts are restricted to private or self only visibility, so public auto posting requires completing the audit. Plan the UI to show this state.
- Snapchat: there is no simple official public API for organic posting. Reaching Snapchat Stories and Spotlight in practice goes through the unified providers above, which is the main reason Path A is attractive when Snapchat is required.

Adapter interface (all providers and direct integrations implement this):

```ts
interface Publisher {
  platform: Platform;
  connectUrl(clientId: string): Promise<string>;        // returns OAuth URL
  handleCallback(params: CallbackParams): Promise<SocialAccountInit>;
  publish(input: {
    account: SocialAccount;
    videoUrl: string;
    caption: string;
    hashtags: string[];
    scheduledAt?: Date;                                  // provider side schedule if supported
  }): Promise<{ remotePostId: string; remoteUrl?: string }>;
  fetchAccountMetrics(account: SocialAccount, since: Date): Promise<MetricSnapshotInput>;
  fetchPostMetrics(remotePostId: string): Promise<PostMetricInput>;
}
```

Always support a dry run mode where publish logs the payload and returns a fake remote id, so the whole pipeline can be tested without touching live accounts.

---

## 9. Media pipeline

Steps, each a BullMQ job so they retry independently:

1. Ingest. Upload the source to object storage, probe with ffprobe for duration and dimensions, create the MediaAsset.
2. Transcribe. Send audio to the captions microservice (faster-whisper) to get a timestamped transcript. Store it on the MediaAsset.
3. Generate text. Call Claude with the transcript to draft a caption, a hook, and hashtags per platform. Store as draft on the composer, never auto post without approval.
4. Reframe and transcode. With FFmpeg, produce a 9:16 render per target platform at the correct resolution, duration cap, and bitrate. Snapchat, TikTok, Reels, and Shorts each have their own limits; encode a per platform profile table.
5. Caption render. Burn styled captions using an ASS subtitle track generated from the transcript timing. Support a few named styles (Bold pop, Karaoke, Minimal, Neon) mapped to ASS style presets. Store each Render.
6. Thumbnail. Extract a poster frame.

Keep source and renders in object storage keyed by client and asset. Cache the most recent renders locally in the desktop app for fast preview.

---

## 10. Scheduling engine

- Each PostTarget with a scheduledAt enqueues one delayed BullMQ job at that time.
- The worker is idempotent: it checks the target is still scheduled before publishing, and uses the remotePostId to avoid double posting on retry.
- Retries use exponential backoff, a max attempt count, and then mark the target failed and surface it on the calendar with the error.
- Store times in UTC, render in the client's local timezone. The calendar and composer work in local time.
- A reschedule updates scheduledAt and replaces the delayed job.

---

## 11. Best time engine

Compute each account's best posting windows rather than guessing:
- Pull audience active times where the platform or provider exposes them (Instagram follower activity by hour, YouTube when your viewers are on YouTube, TikTok follower activity).
- Combine with the account's own past post performance by hour and weekday from PostMetric and MetricSnapshot history.
- Output a small set of ScheduleSlot rows per client and platform, refreshed weekly, and surface the top windows in the composer's Best time option and the Smart timing panel.

Cold start: before there is history, fall back to sensible category defaults, and clearly label them as estimates until real data exists.

---

## 12. Milestone build plan

Build in this order. Each milestone ends with a working, testable slice.

M0: Scaffold and shell
- Create the monorepo, Prisma schema, and migrations.
- Stand up the Fastify API with health check and operator auth.
- Boot the Tauri + React desktop app and port the prototype's four screens and two modals as static UI wired to design tokens.
- Acceptance: app launches on Win and Mac, shows the four screens with real navigation, talks to a live API health endpoint.

M1: Clients and connections
- Client CRUD. Add client modal creates a Client.
- Integrate the chosen publishing provider. Connect flow completes OAuth per platform and stores an encrypted SocialAccount. Health states render.
- Acceptance: create a client, connect at least one real sandbox account, see it as connected in Accounts.

M2: Upload and media pipeline
- Drag and drop upload to storage, MediaAsset creation, ffprobe.
- Captions microservice transcribes. Claude drafts caption text.
- FFmpeg reframes to 9:16 and burns one caption style. Preview renders in the composer.
- Acceptance: drop a video, see a captioned 9:16 preview and an editable AI caption within the composer.

M3: Scheduling and publishing
- Composer creates a Post and PostTargets, enqueues delayed jobs.
- Publish worker posts via the adapter in dry run, then against a sandbox for one platform, then all four.
- Retry and failure surfacing.
- Acceptance: schedule a post for two minutes out and watch it publish to a sandbox account, with status updating to posted.

M4: Calendar
- Week and month calendar reads PostTargets, color coded by platform, filterable by client and platform. Drag to reschedule.
- Acceptance: scheduled posts appear on the calendar and can be moved, which reschedules the job.

M5: Analytics
- Daily ingestion jobs write MetricSnapshot and PostMetric rows.
- Dashboard aggregates per client: KPIs, views over time, platform mix, top posts.
- Export a branded PDF and a shareable read only link.
- Acceptance: dashboard shows real pulled numbers for a connected account and exports a report.

M6: Package and polish
- Auto update, code signing, installers for Win and Mac.
- Light and dark theme parity, empty and loading states, error toasts.
- Acceptance: a signed installer updates itself and matches the prototype in both themes.

---

## 13. Design tokens (match the prototype)

Dark theme (default):

```
bg base       #030208
bg raised     #080611
glass fill    rgba(255,255,255,0.05)
glass border  rgba(255,255,255,0.12)
text          rgba(255,255,255,0.94) / 0.58 / 0.36
accent violet #8b7bff
accent blue   #4ea8ff
accent grad   linear-gradient(135deg,#8b7bff,#4ea8ff)
success       #57d6a0
warning       #ffcf6b
danger        #ff6b7a
radius        26 (cards) / 16 (inputs) / 13 (chips)
blur          backdrop-filter blur(38px) saturate(150%)
font          -apple-system, SF Pro Display, system-ui, Segoe UI, Roboto
```

Light theme:

```
bg base       #e8eaf4
glass fill    rgba(255,255,255,0.6)
text          rgba(24,26,45,0.94) / 0.62 / 0.42
(accents unchanged)
```

Platform brand colors for chips: Instagram gradient (#feda75 to #d62976 to #7a34c9), TikTok cyan and pink on near black (#25f4ee, #fe2c55), YouTube red (#ff4237), Snapchat yellow (#ffe600). Platform icons render on frosted glass tiles. App icon is a white thumbs up on the violet to blue gradient tile. Brand wordmark is Toreroflow with a by Torerone sublabel.

---

## 14. Open decisions (pick the default, confirm later)

1. Publishing provider. Default: start on a unified provider (evaluate Ayrshare, Blotato, Zernio; Postiz if self hosting). Confirm Snapchat coverage and budget before committing.
2. Captions engine. Default: faster-whisper self hosted for cost. Alternative: Deepgram or AssemblyAI for zero ops.
3. Hosting. Default: Fly.io for the backend, managed Postgres and Redis, Cloudflare R2 for storage.
4. Desktop framework. Default: Tauri v2. Fall back to Electron only if a needed capability is missing.
5. Animated captions. Default: FFmpeg ASS styles in v1, Remotion later for word by word animation.

---

## 15. Security, compliance, and platform terms

- Encrypt all OAuth tokens at rest and in transit. Never log tokens.
- Each platform has its own terms and, for direct integrations, an app review. Instagram needs business or creator accounts on a Facebook Page. TikTok public posting needs the audit. Respect per platform rate limits in the scheduler.
- Store the minimum client data needed. Provide a way to disconnect an account and delete its tokens.
- Keep secrets in the hosting provider's secret store, not in the repo. Provide an env sample only.

---

## 16. Environment variables (sample)

```
DATABASE_URL=
REDIS_URL=
STORAGE_ENDPOINT=
STORAGE_BUCKET=
STORAGE_ACCESS_KEY=
STORAGE_SECRET_KEY=
TOKEN_ENCRYPTION_KEY=
ANTHROPIC_API_KEY=            # Claude caption generation
PUBLISH_PROVIDER=ayrshare     # or blotato | zernio | postiz | direct
PUBLISH_PROVIDER_API_KEY=
CAPTIONS_PROVIDER=whisper     # or deepgram | assemblyai
CAPTIONS_API_KEY=
APP_BASE_URL=
OAUTH_REDIRECT_URL=
```

---

## 17. First actions for Claude Code

1. Create the monorepo and packages in Section 6.
2. Write the Prisma schema from Section 7 and run the first migration.
3. Scaffold the Fastify API with auth and a health route.
4. Boot the Tauri + React desktop app and port the prototype screens using the tokens in Section 13.
5. Stop and report M0 status before starting M1.

End of specification.
