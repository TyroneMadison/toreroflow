# Changelog

All notable changes to Toreroflow are documented in this file, newest first.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Every change ships to both surfaces: the web app at app.torerone.com and the
desktop app (a `v*` tag publishes it through auto-update).

## [0.3.68] - 2026-11-27

### Added - AI replies, Metrics, Auto-post (F5)

- **AI replies** (Workflows > AI replies, desktop, web and phone): a status band with one switch per account (OFF for every account until a person turns one on), Needs you (chats nobody answered for 30 minutes and chats the AI handed to the team, with the reason; Open, and on the phone Mark as done, Let the AI answer again in this chat only, Tag as friend), the period's numbers (chats answered without help, handed to the team, AI spend; Today, 7 days or 30 days) with where people are in the funnel, and How it answers: What the AI knows (instructions, up to 5 links it may send, lessons from handoffs), Reply timing (leave a draft or send it on its own, a random wait of at once, 20 to 90 seconds or 2 to 5 minutes, typing dots, pause when your team replies and when to turn back on, quiet hours, most replies a day), Never auto-reply to (friends and per-chat offs) and When it hands off (prices, refunds, complaints, asking for a person, plus your own words). Try a test message shows what it would answer without sending. Stop all AI sending is a kill switch for every account. If asked, it says it is an assistant for the brand and never pretends to be a person
- **In the Inbox**: an AI draft waits above the composer with Edit, Send and Discard (an autopilot reply shows when it will go out); "Draft with AI" asks for one in any chat whose account has AI replies on, Messenger included; Details shows AI replies for this chat with its switch (or Let it answer after a handoff) and the AI's note about the person
- **Metrics** (Workflows > Metrics): the six numbers (messages received, people who messaged, new contacts, automation reach, reply rate after an automation DM, CTR) with their change against the period before are tabs over a 30 to 90 day chart; delivery problems at the chart's foot (outside the 24 hour window, person cannot get messages, hourly limit); where people drop off (triggered, got the DM, opened the link, replied); what started conversations; top automations with runs, CTR and a trend line; replies (median reply time, AI drafts sent as written, edited, sent by the AI, handed off, AI spend). 7, 30, 90 days or all time, per account; Export CSV. Computed from the DM tables; Messenger and Instagram read through Zernio count as people only, and the page says so
- **Auto-post** (Workflows > Auto-post): Drive auto-post as one status band (Running, today X of Y, next post, waiting in the folder, scheduled so far) with Open Drive folder, Check folder now and a "..." for Connect another Instagram account, Copy connect link, Sync accounts and Stop; the recent videos as the main list (All or Needs a look); the settings as a summary with Edit; the fan-out rules as compact rows under "Saved, not running yet" with New rule. Nothing runs the fan-out rules yet, as before. Everything the old Drive card did is still there
- **Overview** (Workflows): the week's six numbers and one card per area, instead of the Drive card and the rule form. The desktop rail shows live counts: unread, live automations, AI On, Drafts or Off, contacts, Auto-post Running

### Engine (worker)

- Every 15 seconds: autopilot replies whose wait is over, then a draft for each native Instagram chat that went quiet (45 seconds after their last message) on an account with AI replies on, with Claude (`SUGGESTIONS_MODEL`, the captions model) reading the chat, the account's notes, links and lessons. One draft per inbound message, never twice
- Never written for: paused chats, chats with AI off, handed-off chats, chats paused after a team reply, friends, chats where they did not write last, closed 24 hour windows, and messages an automation already answered. A handoff rule match hands the chat to the team before the model is asked; the model hands off anything it is not sure of
- Autopilot sends only on Instagram connected through Torerone's Meta app, only when a person chose "Send it on its own" for that account, and re-checks everything at send time: the kill switch, the window (not in its last 10 minutes), a team reply or a new message in the meantime, paused, handed off, quiet hours and the daily cap (those two keep it as a draft). Typing dots first, up to three short messages, no em dashes, no link that is not one of the account's own. Messenger and Instagram through Zernio are never answered on their own and never sent by the AI: a person asks for a draft and sends it, inside the window
- A reply by the team in Toreroflow counts the AI draft it came from (as written or edited), drops any other waiting draft and pauses the AI in that chat for the hours set

### API

- `GET /clients/:id/dm/ai`, `PUT /clients/:id/dm/ai/:accountId` (autopilot refused where the AI cannot send), `POST /clients/:id/dm/ai/kill`, `POST /clients/:id/dm/ai/test`, `POST /clients/:id/dm/ai/drafts/:draftId/discard`, `POST /clients/:id/dm/threads/:threadId/ai` (per-chat switch, Let the AI answer again), `POST /clients/:id/dm/threads/:threadId/ai-draft`; `GET /clients/:id/dm/metrics?range=&accounts=`; `GET /clients/:id/dm/summary`. The thread read carries the waiting draft and the AI note; the reply takes `draftId`. Reads for anyone signed in; every write is operator only: viewers and every bot token, Polly included, get 403

### Removed

- The Workflows "coming soon" placeholders and the old Drive auto-post card (`DriveAutoPost.tsx`): Auto-post covers all of it

### Database

- `DmAiSettings` (one row per DM account; `enabled` defaults to false and `mode` to drafts, and no row means the same), `DmAiDraft`, and four columns on `DmThread` (`aiOff` default false, `aiHandoffAt`, `aiHandoffReason`, `aiPausedUntil`). Migration `20261127210000_dm_ai_replies`: new tables and new columns only. `packages/core/src/dmAi.check.ts` fails if any default ever turns the AI on

## [0.3.67] - 2026-11-27

### Added - Automations (F4)

- **Automations** (Workflows > Automations, desktop, web and phone): every DM automation of the brand in one list grouped by folder, with a status dot, the trigger as one line with its keywords, the account, runs, CTR and an 8 day trend line, an on/off switch and a "..." menu (Edit, Live, Test with a code, Duplicate, Move to folder, Delete). State tabs All, Live, Drafts and Off with counts, search, Filters (trigger, account, folder), sort, the trash with Restore. Beside it: Recent comments (DM sent, Queued, Ignored, Failed, Expired, Repeat, with "Private replies this hour: N of 700" and a Pause all kill switch per account) and Basic replies (welcome message and story mention reply open their automation; conversation starters, main menu and the AI default reply come later)
- **Triggers**: a comment on any post, one picked post or the next post published (and live comments); a reply to your story; a mention in their story; a DM with a keyword; someone's very first DM (welcome). Keywords match by Contains, Whole word or Exact, or Any comment, with a Never match list
- **New automation**: account, folder and six templates (comment keyword to DM link, the same for followers only, DM keyword to link, story reply, welcome message, blank)
- **Editor** (`/create/workflows/automations/<id>`): four steps, only the one you are on open, each with a one line summary: When this happens (account, trigger, keywords, match, which posts, never match), Reply in public (up to 5 replies, one picked at random), Send the DM (message with {first_name} and {username}, an optional link button) and Options (followers only, track link opens, also answer DMs with the keyword, once per person). Beside it: a preview on the post and in their DMs, Test it (a 3 digit code: DM it to the account and the draft runs for you, plus a dry run check that says whether a comment matches and sends nothing) and Runs, Link opens and CTR. Every change saves as a draft after a moment; people get the published version until Publish. The phone opens the DM, the post picker and Never match in sheets
- **Post picker**: only the chosen Instagram account's posts and reels, with thumbnails, live from Instagram once the account is connected through Torerone's Meta app, else from the posts the app already has for that account. Never YouTube videos: the scope refuses anything but an Instagram post id
- **Zernio campaigns move in**: the DM campaigns still running at Zernio show in the same list under "Still at Zernio" (Zernio badge) and keep working: on/off, Leads and delete. "Move to native" recreates one here as a draft once its Instagram account is connected (Messenger stays at Zernio). When a native automation answers the same keyword on the same account, the list warns and Publish offers to pause the Zernio campaign; it is never paused unless you tick it. An account not connected yet can still run a new comment automation at Zernio from the publish dialog
- **States**: loading, could not load (retries every 15 seconds), no automations yet, Instagram not connected through Torerone's Meta app (automations wait, nothing sends), and a viewer's read-only list and editor

### Engine (worker)

- Comments and live comments from the webhook (our own public replies are skipped), story replies, story mentions, DM keywords and first DMs are matched against the live automations: one event, one reply (stories first, then keywords, the welcome only when nothing else matched; a post-specific automation beats an account-wide one)
- A comment gets its private reply (one per comment, within 7 days), a DM answer goes out only inside the 24 hour window, never with the HUMAN_AGENT tag. Then the optional public reply, and a run row saying what happened. Each event is claimed once per account, so a redelivered webhook never sends twice; once per person is kept per automation
- Followers only asks people who do not follow yet to follow first; tracked links go through `/dm/l/<run>` and count link opens once per person
- About 700 automated sends an hour per account; the rest wait in a queue drained every minute, oldest first, and expire past the window. Instagram hiccups retry with a backoff; refusals fail with the reason
- Dark launch: nothing sends unless the account is connected natively with an active token and the automation is Live and published. A per-account kill switch stops everything on that account. `DM_AUTOMATIONS_DRY_RUN=1` matches and records what would have gone out without calling Instagram

### API

- `GET/POST /clients/:id/dm/automations`, `GET/PATCH/DELETE /clients/:id/dm/automations/:aid` and `.../publish`, `.../status`, `.../duplicate`, `.../restore`, `.../test` (dry run), `.../test-code`; `GET .../posts?accountId=` (the Instagram post picker), `GET .../runs` (recent comments), `POST .../kill` (per-account kill switch), `POST .../move` (Move to native); public `GET /dm/l/:runId` (tracked link). Reads for anyone signed in; every write is operator only: viewers and every bot token, Polly included, get 403

### Removed

- The old DM campaigns card (Workflows Overview and Automations) and its styles: the Automations list covers its campaigns, toggle, delete and leads, and creates new ones. The `/clients/:id/dm-campaigns` API stays (the list uses it)

### Database

- `DmAutomation` and `DmAutomationRun`, and `DmAccount.automationsPausedAt` (migration `20261127180000_dm_automations`: new tables and one nullable column)

## [0.3.66] - 2026-11-27

### Added - Inbox and Contacts (F3)

- **Inbox** (Workflows > Inbox, desktop, web and phone), replacing the old DM inbox: one list of Instagram (through Torerone's Meta app, or Zernio until connected) and Facebook Messenger conversations with a channel badge, status tabs (All, Active, Paused, Flagged, Done), search, account chips, stage, tag, channel and unread filters, and unread counts. Desktop shows list, conversation and details side by side; the phone opens the conversation full screen with the tab bar hidden, details and the press-and-hold actions in sheets. It checks for new messages every 4 seconds while the page is visible and stops while the tab is hidden
- **Messages drawn as they are**: text, photos, video, voice notes with a player and the transcript, story replies and mentions, shared posts and reels, stickers, hearts, unsent and edited messages, reactions and replied-to quotes, grouped into runs with day lines. A photo Meta has expired is fetched again through the media proxy; if even that fails the box says so and offers to load it again instead of a broken image
- **Composer**: text (Enter sends, Shift+Enter for a new line), emoji, a photo (JPG, PNG or GIF up to 8 MB, Instagram through our Meta app only), replying to one message, and "14h 12m left in the reply window" under it. When the 24 hour window has closed the composer locks with the reason and when it opens again; Messenger says it is reply only; a refused token shows the Reconnect banner
- **Details**: stage, auto replies on or paused, conversation state, reply window, tags, notes and activity (messages, how it started, last message, first seen)
- **Contacts** (Workflows > Contacts): everyone who has messaged the brand, with All, Unread and per-tag views, search, stage, channel and account filters, a person panel with Open conversation, select mode for one stage or tag change on many people (desktop and phone), and Export CSV
- **Viewers** see the Inbox and Contacts read-only: no composer (a read-only notice instead), no tag, stage, pause or select controls, and nothing is marked read on their behalf. The server refuses their writes either way
- **Phone**: Workflows shows its seven areas as chips under the title, the Inbox chip with the unread count (it replaces the "DM inbox N new" jump chip). Every sheet fits a 360 px screen

### API

- `GET /clients/:id/dm/threads` takes `platform`, `paused` and `unread`, and counts paused threads. The list asks Zernio at most every 15 seconds per brand, so the 4 second poll reads the mirror in between
- `GET /clients/:id/dm/threads/:threadId` adds `activity` (message count, first seen, how it started)
- `GET /clients/:id/dm/contacts` takes `unread`, `platform`, several stages and `sort`, returns each person's last message, unread count and reply window, and the totals for the All and Unread views
- New `POST /clients/:id/dm/contacts/bulk` (one stage, tags to add, tags to remove, every id must be the brand's) and `POST /clients/:id/dm/upload` (the photo for a reply, stored and handed back as a signed public link Instagram can fetch). Both are operator only like every DM write: viewers and bots get 403

### Removed

- The old DM inbox component and its styles. `/clients/:id/inbox` stays for desktop builds older than this one until they update

## [0.3.65] - 2026-11-27

### Added - DM backend foundation: Instagram through our own Meta app (F2)

- **Instagram DMs through Torerone's own Meta app** (Instagram API with Instagram Login), built and **dark-launched**: until `META_IG_APP_ID` and `META_IG_APP_SECRET` are on the server, `GET/POST /webhooks/meta`, the deauthorize and data-deletion callbacks and the Instagram connect answer `503 {"reason":"instagram_not_configured"}` and every inbox keeps reading through Zernio. Setup steps for Meta's dashboard: `docs/meta-instagram-setup.md`
- **Webhook**: the handshake checks `META_VERIFY_TOKEN`; deliveries are verified with an HMAC of the raw body (constant time, Instagram app secret or the existing Meta app secret), stored first and processed by the worker, so a redelivery, the sync and our own echo land on one message. Bad signatures are refused and show on `/dm/status`
- **Connect Instagram** (`POST /oauth/instagram/start/:accountId`, callback `/oauth/instagram/callback`): signed state, 60-day token stored encrypted (`TOKEN_ENCRYPTION_KEY`), the wrong Instagram account refused by name, the account subscribed to messages, reactions, seen, postbacks and comments, recent conversations imported at once
- **Worker**: webhook ingest (text, photos, video, voice notes, story replies and mentions, shared posts and reels, reactions, edits, unsends), a missed-DM sync every 5 minutes, daily token refresh (alert and "Reconnect" when Instagram refuses it), a sweep for deliveries the queue missed, and webhook-log pruning
- **Unified inbox API** under `/clients/:id/dm/...`: threads (status, stage, tag, search and account filters, paging, counts), one thread with its messages, reply (text and media; the 24h window enforced with a clear 409, `HUMAN_AGENT` up to 7 days when `META_IG_HUMAN_AGENT=1`), mark read, stage, status, tags, notes, pause and resume, and contacts. Native Instagram and Zernio (Instagram before connecting, Facebook Messenger always, reply only) come back in one shape; `GET /dm/status` says which transport each account uses
- **Media proxy** `/dm/media/...`: signed links, Meta and Zernio hosts only, Range passthrough, nothing stored. An expired attachment is read again on demand (Instagram's message API, or Zernio's attachment refresh, which was built and never called), so images in old threads draw again, in the current inbox too
- **Workflows, Inbox**: a "Connect Instagram for DMs" card (mockup 10, state a) while an Instagram account still reads through Zernio; its button stays off with a note until the Meta app is set up

### Fixed

- **Viewers could send DMs, and every other viewer check was dead.** Login tokens never carried the role, so `role === "viewer"` was never true for a real viewer login. The role is now signed in at login, and DM writes check the user row for tokens issued before this release. Every DM send or change answers 403 for viewers and for all bot tokens (Polly reads only), guarded once for the whole DM plugin and checked route by route
- **A viewer could mint a bot token**, including a full-access "polly" one. `/auth/bot-token` now refuses viewers
- **DM campaign post scope** rejects ids that are not Instagram or Facebook posts (the old picker sent YouTube video ids, so scoped campaigns never fired). The picker itself is replaced with the Automations screen (F4)

### Database

- Migration `20261127120000_dm_core`: `DmAccount`, `DmContact`, `DmThread`, `DmMessage`, `DmWebhookEvent`, `DmTag`, `DmContactTag`. New tables only

## [0.3.64] - 2026-11-27

### Changed - Dock menus, breadcrumb, one Reports tab (desktop and web)

- Each **Dock tab has a drop-up menu** of its pages: it opens after the pointer rests 80 ms, slides up over 200 ms with the pages 22 ms apart, and stays open across a safe bridge and while the pointer heads up to it (aim check), closing 250 ms after the pointer leaves. Full keyboard support (focus opens it, arrows, Home, End, Enter, Escape), touch (first tap opens the menu, second opens the page) and a reduced-motion fade
- The **pill tabs under the page title are gone** on desktop and web; a breadcrumb over the title names the Dock tab (and Workflows for its areas). Settings' cards moved into the Settings menu
- **Measure and Reports are one Reports tab**, Analytics first, with the same six pages. `/measure` opens Analytics; every other address is unchanged
- **A click on a Dock tab reopens the last page used in it**, remembered per tab across reloads and checked against today's pages (a page that no longer exists falls back to the tab's first page)
- **Workflows has a rail** with its seven areas (Overview, Inbox, Automations, AI replies, Contacts, Metrics, Auto-post), each with its own address `/create/workflows/<area>`. Inbox shows the DM inbox, Automations the DM campaigns, Auto-post Drive auto-post and the fan-out rules; AI replies, Contacts and Metrics are marked as coming soon in this update. Overview keeps everything the page had
- The active Dock tab is solid coral again, as in the approved mockups; the Failed posts page shows its count in the Overview menu
- The phone keeps its tab bar, header and page chips exactly as before

## [0.3.25] - 2026-10-14

### Added - per-client caption block

- Each client can have a **caption block**: standing text added directly under every caption and description, on every platform, with no blank line or divider. Line breaks inside the block are kept exactly
- **Keyword lines** (optional): the first line whose keyword appears in the video title, Trello card title or caption (whole word, any case) goes between the caption and the block
- **On by default**, with a per-post switch in the schedule window to skip the block for one post. The long-form schedule window does not have the switch yet
- **Settings card** (Settings → Trello labels → Caption block) to edit the block and keyword lines per client, and a **live preview** in the schedule window
- Composed **server-side** at schedule time (`composeCaption` in `packages/core/src/captionBlock.ts`), so the app and bots get the same result. A caption that already contains the block is not doubled
- The **YouTube title is never touched**, only captions and descriptions
- `PUT /clients/:id/caption-block` is **human only**: it is not in the bot allow-list, so bot tokens are refused
- Migration `20261015000000_client_caption_block` adds `captionBlock`, `captionBlockOn` and `captionKeywords` to `Client`

Commits: 51421a6, merge 40ffc01, release 91a4fb5.

## [0.3.24] - 2026-10-14

### Added - Trello upload and card move

- **Upload to Trello** from the Ready queue: create a new card or attach to an existing one on the editor pipeline board, with files dropped straight in
- Files up to **250 MB** attach to Trello directly; bigger files go up as a signed Toreroflow link instead
- When a post is scheduled, its card moves to the **"Approved by Client/ uploaded"** list. If the move fails, a **Retry move** button appears
- Bots gain exactly one new route: `POST /trello/cards/:id/uploaded` (moving a scheduled Ready card). Every other Trello write stays human only
- Upload routes match cards to clients by cover color, the same way the Ready queue does

Commits: a1c94a2, 77554f6, 85ca8da, merge 8706847, release 20d3791.

## [0.3.23] - 2026-10-14

### Changed - cover-color client matching

- Trello cards are matched to clients by **card cover color**: red → Acme Motors, black/gray → Northside Rentals, yellow/gold → Lakeview Auto. A label is only used as a fallback when the card has no cover
- The mapping is editable in Settings → Trello labels (Trello cover colors). Unmapped colors are held and never scheduled automatically

### Fixed

- A BMW card was being matched to the wrong client; it now resolves to Northside Rentals by its cover color

Commits: fecb6af, merge 3a8f281, release 0d8fa95.

### Changed - glass default

- Default glass translucency is now **0.5** (halfway frosted) instead of 0.95 (near clear). Only affects people who never moved the slider (6ba29e3)

## Polly-friendly scheduling (PR #2) - 2026-10-14

### Added

- **Ready queue** per client, fed from the Trello board's Ready list
- **SOP schedule page** and an SOP panel per client; the SOP check is a gentle reminder rather than a block (528f5a8)
- **Trello label map** in Settings, and routed Carousels and Workflows pages
- Migration `20261014230000_client_sop_trello` adds `slug`, `sop`, `sopUpdatedAt` and `trelloLabels` to `Client`

Commits: fbcc9f3, 528f5a8, merge 19bd64a.

### Outside this repo

- Polly's caption SOP now lives as a bot skill on the bot side, not in the app. The app enforces the caption block and SOP reminder; the skill covers how captions are written

## [0.3.17 - 0.3.22] - 2026-10-13

- Clear Glass redesign phase 1 and 2: tokens, dock frame, Dashboard, real routes and agent-readable state (0c1eab2, f872e65)
- Liquid glass redesign: glass-level tokens, refraction filter, translucency slider (1a1993c)
- Glass page layouts for Financials, Account Overview and Reports; see-through desktop window (ebdb530)
- Analytics v6 layout with platform pill strip and section tabs (91983cf)
- Client carousel at the top of Account Overview; "Needs you now" only when a client needs attention (92aa493, 78ef89a)
- Full-bleed client photo cards, Analytics v6 grid with Reach ring, Posting queue and Carousels (ef05eef, 0.3.22)

## Earlier

### Unreleased (pre-0.3 notes)

### Added - lifetime YouTube history

- Reads a client's entire YouTube catalogue straight from YouTube rather than the publishing provider, which only keeps a recent window. Lifetime view counts, titles, thumbnails, durations, and publish dates for every video on the channel
- This is what makes all-time rankings real. The provider exposed 136 posts back to April and claimed the channel held 201; YouTube itself returned **481 videos and 39.5M lifetime views**. The 1M+ tier was empty because that history was never available, not because of a display fault
- Live result for one client: 6 videos above a million views (best 13.47M), 12 between 100K and 999K, and 138 between 10K and 99K, all imported in about seven seconds
- Where the same video comes from both sources, the platform's own numbers win and the provider's windowed copy is discarded, so nothing is counted twice
- The Refresh button on Analytics now pulls lifetime YouTube counts along with everything else, and the daily analytics job refreshes them too, so view totals keep climbing without anyone asking. Repeat syncs update in place rather than duplicating
- Needs a free `YOUTUBE_API_KEY` in `.env`. Without it nothing breaks: the sync returns a clear message and every other figure carries on as before
- Instagram lifetime history stays unavailable for now; it requires a Meta app with business verification, and Instagram reports no view figure at all for older non-Reel posts

### Added - analytics breakdown per platform

- Platform tabs on Analytics: an Overall view plus one tab per connected network, color coded. Selecting a platform narrows every figure on the screen (views, watch time, followers, uploads, chart, tables, rankings) to that network alone
- Range selector for 30, 60, 90 days, or All. "All" covers the full history the provider holds and the header names the actual start date instead of implying a complete account archive
- Metrics that only exist on one network behave correctly: subscribers reads blank on an Instagram tab and shows the real count on YouTube
- Views over time is now a proper chart: labelled axes, gridlines, a line per platform plus the combined total, and a hover readout of any day's numbers. It sits in the main column with room to read, and is labelled as views by publish date, which is how the provider attributes them

### Fixed - quota counters

- The minus button stops at zero instead of quietly counting into the negative, so pressing plus afterwards moves the number straight back up
- Each counter has a delete button, so a client who only needs short-form (or only long-form) does not have to keep the other one around. Removing a counter clears its manual adjustment, so adding it back later starts clean

### Added - per-client video quota, split by format

- Separate short-form and long-form targets per client, each with its own progress bar, remaining count, and manual adjustment. Track one format or both; a client with no target for a format simply does not show it
- Videos are sorted into short or long automatically from their duration (three minutes is the cut-off), and a Short/Long switch on each video overrides that whenever the duration does not reflect intent
- Every brand keeps its own targets and counts, so a new client starts clean with their own monthly requirement
- One "New period" resets both formats together when the pay period rolls over
- Revisions do not spend a slot. A re-export named like an earlier upload ("… v2", "… final", "… revised", "… (1)") is detected on upload and marked a revision automatically; a chain of revisions all point back to the first upload
- Any video can be flipped between counting and not counting with one click, so a wrong guess is never sticky
- "Replace the original" marks a video as a revision and cancels whatever is still scheduled for the video it replaces, so the new cut takes the slot instead of both going out
- The delivered count is derived rather than stored, so deleting a video corrects the number by itself

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
