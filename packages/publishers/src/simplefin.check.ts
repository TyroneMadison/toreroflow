import assert from "node:assert/strict";
import { claimSetupToken } from "./simplefin";

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

console.log("simplefin: all checks passed");
