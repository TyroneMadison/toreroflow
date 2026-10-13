/*
 * Runnable check: `pnpm --filter @toreroflow/desktop test`.
 * The agent-readable snapshot has exactly the documented shape, is frozen,
 * and carries nothing that looks like a credential.
 */
import { buildAgentState } from "./agentState";

function eq(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\n  expected: ${e}\n  actual:   ${a}`);
}

const s = buildAgentState({
  route: "/accounts",
  screen: "overview",
  section: null,
  clientId: "c_1",
  clientName: "Caleb",
  range: 90,
  apiUp: true,
  busy: false,
  role: "owner",
  lastError: null,
});

eq(
  Object.keys(s),
  ["version", "route", "screen", "section", "clientId", "clientName", "range", "apiUp", "busy", "user", "lastError"],
  "exactly the documented fields, in order",
);
eq(s.version, 1, "version 1");
eq(s.screen, "account-overview", "screen is the page slug, not the internal id");
eq(s.user, { role: "owner" }, "user carries the role only");
eq(Object.isFrozen(s) && Object.isFrozen(s.user), true, "snapshot and user are frozen");

// Extra input fields (a token passed by mistake) never reach the snapshot.
const leaky = buildAgentState({
  ...{ route: "/dashboard", screen: "dashboard", section: null, clientId: null, clientName: null },
  ...{ range: null, apiUp: false, busy: true, role: null, lastError: null },
  ...({ token: "secret", email: "x@y.z" } as object),
} as Parameters<typeof buildAgentState>[0]);
const text = JSON.stringify(leaky);
eq(/token|secret|password|email|authorization/i.test(text), false, "no credential-like field or value");
eq(leaky.user, null, "signed out has no user");

console.log("agentState: all checks passed");
