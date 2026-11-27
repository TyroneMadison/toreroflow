# Driving Toreroflow with a bot

For automations (Grokbot or any agent) that upload and schedule content
without an operator at the keyboard. Two ways in, one credential.

## The bot token

A year-long JWT that can do exactly four things: read the client/account
list, upload a video, write its copy, and schedule it. It cannot delete
anything, cannot touch financials, cannot read or send DMs, cannot retry or
reschedule existing posts, and cannot mint more tokens. The whole list lives
in `apps/api/src/auth/botAccess.ts`; anything not on it answers 403.

## DMs: read-only for every bot

- **Polly** (full access) can **read** DM threads, messages, contacts and
  `/dm/status`. She can never send a DM, upload a reply photo, mark one read,
  tag, stage, bulk-edit contacts, pause or
  change a conversation, start an Instagram connect, or create, edit or
  delete a DM campaign: those answer `403 {"reason":"bot_read_only"}` for
  every bot token, full access or not (`apps/api/src/dm/guard.ts`).
- **Every other bot** cannot reach the DM routes at all: none of them is on
  the whitelist, so they answer `403` like any route outside the job.
- Viewers get the same read-only DMs (`403 {"reason":"viewer_read_only"}`
  on any write), with one exception since F7: a viewer may mark read
  (`POST /clients/:id/dm/threads/:threadId/read` and
  `POST /clients/:id/dm/threads/read-all`, the list `VIEWER_MAY` in
  `apps/api/src/dm/guard.ts`). It only clears the team's unread counts, for a
  brand of the viewer's own agency; a viewer's read sends Instagram no "Seen".
  Bots still get `403 {"reason":"bot_read_only"}` there.
- `apps/api/src/dm/dm.check.ts` drives every DM write route with a viewer, a
  Polly and a plain bot token and fails if any of them is not refused;
  `botAccess.check.ts` pins that no DM route is on the whitelist.
- **Automations** (`/clients/:id/dm/automations...`, F4) follow the same rule:
  Polly can read the list, one automation, the post picker and recent
  comments; creating, saving, publishing, turning on or off, testing, the
  test code, the per-account kill switch, Move to native and deleting answer
  `403 {"reason":"bot_read_only"}` for every bot and
  `403 {"reason":"viewer_read_only"}` for viewers
  (`apps/api/src/dm/automations.check.ts` walks every write route).
- **AI replies and Metrics** (`/clients/:id/dm/ai...`, `/dm/metrics`,
  `/dm/summary`, F5) follow the same rule: Polly can read the AI replies page,
  the metrics and the rail summary; turning AI replies on or off, any
  setting, the kill switch, Try a test message, a draft on request, the
  per-chat switch and discarding a draft answer `403 {"reason":"bot_read_only"}`
  for every bot and `403 {"reason":"viewer_read_only"}` for viewers
  (`apps/api/src/dm/ai.check.ts` walks every write route). No bot can turn the
  AI on: it is off for every account until a person does.

Mint one (as the operator, with your normal app login token; viewers are
refused):

```bash
curl -s -X POST https://api.torerone.com/auth/bot-token \
  -H "Authorization: Bearer $OPERATOR_TOKEN"
# -> { "token": "...", "role": "bot", "expiresInDays": 365 }
```

Rotation: mint a new one, update the bot. There is no revocation list; the
old token lives until its expiry, so treat it like a password.

Every guardrail is server-side and applies to bots exactly as to humans:
past times are refused, Instagram reel/feed length logic runs, TikTok's
shared quota defers instead of failing, and confirmPublishing watches every
publish. A bot cannot schedule something the app itself would refuse.

## Way 1: the API (recommended)

The whole workflow is four calls. `BOT` is the bot token.

```bash
# 1. Find the client and account ids (once; they are stable).
curl -s https://api.torerone.com/clients -H "Authorization: Bearer $BOT"
# -> [{ "id": "<clientId>", "name": "Caleb", "accounts": [{ "id": "<accountId>", "platform": "tiktok", ... }] }]

# 2. Upload the video. Returns the asset; processing runs on the server.
curl -s -X POST "https://api.torerone.com/clients/<clientId>/media" \
  -H "Authorization: Bearer $BOT" \
  -F "file=@video.mp4;type=video/mp4"
# -> { "id": "<assetId>", "status": "processing", ... }

# 3. Poll until status is "ready" (transcription and analysis included).
curl -s "https://api.torerone.com/media/<assetId>" -H "Authorization: Bearer $BOT"

# 4a. Write the copy (all fields optional; omitted ones keep AI drafts).
curl -s -X PATCH "https://api.torerone.com/media/<assetId>/draft" \
  -H "Authorization: Bearer $BOT" -H "Content-Type: application/json" \
  -d '{"name":"Sell me this pen pt 5","description":"The caption...","youtubeTitle":"...","hashtags":["cars"]}'

# 4b. Schedule. ISO time with offset; the past is refused.
curl -s -X POST "https://api.torerone.com/media/<assetId>/schedule" \
  -H "Authorization: Bearer $BOT" -H "Content-Type: application/json" \
  -d '{"platforms":["tiktok","instagram"],"accountIds":["<accountId>","..."],"scheduledAt":"2026-09-02T22:00:00Z"}'
```

Optional per-platform options on the schedule body (`instagram`, `youtube`,
`tiktok` objects) match `schedulePostSchema` in `packages/core/src/schemas.ts`.
Everything scheduled appears in the operator's calendar like any other post
and can be moved or removed there before it fires.

## Way 2: the browser (for vision-driven agents)

The full app UI is served at the web app domain. Sign the bot in by opening:

```
https://<APP_DOMAIN>/create/upload?client=<clientId>&automation=1#token=<BOT_TOKEN>
```

The fragment becomes the session and is scrubbed from the address bar, on
any path, so the link above signs in and lands straight on Upload & Schedule
for that client with animation and blur off. Every screen has its own URL,
and the app publishes what it is doing (screen, brand, busy, last error) as
html attributes and `window.__TOREROFLOW_STATE__`, so a bot can wait for
`html[data-busy="false"]` and `[data-state="ready"]` instead of guessing.
All of it is in [agent-state.md](agent-state.md). Screens
outside the bot's permissions (Financials, the DM inbox, deletions) render
errors when opened - the server refuses, the browser only displays.

## Failure answers worth teaching the bot

- `401` - the token expired (or was replaced). Stop and ask the operator.
- `403 bot tokens can upload, write copy and schedule...` - the bot tried a
  route outside its job. That is a bug in the bot's plan, not a retry.
- `403 bot tokens can read DMs but cannot send or change them` - DMs are
  read-only for bots, Polly included. Hand the reply to the operator.
- `400 invalid scheduledAt` - the time was in the past. Pick a future time.
- `409 asset is still processing` - poll `/media/<assetId>` until "ready".
