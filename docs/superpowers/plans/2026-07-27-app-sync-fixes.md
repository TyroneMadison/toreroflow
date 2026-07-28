# App Sync Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Part B of `docs/superpowers/specs/2026-07-27-onboarding-funnel-and-sync-design.md`: the seven propagation fixes so the whole app notices a newly onboarded brand and fulfilment billing stops treating target-less clients as delivered.

**Architecture:** Six desktop fixes ride the existing context mechanism (every `refreshClients()` replaces `clients[]`, so adding `clients` to an effect's dependencies makes a screen refetch on any client change) plus one focus listener in the connect modal. The seventh fix is a pure `quotaMet` rule extracted into `apps/api/src/financials/month.ts` with check coverage, consumed by the month route.

**Tech Stack:** React 18 + TypeScript in apps/desktop; Fastify in apps/api; checks are `.check.ts` under tsx.

## Global Constraints

- Repo: `E:\Claude Stuff\Toreroflow`, direct commits to main, lowercase `fix:` prefixes, no AI attribution or Co-Authored-By trailers, no em dashes anywhere.
- No test framework; gates are `pnpm --filter @toreroflow/desktop typecheck`, `pnpm --filter @toreroflow/api typecheck`, `pnpm --filter @toreroflow/api test`, `pnpm --filter @toreroflow/desktop test`, plus the live walk in Task 4.
- Refetch-on-clients-change effects must be silent refreshes (no loading flicker on screens that already show data).

---

### Task 1: Context-driven refetches (Overview, Financials, Reports, price-save staleness)

**Files:**
- Modify: `apps/desktop/src/screens/AccountOverviewScreen.tsx` (the `load`/effect block near lines 160-176 and the screen component's hooks)
- Modify: `apps/desktop/src/screens/FinancialsScreen.tsx` (add a clients-change refresh effect)
- Modify: `apps/desktop/src/screens/ReportsScreen.tsx` (the `loadPublishing` effect near lines 210-212)
- Modify: `apps/desktop/src/components/finance/RevenueSection.tsx` (`savePrice`)

**Interfaces:**
- Consumes: `useAppState().clients` and `refreshClients` (existing context).
- Produces: behavior only.

- [ ] **Step 1: AccountOverviewScreen reacts to client changes**

Add the context import (the file does not use `useAppState` today; add to the existing import block):

```tsx
import { useAppState } from "../state/AppState";
```

Inside the screen component, after `const toast = useToast();`:

```tsx
  const { clients: knownClients } = useAppState();
```

Replace the mount-only effect

```tsx
  useEffect(() => {
    void load();
  }, [load]);
```

with:

```tsx
  // Refetch whenever the client list changes (enroll, connect, sync), so a
  // brand onboarded mid-session shows up here without navigating away. The
  // array identity changes on every refreshClients, which is exactly the
  // signal wanted.
  useEffect(() => {
    void load();
  }, [load, knownClients]);
```

- [ ] **Step 2: FinancialsScreen refreshes on client changes**

In `apps/desktop/src/screens/FinancialsScreen.tsx`, add to the imports:

```tsx
import { useAppState } from "../state/AppState";
```

Inside the component, after `const toast = useToast();`:

```tsx
  const { clients: knownClients } = useAppState();
```

After the existing `refresh` callback definition, add:

```tsx
  // The RevenueSection's unpriced list already tracks the client context;
  // this keeps the totals, donut, and charts in step with it when a client
  // is added or priced mid-session. Skipped before first load so the mount
  // does not double-fetch.
  useEffect(() => {
    if (data) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [knownClients]);
```

- [ ] **Step 3: ReportsScreen re-reads publishing state on client changes**

In `apps/desktop/src/screens/ReportsScreen.tsx`, replace

```tsx
  useEffect(() => {
    void loadPublishing();
  }, [loadPublishing]);
```

with:

```tsx
  // A new client gets its permanent report slug at create; re-reading when
  // the client list changes makes the link visible without a remount.
  useEffect(() => {
    void loadPublishing();
  }, [loadPublishing, clients]);
```

(`clients` is already destructured from `useAppState()` at the top of the component.)

- [ ] **Step 4: savePrice refreshes the client context**

In `apps/desktop/src/components/finance/RevenueSection.tsx`, change the destructuring

```tsx
  const { clients } = useAppState();
```

to

```tsx
  const { clients, refreshClients } = useAppState();
```

and in `savePrice`, after the `await api.patch(...)` call and before `setDrafts`, add:

```tsx
      // The delete button's resurrect guard reads the standing price from
      // context; without this refresh it would offer delete on a row the
      // month seeder immediately recreates.
      await refreshClients();
```

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm --filter @toreroflow/desktop typecheck`
Expected: exit 0.

```bash
git add apps/desktop/src/screens/AccountOverviewScreen.tsx apps/desktop/src/screens/FinancialsScreen.tsx apps/desktop/src/screens/ReportsScreen.tsx apps/desktop/src/components/finance/RevenueSection.tsx
git commit -m "fix: overview, financials, and reports notice client changes without a remount"
```

---

### Task 2: Settings auto-sync covers late arrivals; connect modal syncs on focus return

**Files:**
- Modify: `apps/desktop/src/screens/SettingsScreen.tsx` (the auto-sync effect near lines 336-356)
- Modify: `apps/desktop/src/modals/ConnectClientModal.tsx` (`syncAccounts` and a focus effect)

**Interfaces:**
- Consumes: existing context; `POST /clients/:id/accounts/sync`.
- Produces: behavior only.

- [ ] **Step 1: Per-client auto-sync latch in Settings**

Replace

```tsx
  const autoSynced = useRef(false);
```

with

```tsx
  const autoSynced = useRef(new Set<string>());
```

and replace the auto-sync effect

```tsx
  // Pull provider-side connections in automatically when Settings opens.
  useEffect(() => {
    if (autoSynced.current || !clients.length) return;
    autoSynced.current = true;
    void (async () => {
      for (const client of clients) {
        try {
          await api.post(`/clients/${client.id}/accounts/sync`, {});
        } catch {
          // provider may be unset; manual sync still available
        }
      }
      await refreshClients();
    })();
  }, [clients, refreshClients]);
```

with:

```tsx
  // Pull provider-side connections in automatically when Settings opens,
  // and again for any client that appears while it stays open. The latch is
  // per client id, so enrolling a brand mid-visit still gets its sync; the
  // ids are added before the requests so the refresh at the end cannot
  // retrigger the effect into a loop.
  useEffect(() => {
    const unsynced = clients.filter((c) => !autoSynced.current.has(c.id));
    if (!unsynced.length) return;
    for (const c of unsynced) autoSynced.current.add(c.id);
    void (async () => {
      for (const client of unsynced) {
        try {
          await api.post(`/clients/${client.id}/accounts/sync`, {});
        } catch {
          // provider may be unset; manual sync still available
        }
      }
      await refreshClients();
    })();
  }, [clients, refreshClients]);
```

- [ ] **Step 2: Connect modal syncs when the window regains focus**

In `apps/desktop/src/modals/ConnectClientModal.tsx`:

Change the react import to include `useCallback`:

```tsx
import { useCallback, useEffect, useState } from "react";
```

Convert `syncAccounts` to a `useCallback` (same body):

```tsx
  const syncAccounts = useCallback(async () => {
    if (!clientId) return;
    setBusy("sync");
    setError(null);
    try {
      await api.post(`/clients/${clientId}/accounts/sync`, {});
      await refreshClients();
      setAwaitingAuth(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "sync failed");
    } finally {
      setBusy(null);
    }
  }, [clientId, refreshClients]);
```

After it, add the focus effect:

```tsx
  // Finishing a platform login happens in the external browser; coming back
  // to this window is the natural moment the accounts are ready, so sync
  // then instead of waiting for a manual click. The button stays as a
  // backstop for a login completed without the window ever losing focus.
  useEffect(() => {
    if (!awaitingAuth) return;
    const onFocus = () => void syncAccounts();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [awaitingAuth, syncAccounts]);
```

- [ ] **Step 3: Typecheck and commit**

Run: `pnpm --filter @toreroflow/desktop typecheck`
Expected: exit 0.

```bash
git add apps/desktop/src/screens/SettingsScreen.tsx apps/desktop/src/modals/ConnectClientModal.tsx
git commit -m "fix: settings auto-sync covers new clients and connect syncs on focus return"
```

---

### Task 3: Fulfilment billing without targets is not delivered

**Files:**
- Modify: `apps/api/src/financials/month.ts` (new pure rule)
- Modify: `apps/api/src/financials/month.check.ts` (coverage)
- Modify: `apps/api/src/routes/financials.ts` (consume the rule)

**Interfaces:**
- Produces: `quotaMetFor(input: { quotaShort: number | null; quotaLong: number | null; billingMode: string }, delivered: { short: number; long: number }): boolean`.
- Consumes: the existing `deliveredByClient` map in the route.

- [ ] **Step 1: Extend the check first**

In `apps/api/src/financials/month.check.ts`, add before the final console.log (match the file's existing assert style; read it first):

```ts
// A fulfilment client with no targets has nothing countable delivered, so
// the cycle is not met and no invoice is offered. Calendar clients are
// unaffected: their money is owed by the month, not by delivery.
assert.equal(
  quotaMetFor({ quotaShort: null, quotaLong: null, billingMode: "on_fulfilment" }, { short: 9, long: 9 }),
  false,
);
assert.equal(
  quotaMetFor({ quotaShort: null, quotaLong: null, billingMode: "calendar" }, { short: 0, long: 0 }),
  true,
);
assert.equal(
  quotaMetFor({ quotaShort: 10, quotaLong: null, billingMode: "on_fulfilment" }, { short: 10, long: 0 }),
  true,
);
assert.equal(
  quotaMetFor({ quotaShort: 10, quotaLong: 2, billingMode: "on_fulfilment" }, { short: 10, long: 1 }),
  false,
);
```

and add `quotaMetFor` to the import from `./month`.

- [ ] **Step 2: Run the check to see it fail**

Run: `pnpm --filter @toreroflow/api exec tsx src/financials/month.check.ts`
Expected: FAIL, quotaMetFor is not exported.

- [ ] **Step 3: Implement the rule**

Append to `apps/api/src/financials/month.ts`:

```ts
export interface QuotaMetInput {
  quotaShort: number | null;
  quotaLong: number | null;
  billingMode: string;
}

/**
 * Whether a client's cycle counts as delivered.
 *
 * With targets, every tracked format must have reached its target. Without
 * targets the answer depends on the billing mode: a calendar client owes by
 * the month so nothing blocks, but a fulfilment client with no targets has
 * nothing countable delivered, and treating that as met would offer an
 * invoice before any work exists.
 */
export function quotaMetFor(
  input: QuotaMetInput,
  delivered: { short: number; long: number },
): boolean {
  const hasTargets = input.quotaShort != null || input.quotaLong != null;
  if (!hasTargets) return input.billingMode !== "on_fulfilment";
  return (
    (input.quotaShort == null || delivered.short >= input.quotaShort) &&
    (input.quotaLong == null || delivered.long >= input.quotaLong)
  );
}
```

- [ ] **Step 4: Consume it in the route**

In `apps/api/src/routes/financials.ts`, add `quotaMetFor` to the import from `../financials/month`, then inside the `revenueRows` mapping replace the inline computation

```ts
      const quotaMet =
        !c ||
        ((c.quotaShort == null || d.short >= c.quotaShort) &&
          (c.quotaLong == null || d.long >= c.quotaLong));
```

with:

```ts
      const quotaMet =
        !c ||
        quotaMetFor(
          { quotaShort: c.quotaShort, quotaLong: c.quotaLong, billingMode: c.billingMode },
          d,
        );
```

Leave the comment above it and everything else in the mapping (including `hasTargets`, `quotaTarget`, `quotaDelivered`) untouched.

- [ ] **Step 5: Checks, typecheck, commit**

Run: `pnpm --filter @toreroflow/api test`
Expected: three "all checks passed" lines (month, taxExport, summary).
Run: `pnpm --filter @toreroflow/api typecheck`
Expected: exit 0.

```bash
git add apps/api/src/financials/month.ts apps/api/src/financials/month.check.ts apps/api/src/routes/financials.ts
git commit -m "fix: fulfilment billing without quota targets no longer counts as delivered"
```

---

### Task 4: Live verification walk

**Files:** none. Prereq: full stack running; rebuild the installed app or use the dev app.

- [ ] **Step 1:** `pnpm -r typecheck` and all three package test scripts pass.
- [ ] **Step 2:** Sit on Account Overview. Onboard a throwaway brand from the sidebar. Expect: its card appears on Overview without any navigation.
- [ ] **Step 3:** Go to Financials. Price the throwaway brand from its unpriced row. Expect: the totals, donut, and bars move immediately, and the freshly priced row shows NO delete button.
- [ ] **Step 4:** Open Reports. Expect: the throwaway brand's row shows its report link without leaving the screen (the slug exists from creation).
- [ ] **Step 5:** In Settings, flip the throwaway brand to "When delivered" with no quota targets. On Financials, expect: the row reads "Not due" and shows no Invoice button (before this fix it showed one).
- [ ] **Step 6:** Delete the throwaway brand from Settings. Expect: every screen drops it, Financials totals return to their prior values, selection falls back per item 1's behavior.
- [ ] **Step 7:** Confirm Caleb and JR Michael data is untouched.
