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
| `/create/workflows` | Workflows | `workflows` |
| `/analytics` | Analytics | `analytics` |
| `/reports` | Reports | `reports` |
| `/settings` | Settings | `settings` |
| `/settings/<section>` | Settings, scrolled to one card | `settings` |

Settings sections: `general`, `accounts`, `business`, `updates`, `deploy`,
`operator`.

`/` and any unknown path are replaced with `/dashboard` (no history entry);
an unknown Settings section opens `/settings`.

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

- `nav.section.<overview|create|measure|settings>` - dock sections (links)
- `nav.page.<slug>` - page tabs (links)
- `settings.section.<section>` - Settings section tabs (links)
- `nav.alerts`, `nav.api-status`, `theme.toggle`
- `brand-switcher.open`, `brand-switcher.option.<clientId>`, `brand-switcher.add-client`
- per screen: `dashboard.range.<30|60|90>`, `analytics.range.<7|30|60|90|all>`,
  `dashboard.refresh`, `analytics.refresh`, `calendar.new-post`,
  `carousels.upload-images`, `settings.automation`, and the states above

Dock sections and tabs are real `<a href>` links: a plain click navigates in
place, middle-click or ctrl-click opens a new tab.
