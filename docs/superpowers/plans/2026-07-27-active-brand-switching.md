# Active Brand Switching Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make switching the active brand fully switch the Create section (Upload & Schedule, Content Calendar, Workflows), per the approved spec `docs/superpowers/specs/2026-07-27-active-brand-create-section-design.md`.

**Architecture:** Five surgical fixes in the desktop app only. The server-side scoping is already correct; every change here is about selection state, screen remounting, and honest failure reporting. No database or API changes.

**Tech Stack:** React 18 + TypeScript (Vite), Tauri shell. State via the `useAppState()` context in `apps/desktop/src/state/AppState.tsx`. Toasts via `useToast()` from `apps/desktop/src/components/Toasts.tsx` (already imported in both screens being touched).

## Global Constraints

- The repo has **no test framework and must not gain one**. Runnable checks are `.check.ts` files under `tsx`; none of this plan's changes contain extractable pure logic, so verification is `pnpm --filter @toreroflow/desktop typecheck` per task plus the live walk in Task 6.
- **No em dashes** in any copy, comment, or doc text. Use commas, periods, or hyphens.
- **No AI attribution in commits.** No Co-Authored-By trailers, Tyrone's name only.
- Commit messages follow the repo style: lowercase `fix:` / `feat:` / `docs:` prefix, plain sentence.
- The API dev server hot-reloads; the desktop dev server is Vite on port 1420. Typecheck command: `pnpm --filter @toreroflow/desktop typecheck` (run from repo root `E:\Claude Stuff\Toreroflow`).

---

### Task 1: A newly onboarded brand becomes the active brand

**Files:**
- Modify: `apps/desktop/src/modals/ConnectClientModal.tsx:49-50`

**Interfaces:**
- Consumes: `selectClient(id: string | null)` from `useAppState()` (already destructured in this file).
- Produces: nothing new; behavior change only.

- [ ] **Step 1: Replace the first-brand-only guard**

In `createClient`, replace these two lines:

```tsx
      // First brand auto-selects so the rest of the app comes alive.
      if (clients.length === 0) selectClient(client.id);
```

with:

```tsx
      // A new brand becomes the active brand so the Create section lands on
      // its clean slate rather than staying on the previous brand.
      selectClient(client.id);
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @toreroflow/desktop typecheck`
Expected: exit 0, no output.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/modals/ConnectClientModal.tsx
git commit -m "fix: a newly onboarded brand becomes the active brand"
```

---

### Task 2: Fall back to the first brand when the selection is missing or stale

**Files:**
- Modify: `apps/desktop/src/state/AppState.tsx:97-103`

**Interfaces:**
- Consumes: `clients`, `selectedClientId`, `setSelectedClientId`, `SELECTED_KEY` (all already in scope in `AppStateProvider`).
- Produces: the guarantee later tasks rely on: whenever `clients.length > 0`, `selectedClientId` is a valid client id.

**Ordering note:** do NOT call `selectClient` inside this effect. `selectClient` is declared with `const` further down the file (line 141), so naming it in this effect's dependency array would read it before initialization at render time. Write the two lines directly, matching the effect being replaced.

- [ ] **Step 1: Replace the drop-to-null effect**

Replace this block:

```tsx
  // Drop the stored selection if the client no longer exists.
  useEffect(() => {
    if (selectedClientId && clients.length && !clients.some((c) => c.id === selectedClientId)) {
      setSelectedClientId(null);
      localStorage.removeItem(SELECTED_KEY);
    }
  }, [clients, selectedClientId]);
```

with:

```tsx
  // Keep a brand selected whenever brands exist. A missing or stale
  // selection falls back to the first brand instead of leaving every
  // client-scoped screen empty. The empty list is left alone on purpose:
  // at boot the list is empty while it loads, and clearing then would wipe
  // a valid stored selection.
  useEffect(() => {
    if (!clients.length) return;
    if (selectedClientId && clients.some((c) => c.id === selectedClientId)) return;
    const id = clients[0].id;
    setSelectedClientId(id);
    localStorage.setItem(SELECTED_KEY, id);
  }, [clients, selectedClientId]);
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @toreroflow/desktop typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/state/AppState.tsx
git commit -m "fix: fall back to the first brand when the selection is missing or stale"
```

---

### Task 3: Brand switch fully resets the Create screens

**Files:**
- Modify: `apps/desktop/src/App.tsx:40` (destructure), `apps/desktop/src/App.tsx:146-151` (upload, calendar), `apps/desktop/src/App.tsx:171` (workflows)

**Interfaces:**
- Consumes: `selectedClientId: string | null` from `useAppState()`.
- Produces: Upload & Schedule, Calendar, and Workflows remount whenever the active brand changes. Component state in those screens (typed drafts, open modals, calendar position, workflow form) resets on switch. Task 4 relies on this: within one mount of those screens the brand can never change.

- [ ] **Step 1: Pull `selectedClientId` into Shell**

Change line 40 from:

```tsx
  const { authReady, user } = useAppState();
```

to:

```tsx
  const { authReady, user, selectedClientId } = useAppState();
```

- [ ] **Step 2: Key the three Create screens on the brand**

Change:

```tsx
          {activeScreen === "upload" && (
            <UploadSchedule key="upload" onPreview={openPreview} onOpenConnect={openConnect} />
          )}
          {activeScreen === "calendar" && (
            <CalendarScreen key="calendar" onNewPost={() => setActiveScreen("upload")} />
          )}
```

to:

```tsx
          {activeScreen === "upload" && (
            <UploadSchedule
              key={`upload-${selectedClientId ?? "none"}`}
              onPreview={openPreview}
              onOpenConnect={openConnect}
            />
          )}
          {activeScreen === "calendar" && (
            <CalendarScreen
              key={`calendar-${selectedClientId ?? "none"}`}
              onNewPost={() => setActiveScreen("upload")}
            />
          )}
```

and change:

```tsx
          {activeScreen === "workflows" && <WorkflowsScreen key="workflows" />}
```

to:

```tsx
          {activeScreen === "workflows" && (
            <WorkflowsScreen key={`workflows-${selectedClientId ?? "none"}`} />
          )}
```

Leave Dashboard, Analytics, Reports, Overview, Financials, and Settings keys alone. They are agency-wide or manage their own switching.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @toreroflow/desktop typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/App.tsx
git commit -m "fix: brand switch fully resets the Create screens"
```

---

### Task 4: Announce first-load failures on Upload and Calendar

**Files:**
- Modify: `apps/desktop/src/screens/UploadSchedule.tsx:66-98` (`loadPosts`, `load`, and their effects)
- Modify: `apps/desktop/src/screens/CalendarScreen.tsx:86-107` (`load` and its effect)

**Interfaces:**
- Consumes: `toast.fail(what: string, error: unknown)` from `useToast()` (already called `toast` in both files); Task 3's remount guarantee.
- Produces: `load(opts?: { announce?: boolean })` signatures. Existing bare `void load()` and `void loadPosts()` call sites elsewhere in these files keep compiling because the parameter is optional, and they stay silent on purpose.

**Why this shape:** after Task 3, a screen's rows always belong to its own brand, so a failed background poll keeping old rows is safe and stays silent (matching the app's toast rule: toasts are for operator actions, polls are not). The first load of a mount IS an operator action (a brand switch or navigation), so only that failure toasts. Do not clear rows in the catch: on first load the state is already empty, and on a poll the rows on screen are correct.

- [ ] **Step 1: UploadSchedule, announce the first queue load**

Replace:

```tsx
  const loadPosts = useCallback(async () => {
    if (!selectedClient) {
      setPosts([]);
      return;
    }
    try {
      setPosts(await api.get<PostTargetInfo[]>(`/clients/${selectedClient.id}/posts`));
    } catch {
      // API offline: keep whatever we have
    }
  }, [selectedClient]);

  useEffect(() => {
    void loadPosts();
    const t = setInterval(() => void loadPosts(), 15_000);
    return () => clearInterval(t);
  }, [loadPosts]);
```

with:

```tsx
  const loadPosts = useCallback(
    async (opts?: { announce?: boolean }) => {
      if (!selectedClient) {
        setPosts([]);
        return;
      }
      try {
        setPosts(await api.get<PostTargetInfo[]>(`/clients/${selectedClient.id}/posts`));
      } catch (err) {
        // Polls stay silent: the rows on screen are this brand's own. The
        // first load of a mount follows a switch or navigation, so that
        // failure is announced.
        if (opts?.announce) toast.fail("Could not load the queue", err);
      }
    },
    [selectedClient, toast],
  );

  useEffect(() => {
    void loadPosts({ announce: true });
    const t = setInterval(() => void loadPosts(), 15_000);
    return () => clearInterval(t);
  }, [loadPosts]);
```

- [ ] **Step 2: UploadSchedule, announce the first media load**

Replace:

```tsx
  const load = useCallback(async () => {
    if (!selectedClient) {
      setAssets([]);
      return;
    }
    try {
      setAssets(await api.get<MediaAssetInfo[]>(`/clients/${selectedClient.id}/media`));
    } catch {
      // API offline: keep whatever we have
    }
  }, [selectedClient]);

  useEffect(() => {
    void load();
  }, [load]);
```

with:

```tsx
  const load = useCallback(
    async (opts?: { announce?: boolean }) => {
      if (!selectedClient) {
        setAssets([]);
        return;
      }
      try {
        setAssets(await api.get<MediaAssetInfo[]>(`/clients/${selectedClient.id}/media`));
      } catch (err) {
        if (opts?.announce) toast.fail("Could not load videos", err);
      }
    },
    [selectedClient, toast],
  );

  useEffect(() => {
    void load({ announce: true });
  }, [load]);
```

- [ ] **Step 3: CalendarScreen, announce the first calendar load**

Replace:

```tsx
  const load = useCallback(async () => {
    if (!selectedClient) {
      setTargets([]);
      return;
    }
    try {
      setTargets(
        await api.get<PostTargetInfo[]>(
          `/clients/${selectedClient.id}/posts?from=${rangeStart.toISOString()}&to=${rangeEnd.toISOString()}`,
        ),
      );
    } catch {
      // API offline: keep whatever we have
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedClient, view, anchor.getTime()]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);
```

with:

```tsx
  const load = useCallback(
    async (opts?: { announce?: boolean }) => {
      if (!selectedClient) {
        setTargets([]);
        return;
      }
      try {
        setTargets(
          await api.get<PostTargetInfo[]>(
            `/clients/${selectedClient.id}/posts?from=${rangeStart.toISOString()}&to=${rangeEnd.toISOString()}`,
          ),
        );
      } catch (err) {
        // Polls stay silent: the rows on screen are this brand's own. The
        // first load of a mount or a range change is operator-initiated, so
        // that failure is announced.
        if (opts?.announce) toast.fail("Could not load the calendar", err);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selectedClient, view, anchor.getTime(), toast],
  );

  useEffect(() => {
    void load({ announce: true });
    const t = setInterval(() => void load(), 15_000);
    return () => clearInterval(t);
  }, [load]);
```

Note: `load` is recreated when `view` or `anchor` changes, so navigating the calendar also announces a failure. That is correct, navigation is an operator action.

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @toreroflow/desktop typecheck`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src/screens/UploadSchedule.tsx apps/desktop/src/screens/CalendarScreen.tsx
git commit -m "fix: announce first-load failures on Upload and Calendar instead of failing silently"
```

---

### Task 5: The calendar brand chip tells the truth

**Files:**
- Modify: `apps/desktop/src/screens/CalendarScreen.tsx:286-289`

**Interfaces:**
- Consumes: `selectedClient` (already in scope).
- Produces: display change only.

Note: brands have no per-brand color in the data model (`ClientSummary` has `avatarSeed`, which is initials text). The chip keeps the accent-colored dot it already has; only the text changes. After Task 2, "No brand selected" can only appear when the agency has zero brands.

- [ ] **Step 1: Replace the fallback text**

Replace:

```tsx
          <div className="filterchip" style={{ opacity: 0.8 }}>
            <span className="d" style={{ background: "var(--v)" }} />{" "}
            {selectedClient?.name ?? "All brands"}
          </div>
```

with:

```tsx
          <div className="filterchip" style={{ opacity: 0.8 }}>
            <span className="d" style={{ background: "var(--v)" }} />{" "}
            {selectedClient?.name ?? "No brand selected"}
          </div>
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @toreroflow/desktop typecheck`
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add apps/desktop/src/screens/CalendarScreen.tsx
git commit -m "fix: calendar brand chip names the active brand instead of claiming All brands"
```

---

### Task 6: Live verification walk

**Files:** none modified. This is the spec's verification section executed against the running app.

**Interfaces:**
- Consumes: all five prior tasks; the running stack (Docker, API on 4700, Vite on 1420 or the rebuilt installed app).

Prereq: the full stack is running (`start.cmd` covers it). Verify in the Vite dev app at `http://localhost:1420` via the Browser pane; if the pane still blocks localhost, rebuild and use the installed app with the operator clicking through.

- [ ] **Step 1: Onboard a throwaway brand** named `ZZ Test Brand` from the sidebar's connect flow (no social accounts needed). Expect: it becomes the active brand immediately; Upload, Calendar, and Workflows show empty states; the quota widget shows its fresh quota.
- [ ] **Step 2: Switch back to Caleb.** Expect: his uploads, calendar posts, and workflows all present, exactly as before.
- [ ] **Step 3: Draft leak check.** On Caleb's Upload screen, type into a title field without saving, switch to `ZZ Test Brand`, then back. Expect: the typed text is gone, and nothing of Caleb's appears under the test brand.
- [ ] **Step 4: Modal check.** Open the schedule modal on Caleb, switch brands in the sidebar. Expect: the modal is gone after the switch.
- [ ] **Step 5: Failure honesty check.** Stop the API process, switch brands. Expect: empty screens plus an error toast naming what failed, never Caleb's rows under the test brand's name. Restart the API afterward and confirm data returns on the next switch or poll.
- [ ] **Step 6: Deletion fallback.** With `ZZ Test Brand` active, delete it from Settings. Expect: selection falls back to the first remaining brand automatically; Create screens show that brand's data with no manual re-selection.
- [ ] **Step 7: Chip check.** Confirm the calendar chip names the active brand. Confirm "No brand selected" never appears while any brand exists.
- [ ] **Step 8: Typecheck everything** with `pnpm -r typecheck` (all seven workspace projects). Expected: exit 0.
- [ ] **Step 9: Clean up.** Confirm `ZZ Test Brand` and any test rows it created are gone. Caleb's data untouched.
