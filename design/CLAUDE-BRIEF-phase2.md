# Claude Code prompt: Toreroflow redesign, Phase 2 (real routes and agent-readable state)

Run from `E:\Claude Stuff\Toreroflow` with Tyrone's Claude subscription. All work stays inside this repo.

---

Phase 1 (Clear Glass tokens, the dock frame and the Dashboard) is live as `0c1eab2`. This session is **Phase 2** of `REDESIGN-PLAN` (see `design/CLAUDE-BRIEF-phase1.md` for the design context). Read `.claude-session-history.md` first and follow its conventions. **Commit locally on `main` when all checks pass. Never push or deploy.** Don't check out or merge the `phase1-first-attempt` branch.

## Goals
1. **Real URLs per page and section.** Today `App.tsx` switches screens with `useState<ScreenId>`, so the URL stays `/`. Add a small router with no new dependencies (History API plus `popstate`), built on the existing map in `src/lib/nav.ts`. Put it in `src/lib/routes.ts` with a `useRoute()` hook.
   - Paths: `/dashboard`, `/financials`, `/accounts`, `/create/upload`, `/create/edit`, `/calendar`, `/create/carousels`, `/create/workflows`, `/analytics`, `/reports`, `/settings`, plus `/settings/:section` where Settings already has sections. `/` and unknown paths go to `/dashboard` with `replaceState`.
   - Dock sections, page tabs and the in-app jumps that call `setActiveScreen(...)` today (e.g. Calendar's "new post", Carousels' "upload images") all navigate through the router. Use real `<a href>` with click interception so middle-click and copying links work in the browser.
   - Browser back and forward must work.
   - **Tauri:** the desktop app has to keep working. Check `src-tauri/tauri.conf.json` and how the window loads (dev `http://localhost:1420`, production bundled assets). If deep paths don't resolve in the bundled build, fall back to hash-based paths in Tauri only (`#/dashboard`), behind one switch in `routes.ts`.
   - **Web:** find out how app.torerone.com serves the SPA (look in `infra/`, e.g. the Caddyfile or the web container config, and in `apps/api/src/server.ts` fastifyStatic). Add the SPA fallback so deep links like `/create/upload` serve `index.html`. Keep the change minimal and explain it in the summary, because it ships with the next deploy.
2. **URL state for brand and period:** `?client=<id>` stays in sync with `selectClient` (it wins over localStorage on load). `?range=30|60|90` drives the Dashboard and Analytics period wherever there is a range control. Both are added or updated with `replaceState`.
3. **Keep the `#token=` bot login** in `main.tsx` exactly as it works now. The token is read and scrubbed before the router runs, and that must still work on deep links such as `/create/upload#token=…`. Add a check for this.
4. **State agents can read:**
   - `document.documentElement` carries `data-screen`, `data-section`, `data-client`, `data-range`, `data-api="up|down"` and `data-busy="true|false"`, kept in sync.
   - A read-only, frozen snapshot at `window.__TOREROFLOW_STATE__` = `{ version: 1, route, screen, section, clientId, clientName, range, apiUp, busy, user: { role }, lastError }`, updated on every change. It also fires a `toreroflow:state` CustomEvent on `window`. Never put tokens or secrets in it.
   - Document it in a new `docs/agent-state.md` and link it from `docs/bot-api.md` (the URLs, attributes, state object, testid naming, and the automation mode from Phase 1).
5. **Shared loading, empty and error states on every screen:** create `src/components/states/` with `<Loading>` (a glass skeleton, `aria-busy`), `<Empty title hint action>` and `<ErrorState message onRetry>`. Each sets `data-state="loading|empty|error"` and has a stable `data-testid` (`<screen>.loading`, `<screen>.empty`, `<screen>.error`), and the ready content root sets `data-state="ready"`. Apply them to all 11 screens (Dashboard already has its own; move it onto the shared components). Track the busy flag through a small counter in AppState or the api client, so `data-busy` stays accurate.
6. **Testids:** every interactive element touched in this phase gets a `data-testid` in the `area.thing[.id]` style. Links in the dock and page tabs get `nav.section.<id>` and `nav.page.<screen>`.

## Checks
- Add `src/lib/routes.check.ts` (path↔screen round-trip, unknown path → dashboard, query parsing, `#token` on a deep link), `src/lib/agentState.check.ts` (snapshot shape, no token fields) and add both to the desktop `test` script.
- Run `pnpm --filter @toreroflow/desktop typecheck`, `test` and `build`. Run the api `typecheck` and `test` too if you touch the api or infra.
- Preview with the existing `storage/preview/serve-phase1.mjs` and `shots-phase1.mjs` harness (copy and adapt them as `*-phase2.mjs`, and make sure the preview server also serves deep links). Save at least `storage/preview/phase2-deeplink-upload.png` (loading `/create/upload?client=<id>` directly) and `storage/preview/phase2-dashboard-range90.png` (`/dashboard?range=90`). In the script, also check that `window.__TOREROFLOW_STATE__` matches the URL, and that back/forward works.
- Add an entry to `.claude-session-history.md`.

At the end, summarize the changed files, the commit hash and anything that needs a server-side change on the next deploy.
