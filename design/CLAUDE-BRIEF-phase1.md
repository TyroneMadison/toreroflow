# Claude Code prompt: Toreroflow redesign, Phase 1

Run on Tyrone's PC with his Claude subscription: open a terminal, `cd "E:\Claude Stuff\Toreroflow"`, start `claude`, and paste everything below the line. (Pasting it into the pinned "ToreroFlow App" chat also works, as long as that session is Claude Code running in this folder.) All work stays inside `E:\Claude Stuff\Toreroflow`.

> Before you run it: put the approved mockup at `E:\Claude Stuff\Toreroflow\design\mockup-03-clear-glass.html` (Tyrone or Grok Bot will do this; it is the self-contained HTML from mockup #3). Optional: put `mockup.png` next to it as `design/mockup-03-clear-glass.png`.

---

We're redesigning the whole Toreroflow desktop/web app with the approved **"Clear Glass"** look, and making it easy for AI bots (Grok bots drive it through the browser and the API). This session is **Phase 1 only: design tokens, the app frame and the Dashboard.** Please read `.claude-session-history.md` first and follow its conventions (checks, the `storage/preview/` preview trick, the deploy trigger). **Don't deploy until I say so.**

**Visual source of truth:** `design/mockup-03-clear-glass.html` (+ `.png`). Open it, and copy its CSS and markup patterns instead of approximating them. Earlier design files (`design/toreroflow-liquid-glass-v4.html`, root `07-24-2026-*liquid-glass*.html`) are superseded.

## Stack facts (already checked)
- Frontend: `apps/desktop` (React 18, Vite 6 on :1420, Tauri 2). The same build serves app.torerone.com. No router, no Tailwind.
- Styles: everything is in `apps/desktop/src/styles.css` (~130 KB) using CSS variables (`--glass*`, `--brd`, `--v`, `--radius`, `--lg-rim`, `--lg-sheen`, `--dur-*`). Theme is set by `data-theme` from `src/lib/theme.ts`.
- Frame: `src/App.tsx` renders `Sidebar` (`src/components/Sidebar.tsx`) plus `<main className="main glass">`. The background comes from `.field .blob.b1/.b2` and `.grain`. Screens are switched with `useState<ScreenId>`.
- Dashboard: `src/screens/DashboardScreen.tsx` gets `/clients/:id/analytics?days=` per client and uses `Pf`, `DataProvenance` and `useAppState().clients`. The chart component is `src/components/ViewsChart.tsx`. API status is in `src/components/ApiStatus.tsx`.

## Tasks
1. **Tokens:** create `apps/desktop/src/styles/tokens.css` (import it before `styles.css` in `src/main.tsx`).
   - Accent `#FF7A66` (hi `#FF9A88`, lo `#E2523E`, on-accent `#2A0C06`). Data colors: ok `#4ADE9A`, bad `#F0506E`, info `#4C9DFF`, warn `#E0A458`.
   - Text `#fff`, `.72`, `.55`. Radii 28, 26, 16 and 999.
   - Glass layers `.glass-z1` / `.glass-z2` / `.glass-z3`, built exactly like `.g` / `.g2` in the mockup:
     - low white gradient fill (4–13%)
     - backdrop blur 28/14/40px with saturate 180/160/200%
     - a gradient rim drawn with a `::before` mask, brightest at the top-left
     - a `::after` sheen
     - an inset highlight and an inner glow
     - stacked shadows
   - Point the old variables (`--v`, `--glass`, `--brd`, …) at the new tokens so other screens keep working.
2. **Background field:** replace `.field` blobs with the mockup's `.bg` (coral, maroon, deep blue, violet and rose radial blobs, blur 70px, saturate 130%) plus the vignette. Keep `.grain` only if it doesn't muddy it. Also add a light-theme version (pastel blobs, glass fill around 45% white).
3. **Bottom dock:** create `src/components/Dock.tsx` to replace `<Sidebar>` in `App.tsx`.
   - Sections Overview / Create / Measure / Settings, with the active one filled coral like `.di.on`.
   - On the left, API status (reuse the `ApiStatus` logic). On the right, the theme toggle and the brand switcher (avatar, name, "Active brand ▾") opening a z3 menu wired to `selectClient`.
   - Carry over the sidebar's alert count, report bell and "Connect client" entry as dock badges or menu items.
   - Keep the `Sidebar.tsx` file for now, but don't render it.
4. **Page header:** create `src/components/PageHeader.tsx`. Logo mark and h1 with a subtitle on the left, the section's page tabs (`role="tablist"`) as a z1 pill in the center, and a `controls` slot on the right.
   - Section → pages: Overview = Dashboard, Financials, Account Overview · Create = Upload & Schedule, Edit, Calendar, Carousels, Workflows · Measure = Analytics, Reports · Settings = Settings.
   - Each screen renders its own header. For the other screens in Phase 1, just wrap them in the header and frame and make sure they still render.
5. **Dashboard:** rebuild `DashboardScreen.tsx` to match the mockup.
   - Header controls: 30d/60d/90d pill (existing `RANGES`), Refresh, Export report, and a coral "+ Add client" (`onOpenConnect`).
   - 3-column brand cards (glass-z1): avatar, name, "N connected platforms", platform chips (`Pf`), a sparkline with the % change against the previous period (computed from the analytics response; leave it out if the series isn't available), and 4 glass-z2 tiles: Views, Retention, Likes, Comments. Clicking a card calls `onOpenInsights`.
   - Below the cards, a "Views over time · all brands" chart card that **fills the remaining height with no empty band**, with a legend in brand colors and an area fill. Reuse or extend `ViewsChart`.
   - Keep `DataProvenance` as a small footer.
   - Add loading (skeleton, `aria-busy`), empty ("No brands yet → Add client") and error (retry) states, using `data-state="loading|empty|ready|error"`.
6. **Things for AI bots in Phase 1** (everything touched):
   - `data-testid` on every interactive element and card, named `area.thing[.id]` (`nav.section.overview`, `nav.page.dashboard`, `dashboard.range.30`, `dashboard.refresh`, `dashboard.export`, `dashboard.add-client`, `dashboard.brand-card.<clientId>`, `brand-switcher.open`, `brand-switcher.option.<clientId>`, `theme.toggle`).
   - `aria-label` on icon-only buttons.
   - `<nav aria-label="Primary">` for the dock, a single `<main>` and `<h1>`, cards as `<section aria-labelledby>`, tiles as `<dl>`, and the chart with `role="img"` plus a summary `aria-label`.
   - Automation mode: `html[data-motion="reduced"]` and `html[data-glass="low"]` (blur turned off and replaced by solid tinted fills ~80%), switched on by `prefers-reduced-motion`, by `?automation=1` (saved in localStorage) or by a Settings toggle. Put the logic in `src/lib/theme.ts` next to the theme.
   - Keep the `#token=` hand-off in `main.tsx` exactly as it is.
7. **Checks:**
   - Add `src/lib/automation.check.ts` (query param → attributes) and add it to the desktop `test` script.
   - Run `pnpm --filter @toreroflow/desktop typecheck` and `test`.
   - Preview through `storage/preview/` at 1600×1000 in normal and `?automation=1` mode, and compare with `design/mockup-03-clear-glass.png`. Fix overflow, clipping or empty bands.
   - Then append a short entry to `.claude-session-history.md`.

## Out of scope for this session (later phases)
Real URL routes (`/dashboard`, `/create/upload`, …) with an SPA fallback, `window.__TOREROFLOW__` state, restyling the other pages, OpenAPI with `@fastify/swagger`, idempotency keys with dry-run and confirm, and an MCP server. Don't start them, but don't make choices that block them. For example, keep ScreenId ↔ section mapping in one place (`src/lib/nav.ts`) so the router can reuse it.

When you're done, show me the screenshots and a short summary of the changed files and the commit hash. Don't deploy.
