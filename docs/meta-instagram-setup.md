# Instagram DMs through Torerone's own Meta app: setup

Toreroflow reads and answers Instagram DMs through Torerone's own Meta app,
using **Instagram API with Instagram Login** (graph.instagram.com). Until the
steps below are done the feature is **dark**: the webhook and connect
endpoints answer `503 {"reason":"instagram_not_configured"}`, the Workflows
Inbox shows a "Connect Instagram for DMs" card with the button switched off,
and every DM keeps coming through Zernio exactly as before. Facebook
Messenger always stays on Zernio, reply only.

Nothing here needs a code change. It is Meta's dashboard, three values in the
server's `infra/.env`, and a redeploy.

## What the server already has

| Name | State |
|---|---|
| `META_VERIFY_TOKEN` | Generated on the server (random, 32 bytes). You copy it into Meta in step 5 |
| `OAUTH_REDIRECT_BASE` | `https://api.torerone.com` |
| `META_APP_ID`, `META_APP_SECRET`, `META_LOGIN_CONFIG_ID` | The existing Facebook Login for Business app (insights). Not used for DMs, except that `META_APP_SECRET` is also accepted as a webhook signing key |
| `META_IG_APP_ID`, `META_IG_APP_SECRET` | **Missing.** You add them in step 4 |
| `META_IG_HUMAN_AGENT` | Optional. `1` only after Meta approves the Human Agent feature (step 9) |

To read the verify token on the server without it landing in a log or a chat:
`sudo grep '^META_VERIFY_TOKEN=' /opt/toreroflow/infra/.env` in your own SSH
session, then paste it straight into Meta.

## The addresses Meta asks for

| Field in Meta | Value |
|---|---|
| Webhook callback URL | `https://api.torerone.com/webhooks/meta` |
| Webhook verify token | the server's `META_VERIFY_TOKEN` |
| OAuth redirect URI (Business login settings) | `https://api.torerone.com/oauth/instagram/callback` |
| Deauthorize callback URL | `https://api.torerone.com/webhooks/meta/deauthorize` |
| Data deletion request URL | `https://api.torerone.com/webhooks/meta/data-deletion` |

## Steps in Meta's developer dashboard

Meta moves labels around. If one is not where a step says, look for the
nearest match on the same page.

1. **Open the app.** developers.facebook.com/apps, signed in with the Facebook
   account that administers Torerone's Business Portfolio. Use the existing
   Torerone app (the one whose id is `META_APP_ID`), so insights and DMs live
   in one app under one Business Portfolio. A new app also works: Create app,
   use case "Other", type "Business", and connect it to the Torerone Business
   Portfolio.
2. **Add the Instagram product.** Add product, Instagram, then
   **API setup with Instagram login**. (Not "API setup with Facebook login":
   that is the insights flow and a different token.)
3. **Permissions.** On the same page, make sure these are listed for the app:
   `instagram_business_basic`, `instagram_business_manage_messages`,
   `instagram_business_manage_comments`. Toreroflow asks for exactly these
   three when an account connects.
4. **Copy the Instagram app ID and Instagram app secret** shown on that page
   (they are not the Facebook app id and secret). On the server:
   ```
   sudo nano /opt/toreroflow/infra/.env
   ```
   add (or fill in)
   ```
   META_IG_APP_ID=<Instagram app ID>
   META_IG_APP_SECRET=<Instagram app secret>
   ```
   save, keep the file `chmod 600`, then redeploy so the containers read it:
   `sudo touch /opt/toreroflow/deploy/request` (about 13 minutes). Check it
   took: `GET https://api.torerone.com/webhooks/meta` now answers `403`
   instead of `503`. Do this **before** step 5, because Meta calls the
   webhook the moment you press Verify.
5. **Configure webhooks** (step 2 of the Instagram login setup page):
   callback URL and verify token from the table above, **Verify and save**.
   Then subscribe these fields: `messages`, `messaging_postbacks`,
   `messaging_seen`, `message_reactions`, `comments`, `live_comments`.
   (`message_edit` and `messaging_referral` are fine to add too; edits are
   understood.)
6. **Set up Instagram business login** (unfold the section first; its button
   does nothing while folded), Business login settings:
   OAuth redirect URI, deauthorize callback URL and data deletion request URL
   from the table above. Save.
7. **App settings, Basic:** app domain `torerone.com` (and `api.torerone.com`
   if it asks for the exact host), a privacy policy URL, terms URL, the data
   deletion callback URL from the table, a category and an icon. Save. Meta
   will not let the app go Live without these.
8. **Who can connect, Standard vs Advanced access:**
   - **Standard Access (no App Review)** covers Instagram accounts that have a
     role on the app. For each client account: App roles, Roles,
     **Instagram Testers**, add the account's username. The account owner
     accepts it in Instagram: Settings, Website permissions (or Apps and
     websites), Tester invites. Accounts in Torerone's Business Portfolio
     with a role there also count.
   - **Advanced Access (App Review)** is needed to connect accounts that have
     no role on the app. Request Advanced Access for the three permissions
     above in App Review, with a screencast of the connect flow and a reply
     sent from the Toreroflow inbox. Business verification of the Business
     Portfolio is a prerequisite. Allow 1 to 4 weeks.
9. **Switch the app to Live** (top of the dashboard). Development mode only
   delivers webhooks for app roles' own test messages. Meta may ask for a
   data use checkup first. Optional, later: request the **Human Agent**
   feature in App Review; once approved set `META_IG_HUMAN_AGENT=1` and
   redeploy, and replies are allowed up to 7 days after a person's last
   message instead of 24 hours.

## Each client's Instagram account

- Must be a **professional account** (Business or Creator). Personal
  accounts cannot use the messaging API.
- In the Instagram app: Settings, Messages and story replies, Message
  controls, **Connected tools: Allow access to messages** must be on.
  Without it the connect succeeds but no message ever arrives.
- If another tool owns the inbox (ManyChat and similar), Instagram may route
  messages to it first. Zernio keeps working alongside.

## Connecting an account

Workflows, Inbox, pick the brand. The "Connect Instagram for DMs" card is now
enabled: **Connect Instagram** opens Instagram's sign-in and copies the link
(good for 7 days) so it can be sent to the client to sign in on their own
phone. Sign in as the account named on the card; a different account is
refused by name. On success the account's recent conversations import within
a minute, new messages arrive by webhook, a missed-DM sync runs every 5
minutes, and the 60-day token renews itself daily when it gets within 30
days of expiry.

## Checking it works

- `GET https://api.torerone.com/dm/status?clientId=<id>` (signed in) shows
  `native.configured: true`, the account with `transport: "native"`,
  `lastWebhookAt` after a test DM.
- `native.lastBadSignatureAt` set and no messages: the app secret on the
  server does not match the app that sends the webhooks (step 4).
- Nothing arrives at all: the app is not Live (step 9), the webhook fields
  are not subscribed (step 5), or "Allow access to messages" is off.
- A token Instagram stops accepting (password change, app removed) marks the
  account revoked, raises an alert and the card asks to reconnect.

## Automations (F4)

Comment-to-DM, story reply, story mention, DM keyword and welcome
automations run on the same connection: nothing more to set up in Meta's
dashboard once the steps above are done, as long as the `comments` and
`live_comments` webhook fields are subscribed (step 5) and the account
granted `instagram_business_manage_comments` (step 3; the private reply to a
comment and the public reply under it both need it).

What to know before turning one on:

- Nothing sends until the account is connected here (transport `native`) and
  the automation is Live. Drafts and Live automations on an account still on
  Zernio show "Waits for Instagram" and wait.
- Meta's rules the server applies: one private reply per comment, within 7
  days of it; a DM answer only inside the 24 hour window; no HUMAN_AGENT tag
  on an automated message; about 700 automated sends an hour per account
  (Meta allows 750 private replies), the rest wait in a queue.
- Each account has a kill switch (Automations > Recent comments > Pause all):
  while it is on, nothing on that account sends.
- `DM_AUTOMATIONS_DRY_RUN=1` in `infra/.env` (worker) makes every automation
  match and record what it would have sent ("Dry run" in Recent comments)
  without calling Instagram. Leave it unset for real sends.
- A Zernio campaign answering the same keyword on the same account would send
  a second DM. The Automations list warns about each overlap, and Publish
  offers to pause the Zernio campaign; nothing at Zernio is paused unless you
  tick it. Move to native recreates a Zernio campaign here as a draft once its
  Instagram account is connected; Messenger campaigns stay at Zernio.
