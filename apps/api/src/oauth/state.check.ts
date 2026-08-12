import assert from "node:assert/strict";
import { signState, verifyState, STATE_TTL_MS } from "./state";

/**
 * Runnable check: `pnpm --filter @toreroflow/api test`.
 *
 * This is the whole authentication of the OAuth callback, so every way of
 * getting past it without the secret is worth pinning. A regression here does
 * not throw and does not look like anything: it means a stranger can attach a
 * credential to any account id they can guess.
 */

const SECRET = "test-secret";
const NOW = 1_770_000_000_000;
const STATE = { agencyId: "agency-1", socialAccountId: "acct-1" };

/* ---- the happy path ---- */

const token = signState(STATE, SECRET, NOW);
const good = verifyState(token, SECRET, NOW);
assert.ok(good.ok, "a token we just signed verifies");
assert.deepEqual(good.ok && good.state, STATE, "and it carries back exactly what went in");

/* ---- forgery ---- */

const bad = (t: unknown, reason: string, why: string) => {
  const v = verifyState(t, SECRET, NOW);
  assert.ok(!v.ok, why);
  assert.equal(!v.ok && v.reason, reason, why);
};

bad(`${token.slice(0, -1)}x`, "bad-signature", "a tampered signature is refused");
assert.ok(
  !verifyState(token, "another-secret", NOW).ok,
  "a token signed with a different secret is refused",
);

// The forgery that matters: rewrite the payload to name a different account and
// keep the signature. This is precisely what an unsigned state would allow.
const [body, sig] = token.split(".");
const stolen = Buffer.from(
  JSON.stringify({ agencyId: "agency-1", socialAccountId: "someone-elses-account", exp: NOW + 1000 }),
  "utf8",
).toString("base64url");
bad(`${stolen}.${sig}`, "bad-signature", "a rewritten payload cannot keep the old signature");
assert.ok(body && sig, "the token is two parts");

bad("", "malformed", "an empty state is not a state");
bad(undefined, "malformed", "a missing state parameter is not a state");
bad("no-dot-at-all", "malformed", "a token with no signature is refused");
// Valid signature over a body that is not our payload at all.
const junk = Buffer.from("just some text", "utf8").toString("base64url");
bad(`${junk}.${signState(STATE, SECRET, NOW).split(".")[1]}`, "bad-signature", "junk is refused");

/* ---- the clock ---- */

assert.ok(
  verifyState(token, SECRET, NOW + STATE_TTL_MS - 1).ok,
  "still good one millisecond before it expires",
);
const expired = verifyState(token, SECRET, NOW + STATE_TTL_MS + 1);
assert.ok(!expired.ok, "and refused one millisecond after");
assert.equal(!expired.ok && expired.reason, "expired", "expiry is reported as expiry, not as forgery");

// A forged token claiming a far-future expiry is still a forgery. The signature
// is checked before the payload is believed about anything, including its own
// lifetime.
const forever = Buffer.from(
  JSON.stringify({ ...STATE, exp: NOW + 100 * 365 * 24 * 60 * 60 * 1000 }),
  "utf8",
).toString("base64url");
bad(`${forever}.${sig}`, "bad-signature", "an unsigned eternity is not an eternity");

console.log("oauth state.check.ts: ok");
