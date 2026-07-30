import assert from "node:assert/strict";
import { linkTokenBody, needsReconnect, PlaidClient } from "./plaid";

/**
 * Runnable check: `pnpm --filter @toreroflow/publishers test`.
 *
 * The property being defended is that the two link modes never mix. A new link
 * asks for products; an update re-authenticates an existing link by its access
 * token. Sending products in update mode is what creates a SECOND item for a
 * bank that is already connected, and since both items' accounts default into
 * cash flow, every figure in the Bank section doubles. Measured, not guessed:
 * money in went from $1,512.66 to $3,025.32 that way.
 */

/* ---- a new link ---- */
{
  const body = linkTokenBody("agency_1");
  assert.deepEqual(body.products, ["transactions"], "a new link asks for transactions");
  assert.equal("access_token" in body, false, "a new link carries no access token");
  assert.deepEqual(body.user, { client_user_id: "agency_1" });
  assert.equal(body.client_name, "Toreroflow");
  assert.deepEqual(body.country_codes, ["US"]);
  // Read-only by construction: the products list can never widen to a mover of
  // money without this assertion failing.
  assert.deepEqual(body.products, ["transactions"]);
}

/* ---- repairing an existing link ---- */
{
  const body = linkTokenBody("agency_1", "access-sandbox-123");
  assert.equal(body.access_token, "access-sandbox-123");
  assert.equal("products" in body, false, "update mode must not ask for products");
  assert.deepEqual(body.user, { client_user_id: "agency_1" });
}

/* An absent token is a new link, never an update with an empty token. */
for (const empty of [undefined, null, ""]) {
  const body = linkTokenBody("agency_1", empty);
  assert.deepEqual(body.products, ["transactions"], `${String(empty)} means a new link`);
  assert.equal("access_token" in body, false);
}

/* Exactly one of the two keys is present, always. */
for (const token of [undefined, "tok"]) {
  const body = linkTokenBody("agency_1", token);
  const keys = ["products", "access_token"].filter((k) => k in body);
  assert.equal(keys.length, 1, `expected one mode key, got ${keys.join(" and ")}`);
}

/*
 * ---- which environment is being called ----
 *
 * Anything unrecognised must throw. Quietly treating it as sandbox is the one
 * mistake in switching to production that would not announce itself: the app
 * would keep calling the test host while every screen claimed to show a real
 * bank.
 */
assert.doesNotThrow(() => new PlaidClient("id", "secret", "sandbox"));
assert.doesNotThrow(() => new PlaidClient("id", "secret", "production"));
assert.doesNotThrow(() => new PlaidClient("id", "secret"), "the default is a real environment");
// Surrounding whitespace is a typo, not a different environment.
assert.doesNotThrow(() => new PlaidClient("id", "secret", " production "));
for (const bad of ["prod", "Production", "PRODUCTION", "live", "development", "", "  "]) {
  assert.throws(
    () => new PlaidClient("id", "secret", bad),
    /not a bank environment/,
    `"${bad}" must be refused rather than silently treated as sandbox`,
  );
}

/* ---- which failures mean "log in again" rather than "broken" ---- */
assert.equal(needsReconnect("ITEM_LOGIN_REQUIRED"), true);
assert.equal(needsReconnect("PENDING_EXPIRATION"), true);
for (const code of ["RATE_LIMIT", "INTERNAL_SERVER_ERROR", "INVALID_ACCESS_TOKEN", null]) {
  assert.equal(needsReconnect(code), false, `${String(code)} is not a reconnect`);
}

console.log("plaid: all checks passed");
