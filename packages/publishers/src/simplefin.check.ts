import assert from "node:assert/strict";
import { accountsRequest, claimSetupToken, redactCredentials } from "./simplefin";

/**
 * Runnable check: `pnpm --filter @toreroflow/publishers test`.
 *
 * Only the parts that can be checked without a bank: the setup token is the
 * one thing an operator types by hand, so every way of getting it wrong should
 * come back as a sentence they can act on rather than a stack trace or, worse,
 * a POST to whatever the mistyped string happened to decode to.
 */

const rejects = async (token: string, expected: RegExp, why: string) => {
  await assert.rejects(() => claimSetupToken(token), expected, why);
};

await rejects("", /Paste the setup token/, "an empty box is not an error to explain");
await rejects("   ", /Paste the setup token/, "whitespace is empty too");

// Valid base64 that decodes to something that is not a URL. This is the case
// worth guarding: without the check the code would POST to a made-up address.
await rejects(
  Buffer.from("not a url at all").toString("base64"),
  /did not contain a SimpleFIN address/,
  "a token that decodes to junk must not become a request",
);

// A plausible mistake: pasting the address itself rather than the token.
await rejects(
  "https://bridge.simplefin.org/simplefin/claim/abc",
  /did not contain a SimpleFIN address/,
  "pasting a URL instead of the token is caught before any request",
);

// A token clipped mid-copy that still decodes to something URL-shaped. It
// cannot be told apart from a real one without asking, so the operator gets a
// sentence about copying it again rather than a raw network error.
await rejects(
  Buffer.from("https://bridge.simplefin.invalid/claim/x").toString("base64"),
  /Copy the whole token again/,
  "an unreachable address reads as a copy problem, not a stack trace",
);

/*
 * The access URL carries its credentials in it, and fetch refuses any URL that
 * does. Worse than the refusal: a URL turns up in error text, logs and query
 * strings, so the credential must be out of it and in a header. Both halves are
 * checked because getting the first right and the second wrong reads as working
 * software right up until a screenshot leaks a bank key.
 */
const ACCESS = "https://USERKEY:PASSKEY@beta-bridge.simplefin.org/simplefin";
const built = accountsRequest(ACCESS, new Date("2026-01-01T00:00:00Z"), new Date("2026-03-01T00:00:00Z"));

assert.ok(!built.url.includes("USERKEY"), "the user half of the credential must not be in the URL");
assert.ok(!built.url.includes("PASSKEY"), "the password half must not be in the URL");
assert.ok(!built.url.includes("@"), "no credential separator survives into the URL");
assert.doesNotThrow(() => new Request(built.url), "fetch must accept the URL this builds");
assert.equal(
  built.headers.Authorization,
  `Basic ${Buffer.from("USERKEY:PASSKEY").toString("base64")}`,
  "the credential moves to the header rather than being dropped",
);
assert.equal(
  built.url,
  "https://beta-bridge.simplefin.org/simplefin/accounts?start-date=1767225600&end-date=1772323200&pending=1",
  "the range is sent in seconds, pending included, trailing slash normalised",
);
assert.equal(
  accountsRequest(`${ACCESS}/`, new Date(0), new Date(0)).url.includes("//accounts"),
  false,
  "a trailing slash does not double up",
);

// The one that already happened: an access URL reached the error column, was
// rendered on screen, and ended up in a screenshot.
assert.equal(
  redactCredentials(`Request cannot be constructed from a URL that includes credentials: ${ACCESS}/accounts`),
  "Request cannot be constructed from a URL that includes credentials: https://<redacted>@beta-bridge.simplefin.org/simplefin/accounts",
  "a credential in error text is redacted before it can be stored or shown",
);
assert.equal(
  redactCredentials("The bank feed answered 500."),
  "The bank feed answered 500.",
  "ordinary messages are left alone",
);

console.log("simplefin: all checks passed");
