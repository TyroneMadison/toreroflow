# Getting direct API access: a step by step guide

Written 2026-08-11. This is the runbook for putting Toreroflow directly on the
Meta, Google and TikTok APIs, alongside Zernio rather than instead of it.

Everything here is a manual step for Tyrone. Accounts have to be created by the
person who owns the business, and credentials should never pass through a chat
transcript. What each platform hands back at the end goes to me, and section 5
says what I do with it.

Work the sections in order. Section 0 blocks all three platforms.

---

## 0. The two things every platform demands first

### 0.1 A live privacy policy and terms page

**Status: done.** Both are built and live at `/privacy` and `/terms`, linked
from the site footer so a reviewer or a crawler can reach them without being
told where to look.

They are committed to hero-app but **not yet pushed or deployed**. The URLs
have to actually resolve before you submit anything, so this deploys first.

- `https://torerone.com/privacy`
- `https://torerone.com/terms`

The policy names the real subprocessors and describes exactly which fields each
API returns. That matters: a reviewer compares the policy against the
permissions you request, and a generic template that does not mention insights
data is a common rejection.

### 0.2 A redirect URL on your own domain

Every one of these hands the browser back to a URL you control, over HTTPS.

Caddy on the server is already configured for `api.torerone.com` and will fetch
its own Let's Encrypt certificate. The domain has never resolved, so it has
never come up.

Add one record in Squarespace DNS:

| Type | Name | Data |
| --- | --- | --- |
| A | `api` | `66.94.99.120` |

The Name field is **just `api`**. Not `api.torerone.com`. That is the same trap
that doubled the inbound MX record into `torerone.com.torerone.com`.

Optionally also add `AAAA` / `api` / `2605:a144:2347:8058::1`.

Give it a few minutes, then tell me and I will confirm the certificate came up.
Every redirect URI below then works:

```
https://api.torerone.com/oauth/meta/callback
https://api.torerone.com/oauth/google/callback
https://api.torerone.com/oauth/tiktok/callback
```

---

## 1. Meta, covering Instagram and Facebook in one app

One app serves both platforms. Do not create two.

### 1.1 Prepare the accounts (this is the step that decides everything)

Meta grants **Standard Access** with no App Review and no Business
Verification when every user of the app has a role on the app or a role in the
Business Portfolio that claimed it. Accounts inside your portfolio count as
accounts you manage.

Get this right and you are live in days. Get it wrong and you are in a 2 to 4
week App Review that restarts whenever a reviewer asks for a change.

1. Go to `business.facebook.com`. If you do not have a Business Portfolio, create
   one for Torerone LLC.
2. **Business settings, Accounts, Pages:** add each client's Facebook Page.
   The client approves the request from their side.
3. **Business settings, Accounts, Instagram accounts:** add each client's
   Instagram professional account, same approval flow.
4. Confirm each Instagram account is **Business or Creator**, not Personal, and
   is **linked to a Facebook Page**. A personal account cannot be used at all.

### 1.2 Create the app

1. `developers.facebook.com`, log in, **My Apps, Create App**.
2. App type: **Business**.
3. On the app's **Basic Settings**, set the Business Portfolio from 1.1 as the
   owning business. This is the "claimed by a business" link that Standard
   Access depends on.
4. Fill in: App name (`Toreroflow`), contact email, **Privacy Policy URL**
   (`https://torerone.com/privacy`), **Terms of Service URL**
   (`https://torerone.com/terms`), category Business.

### 1.3 Add products and permissions

1. Add product: **Instagram**, and pick the **Instagram API with Facebook
   Login** configuration. Not the Instagram Login one. You want Page Insights
   out of the same app and only this configuration reaches both.
2. Add product: **Facebook Login for Business**.
3. Under Facebook Login for Business settings, set **Valid OAuth Redirect URIs**
   to `https://api.torerone.com/oauth/meta/callback`.
4. Request these permissions. Under Standard Access they are available without
   review for users with a role in the claiming business:

```
instagram_basic
instagram_manage_insights
pages_read_engagement
pages_show_list
read_insights
business_management
```

### 1.4 What to send me

From **Settings, Basic**: the **App ID** and the **App Secret**.

Send the secret through something other than chat. Put it straight into the
server's env file if you prefer, and just tell me it is there.

---

## 2. Google, for YouTube

### 2.1 Project and APIs

1. `console.cloud.google.com`, create a new project named `Toreroflow`.
2. **APIs and Services, Library.** Enable both:
   - **YouTube Data API v3**
   - **YouTube Analytics API**

The second one is the whole point. The Data API gives public counts, which is
what we already have. The Analytics API is what gives watch time and retention.

### 2.2 OAuth consent screen

1. **APIs and Services, OAuth consent screen.** User type **External**.
2. App name `Toreroflow`, your support email, and the developer contact email.
3. **App domain:** `torerone.com`. **Privacy policy:** `https://torerone.com/privacy`.
   **Terms of service:** `https://torerone.com/terms`.
4. **Scopes:** add
   ```
   https://www.googleapis.com/auth/yt-analytics.readonly
   https://www.googleapis.com/auth/youtube.readonly
   ```
5. **Set the publishing status to "In production" immediately.**

Step 5 is the one people miss and it is not cosmetic. While the app sits in
"Testing", Google revokes refresh tokens after **7 days**, so a background sync
dies every week for no visible reason. Moving to production makes them
long-lived.

Production without verification still works. You will see an "unverified app"
warning on the consent screen that you can click past, and there is a 100 user
cap. For an agency with a handful of channels that is fine. Verification later
removes the warning and needs a demo video plus agreeing to the YouTube API
Services Terms. It is not urgent and it does not block anything.

### 2.3 Credentials

1. **APIs and Services, Credentials, Create Credentials, OAuth client ID.**
2. Application type: **Web application**.
3. Authorised redirect URI: `https://api.torerone.com/oauth/google/callback`.

### 2.4 What to send me

The **Client ID** and **Client Secret**.

### 2.5 Then, per channel

Each channel owner authorizes once, through a link the app generates. For
Caleb's channel that means he clicks it, picks the right Google account, clicks
past the unverified warning, and approves. That is the whole client-side effort.

---

## 3. TikTok

The most gated of the three, and the one whose data cannot be recovered later.

### 3.1 Register

1. `developers.tiktok.com`, register, verify your email.
2. Complete developer verification with your Torerone LLC details.

### 3.2 Create the app and apply for products

1. **Manage apps, Create an app.**
2. Fill in app name, description, **privacy policy URL**, **terms of service
   URL**, and the Torerone LLC business registration documents.
3. Apply for these products:
   - **Login Kit**
   - **TikTok API for Business**, specifically the **Business Account API**

**Do not apply for the Research API.** It is restricted to academic use and its
terms prohibit commercial products. Applying for it signals you have misread
what you need.

4. Redirect URI: `https://api.torerone.com/oauth/tiktok/callback`.

### 3.3 The use case description

This is the field that gets applications rejected. Vague descriptions fail. Say
something close to:

> Torerone LLC is a video production agency. Toreroflow is our internal
> dashboard. Creators who hire us authorize their own TikTok business account so
> that we can publish the videos we produce for them and report their own video
> performance back to them in a monthly and weekly report. We read only the
> authorizing account's own videos and their insights. We do not access, collect
> or index any other account's data, and we do not resell or redistribute any
> TikTok data.

### 3.4 Timing and preconditions

Review runs 3 to 7 days, occasionally two weeks. Some insight fields need a
separate allowlist request after approval.

Each client's TikTok must be a **Business account**, and the creator must have
opened the TikTok app and tapped **Turn On** on the Analytics page at least
once. Without that the insight fields return nothing regardless of our access.

### 3.5 What to send me

The **Client Key** and **Client Secret**.

### 3.6 The reason this one is urgent

TikTok's `reach`, `average_time_watched`, `full_video_watched_rate`,
`total_time_watched` and `impression_sources` stop being returned once a video
has been inactive for 7 days. **TikTok history cannot be backfilled.** Every
week without this integration is a week of TikTok retention data that is gone
permanently. That is the argument for starting the application now, even while
Phase 1 is still being built.

---

## 4. Order to work in

1. Deploy the site so `/privacy` and `/terms` resolve. Blocks all three.
2. Add the `api` DNS record. Blocks all three.
3. **Submit TikTok first.** It has the longest review and the only data that
   expires.
4. Meta next. Fastest to actually working, if the portfolio step is done.
5. Google last. It is the least gated and can be done in an afternoon.

---

## 5. What I build once each one lands

The same shape for all three, because they all feed one store.

**Per platform:**
- An OAuth start and callback route under `/oauth/<platform>/`, storing the
  refresh token through the existing `packages/db/src/secrets.ts` encryption.
  Nothing lands in plaintext and nothing lands in a config file.
- A token refresh job, because all three expire on different clocks.
- A sync job that writes into the **same `ExternalVideo` rows Zernio already
  writes**, keyed on `(socialAccountId, platformVideoId)`. Both sources describe
  the same post with the same platform id, so there is nothing to reconcile.
- A daily capture into `ExternalVideoMetric`, so history accumulates whichever
  source produced it.

**Shared, built once:**
- Per-field precedence: the platform API wins for any field it reports, Zernio
  fills the rest, and a field no source reports stays absent rather than zero.
- A per-field source record, so any surface can say where a number came from.
- Tables for the data that is not one number per video: retention curves,
  traffic sources, and audience demographics.

**What does not change:** Zernio stays. It is still how posts get published, and
it stays the floor for every account that has not been connected directly. An
account with no direct connection keeps working exactly as it does today.

See `docs/platform-capability-map.md` for exactly which metric comes from which
source, and `docs/superpowers/specs/2026-08-11-platform-metrics-phase-1-design.md`
for the store that all of this writes into.
