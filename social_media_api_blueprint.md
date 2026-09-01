# Comprehensive API Capabilities Blueprint: Instagram, TikTok, & YouTube

This document outlines every core functional capability, asset lifecycle management feature, analytics metric, and web-hook event exposed by the official APIs for Instagram (Graph API), TikTok (Display/Research APIs), and YouTube (Data & Analytics APIs).

---

## 1. INSTAGRAM GRAPH API CAPABILITIES

### Content & Asset Lifecycle Management
* **Media Publishing (Container-Based API):** 
  * Upload and schedule Feed Images, Single Videos, Carousels, and Reels.
  * Support for multi-step container creation, media status polling, and publishing.
* **Story Management:** 
  * Read organic active Stories and metadata (publishing via API is restricted to specific partner tiers).
* **Comment Management & Moderation:** 
  * Read, create, delete, hide, or unhide comments on posts, reels, and live broadcasts.
  * Toggle comment status (allow/disallow comments per media object).
* **Direct Messaging (Messenger Platform for Instagram):** 
  * Send/receive text, media, templates, quick replies, and product cards.
  * Automate replies with Icebreakers and Persistent Menus.
* **Live Stream Processing:** 
  * Fetch live video RTMP streaming configurations and live comment streams.

### Analytics & Insight Discovery
* **Account-Level Performance:** Total reach, impressions, profile views, website clicks, and user contact button clicks.
* **Media Object Metrics:** Likes, comments, shares, saves, video plays, loop counts, and average watch time.
* **Story Metrics:** Exits, replies, taps forward, and taps backward.
* **Demographic Granularity:** Follower distribution sliced by city, country, locale, age group, and gender.
* **Temporal Insights:** Hourly and daily trends detailing when followers are actively online.

### Webhooks & Real-Time Event Subscriptions
* **`comments` event:** Fires when a user leaves, edits, or deletes a comment on a post/reel.
* **`messages` event:** Triggers on new inbound DMs, story mentions, or message echoes.
* **`insights` event:** Delivers periodic asynchronous updates on processed post-performance metrics.

---

## 2. TIKTOK API CAPABILITIES (DISPLAY, CREATOR, & RESEARCH)

### Content & Asset Lifecycle Management
* **Direct Post API:** 
  * Programmatic video upload and publishing directly to a user's TikTok feed.
  * Add video titles, privacy toggles, descriptions, and custom cover images.
* **Sound & Music Integration:** 
  * Access trending commercial sounds or link videos to specific licensed audio tracks.
* **User Profile Configuration:** 
  * Read public profile metadata, custom bios, avatar assets, and account verification states.

### Analytics & Insight Discovery
* **Video Metadata & Aggregates:** Aggregate counts for views, likes, comments, shares, and bookmarks/favorites.
* **Retention & Watch Behavior:** Total video playtime, average watch duration, and full video completion rates.
* **Traffic Attribution:** Metric percentages tracking if viewers arrived via the For You Page (FYP), Following Feed, Profile, Search, or Sounds.
* **Creator Studio Stats:** Multi-day account-wide performance metrics (follower growth, aggregate content views).
* **Research API Sandbox:** Query anonymized public videos, regional trends, hashtag volumes, and search query trends.

### Webhooks & Real-Time Event Subscriptions
* **Authorized Webhooks:** Notifications triggering on account authorization status changes or video processing success/failure events.

---

## 3. YOUTUBE DATA & ANALYTICS APIs

### Content & Asset Lifecycle Management
* **Video & Shorts Upload (Resumable Upload Protocol):** 
  * Upload, update, or delete video files.
  * Set titles, descriptions, categories, language tags, privacy states, and custom thumbnails.
* **Playlist & Channel Curation:** 
  * Create, update, or delete playlists.
  * Reorder playlist items and batch-add external videos.
* **Live Streaming Automation (Live Streaming API):** 
  * Create, bind, manage, and transition Live Broadcasts and Live Streams (Testing, Live, Completed).
  * Ingest RTMP/HLS configuration endpoints.
  * Fetch, insert, and moderate live chat messages in real time.
* **Comment & Community Management:** 
  * Retrieve, reply to, moderate, or flag video comments and comment threads.

### Analytics & Insight Discovery
* **Engagement & Conversion Engine:** Total view counts, likes, shares, added/deleted comments, and net subscriber shifts.
* **Watch Performance:** Cumulative watch time (minutes), average view duration (seconds), and average retention percentages.
* **Revenue & Monetization Matrix:** Estimates for gross earnings, ad-driven revenue, transaction revenue (Super Chats, Channel Memberships), CPM, and RPM.
* **Dimensional Query Filters:** Group all engagement metrics against traffic sources, user device hardware, host operating systems, geographic regions, and demographic charts.

### Webhooks & Real-Time Event Subscriptions
* **PubSubHubbub (RSS/Atom feeds):** Push notifications firing immediately when a channel uploads a new video, modifies video privacy, or updates a title.

---

## 4. MASTER API INTEGRATION SYSTEM PROMPT

Copy and paste the prompt below into an LLM or orchestration agent to generate codebase architecture, database patterns, and integration microservices.

```text
You are an expert systems architect specializing in building robust, high-throughput, multi-tenant social media management and analytics SaaS platforms. 

I need you to build a system integration layer, database schema, data synchronization engine, and modular API wrapper that completely leverages the features of the Instagram Graph API, TikTok API, and YouTube Data/Analytics APIs.

The system must handle the following core architectural requirements across all platforms:

1. AUTHENTICITY & USER LIFECYCLE (OAuth 2.0 Engine)
- Build a multi-tenant OAuth flow managing long-lived tokens, offline access scopes, and proactive token refresh cron jobs for Instagram, TikTok, and YouTube.

2. CONTENT EXECUTION PIPELINE (Media Management & Publishing)
- Code architecture for container-based multi-step file uploads (Instagram), direct video posting (TikTok), and chunked, resumable uploads (YouTube Videos and Shorts).
- Support programmatic updates for metadata (titles, descriptions, tags, playlists, privacy states) and comment moderation controls.

3. RETRIEVAL & SYNCHRONIZATION ENGINE (Analytics & Reporting)
- Design a relational or time-series database layout (such as PostgreSQL with TimescaleDB or ClickHouse) capable of handling distinct account snapshot metrics, chronological time-series performance data, and demographic breakdowns.
- Account for platform discrepancies, including the 24-hour expiration window for Instagram Stories, the 48-hour processing lag of the YouTube Analytics API, and API quota limits (such as YouTube's 10,000-unit daily limit).

4. REAL-TIME DATA & WEBHOOK INGESTION
- Provide a webhook receiver framework to ingest incoming payloads cleanly:
  - Instagram: real-time 'comments' and 'messages' data.
  - TikTok: status notifications for processing videos.
  - YouTube: PubSubHubbub (Webhook) push streams for new video uploads.

Generate clean, industrial-grade backend service patterns, sample integration files, and explicit step-by-step implementation instructions.
```
