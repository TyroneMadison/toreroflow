# Reading the app as an agent

What the web app (and the desktop app, which is the same page) exposes so a
bot can tell where it is and whether the screen has finished loading, without
reading pixels. Sign-in and the API are in [bot-api.md](bot-api.md).

## URLs

Every screen has its own path. The URL is the source of truth: opening one
directly, the browser's back and forward, and a copied link all work.

| Path | Screen | Slug |
|---|---|---|
| `/dashboard` | Dashboard | `dashboard` |
| `/financials` | Financials | `financials` |
| `/accounts` | Account Overview | `account-overview` |
| `/create/upload` | Upload & Schedule | `upload` |
| `/create/edit` | Edit | `edit` |
| `/calendar` | Calendar | `calendar` |
| `/create/carousels` | Carousels | `carousels` |
| `/create/workflows` | Workflows (its Overview area) | `workflows` |
| `/create/workflows/<area>` | Workflows, one area (desktop and web) | `workflows` |
| `/create/workflows/automations/<id>` | One automation in the editor | `workflows` |
| `/analytics` | Analytics | `analytics` |
| `/reports` | Reports | `reports` |
| `/settings` | Settings | `settings` |
| `/settings/<section>` | Settings, scrolled to one card | `settings` |

Settings sections: `general`, `accounts`, `business`, `updates`, `deploy`,
`operator`.

Workflows areas: `inbox`, `automations`, `ai-replies`, `contacts`, `metrics`,
`auto-post`. The area shows as `section` in the state below; the same paths
work on the phone, which shows the areas as chips under the title. The
Overview area (`workflows.overview`) shows the week's six Metrics numbers and
one card per area. The desktop rail's tails are live (`GET
/clients/:id/dm/summary`): unread, live automations, AI On / Drafts / Off,
contacts, Auto-post Running.

The AI replies area is `ai-replies` (`data-state` loading, error, empty or
ready; `data-ai` off, drafts, on or stopped): one switch per account in the
band (phone: `ai.accounts` opens `ai.accounts-sheet`), Needs you rows
`ai.queue.row` (phone "..." opens `ai.queue.menu`), the editors
`ai.edit.<knows|timing|never|handoff>` (dialogs `ai.knows`, `ai.timing` with
`ai.autopilot`, `ai.never`, `ai.handoff`, Save `ai.save`), `ai.test` (Try a
test message, `ai.test-dialog`, `ai.test.ask`) and the kill switch `ai.kill`.
AI replies are OFF for every account until a person turns one on, and drafts
only until someone picks "Send it on its own" in Reply timing (Instagram
through Torerone's Meta app only). In the Inbox an AI draft shows above the
composer (`dm-ai-draft`, `dm-ai-use`, `dm-ai-send`), "Draft with AI" is
`dm-ai-ask`, and Details has the per-chat switch `dm-ai-toggle` or
`dm-ai-resume` after a handoff (row `dm-ai-row`).

The Metrics area is `metrics` (`data-state` loading, error, empty or ready):
the six numbers `metrics.kpi.<received|people|contacts|reach|replyRate|ctr>`
pick what the chart shows, ranges `metrics.range.<7|30|90|all>`,
`metrics.account`; phone `metrics.filter-open` (sheet `metrics.filter`) and
`metrics.actions-open` (Export CSV, `metrics.actions`). `metrics.partial`
says when Zernio accounts count people only.

The Auto-post area is `auto-post`: the Drive band `drive-auto-post` (status
line `drive-auto-post.status`), `autopost.check`, `autopost.more` (connect,
copy link, sync, Stop), `autopost.edit` (dialog `autopost.settings`, Save
`autopost.save`), the fan-out rules (`workflow-new` opens `autopost.rules`;
rows `workflow-<id>`, `workflow-delete-<id>`, destinations
`workflow-dest-<platform>`, `workflow-create`). The rules are saved, not run.

The Automations area is `automations` (`data-state` loading, error, empty or
ready): rows `automations.row.<id>` (native automations by id, Zernio
campaigns by their Zernio id, under "Still at Zernio"), state tabs
`automations.tab.<all|live|draft|off>`, `automations.filter` (popover on
desktop, sheet on the phone), `automations.account`, `automations.new` (the
template picker `automations.new-modal` / `automations.new-sheet`, templates
`automations.template.<id>`, `automations.use-template`), `automations.trash`,
notices `automations.zernio-notice`, `automations.overlap` and
`automations.connect`, recent comments `automations.run`, the kill switch
`automations.kill`, Zernio leads `automations.leads`. One automation opens at
`/create/workflows/automations/<id>` (`automation-editor`): steps
`automation.step.<1-4>`, `automation.more`, `automation.publish` (dialog
`automation.publish-dialog`, `automation.pause-zernio`,
`automation.publish-confirm`), the post picker `automation.change-posts` /
`automations.posts` / `automations.post`, Test it `automation.test`,
`automation.get-code`, `automation.dry-run`, preview `automation.preview`.

The Inbox area (`dm-inbox`, with `data-state` loading, error, empty or ready)
lists Instagram and Messenger threads (`dm-thread-<threadId>`) and polls every
4 seconds while the page is visible. The open conversation is `dm-thread`
(messages `dm-message`, composer `dm-composer`, send `dm-send`, photo
`dm-attach`); a closed 24 hour window shows `dm-window-closed` and a viewer
sees `dm-readonly` instead of the composer. Details are `dm-details` (on the
phone in the sheet `dm-details-sheet`). Filters: `dm-tab-<all|active|paused|flagged|done>`,
`dm-search`, `dm-account-<accountId>`, `dm-unread`, `dm-stage-filter`,
`dm-tag-filter` (phone: `dm-filter` opens `dm-filter-sheet`). States:
`dm-connect` (the "Connect Instagram for DMs" card, whole area while there is
no conversation, one line above the list while an Instagram account still
reads through Zernio; `dm-connect-pending` while Torerone's Meta app is not
set up, docs/meta-instagram-setup.md), `dm-reconnect` (Instagram refused the
token), `dm-empty`, `dm-inbox.error` with `dm-retry`. `GET /dm/status?clientId=`
says which transport each account uses.

The Contacts area is `contacts` (rows `contact-<contactId>`, `contacts-search`,
`contacts-unread`, `contacts-stage-filter`, `contacts-account`,
`contacts-export`, the person panel `contacts-person` with `contacts-open`,
select mode `contacts-bulk` on desktop and `contacts-select` /
`contacts-selbar` on the phone, sheets `contacts-filter-sheet`,
`contacts-actions`, `contacts-tags`, `contacts-stage`).

`/` and any unknown path are replaced with `/dashboard` (no history entry);
an unknown Settings section opens `/settings`, an unknown Workflows area
`/create/workflows`. `/measure` (the old Measure tab, merged into Reports)
opens `/analytics`.

Query parameters, kept when you move between screens:

- `?client=<clientId>` - the active brand. Wins over the remembered one when
  the page loads. Switching brand in the app rewrites it in place.
- `?range=30|60|90` - the period on the Dashboard and Analytics. Analytics
  also takes `7` and `all`; the Dashboard reads anything else as 30.
- `?automation=1` - automation mode: no animation, no blur (html
  `data-motion="reduced"` and `data-glass="low"`). Remembered; `?automation=0`
  forgets it.
- `#token=<BOT_TOKEN>` - signs in, then is scrubbed from the address bar.
  Works on any path.

Source: `apps/desktop/src/lib/routes.ts`. Real paths need the server to send
`index.html` for unknown paths; the web container's Caddy does
(`try_files {path} /index.html`) and so does Tauri's asset resolver. If a
shell ever cannot, `HASH_ROUTES` in routes.ts switches to `#/dashboard` URLs.

## html attributes

On `document.documentElement`, kept current:

| Attribute | Value |
|---|---|
| `data-screen` | the screen's slug |
| `data-section` | Settings section, absent otherwise |
| `data-client` | active brand id, absent when none |
| `data-range` | `?range` value, absent when unset |
| `data-api` | `up` or `down`, from the `/health` poll every 15s (reads `down` for a moment at startup) |
| `data-busy` | `true` while any API request made through the app's client is in flight |

## The state object

`window.__TOREROFLOW_STATE__`, a frozen, read-only snapshot replaced on every
change. Each change also fires `toreroflow:state` on `window` with the
snapshot as `event.detail`.

```ts
{
  version: 1,
  route: "/create/upload",      // path only
  screen: "upload",             // slug, as above
  section: null,                // Settings section or null
  clientId: "c_123" | null,
  clientName: "Caleb" | null,
  range: 7 | 30 | 60 | 90 | "all" | null,
  apiUp: true,
  busy: false,
  user: { role: "owner" } | null,  // null when signed out
  lastError: "/clients/c_123/posts: request failed (500)" | null,
}
```

`lastError` is the last failed API request, path then message, and is not
cleared by later successes. It never carries a query string, a token or any
other credential; the object is built from an allow-list
(`lib/agentState.ts`, checked by `agentState.check.ts`).

```js
// Wait for a screen to settle.
await page.waitForSelector('html[data-screen="upload"][data-busy="false"]');
await page.waitForSelector('main [data-state="ready"]');
```

## Screen states

Every screen's root carries `data-state`: `loading`, `empty`, `error` or
`ready`. The not-ready states are shared components with stable test ids:

- `<screen>.loading` - glass skeleton, `aria-busy="true"`
- `<screen>.empty` - nothing to show yet (usually no brand selected)
- `<screen>.error` - the screen's data did not load; `<screen>.retry` tries again

`<screen>` is the slug. A screen in `error` can still show panels that load
on their own (Workflows' DM sections, Upload's drop zones).

## Test ids

`data-testid` follows `area.thing[.id]`:

- `nav.section.<overview|create|reports|settings>` - dock tabs (links). A
  click reopens the last page used in that tab (else its first page); hover
  or keyboard focus opens its drop-up menu `nav.menu.<tab>`
- `nav.page.<slug>` - pages in the dock menus (links, hidden until the menu
  opens; opening the page's URL directly is the reliable route)
- `settings.section.<section>` - Settings cards in the Settings dock menu (links)
- `workflows.area.<overview|inbox|automations|ai-replies|contacts|metrics|auto-post>` -
  the Workflows rail (desktop and web)
- `page.crumb` - the breadcrumb over each desktop page title
- `nav.alerts`, `nav.api-status`, `theme.toggle`
- `brand-switcher.open`, `brand-switcher.option.<clientId>`, `brand-switcher.add-client`
- per screen: `dashboard.range.<30|60|90>`, `analytics.range.<7|30|60|90|all>`,
  `dashboard.refresh`, `analytics.refresh`, `calendar.new-post`,
  `carousels.upload-images`, `settings.automation`, and the states above

Dock sections and tabs are real `<a href>` links: a plain click navigates in
place, middle-click or ctrl-click opens a new tab.
