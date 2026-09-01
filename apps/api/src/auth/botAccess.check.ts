// The whitelist is the entire security boundary between an automation and the
// agency's books, media library and client DMs. Both directions are pinned:
// everything the workflow needs passes, and the dangerous neighbors of each
// allowed route are named and refused.
import assert from "node:assert/strict";
import { botAllowed } from "./botAccess";

// The whole upload -> draft -> schedule workflow passes.
for (const [method, path] of [
  ["GET", "/auth/me"],
  ["GET", "/clients"],
  ["POST", "/clients/cms0qdz5t/media"],
  ["GET", "/clients/cms0qdz5t/media"],
  ["GET", "/media/cms84z50v"],
  ["PATCH", "/media/cms84z50v/draft"],
  ["POST", "/media/cms84z50v/schedule"],
  ["GET", "/clients/cms0qdz5t/posts"],
  ["GET", "/clients/cms0qdz5t/posts?from=2026-09-01"],
] as const) {
  assert.equal(botAllowed(method, path), true, `${method} ${path} is the workflow`);
}

// The dangerous neighbors of each allowed route are refused.
for (const [method, path] of [
  // Same paths, wrong verbs.
  ["DELETE", "/media/cms84z50v"],
  ["DELETE", "/posts/targets/cms84z50v"],
  ["POST", "/clients"],
  ["DELETE", "/clients/cms0qdz5t"],
  ["PATCH", "/posts/targets/cms84z50v/reschedule"],
  ["POST", "/posts/targets/cms84z50v/retry"],
  // Money, messages, credentials.
  ["GET", "/financials/summary"],
  ["GET", "/clients/cms0qdz5t/inbox"],
  ["POST", "/clients/cms0qdz5t/dm-campaigns"],
  ["POST", "/auth/bot-token"],
  ["POST", "/auth/login"],
  ["GET", "/oauth/connections"],
  ["POST", "/accounts/acc1/facebook-reconnect"],
  // Nested lookalikes a sloppy regex would wave through.
  ["POST", "/clients/cms0qdz5t/media/../../financials"],
  ["GET", "/media/cms84z50v/transcript"],
  ["POST", "/media/cms84z50v/cover-image"],
] as const) {
  assert.equal(botAllowed(method, path), false, `${method} ${path} must be refused`);
}

// The query string never changes the verdict.
assert.equal(botAllowed("GET", "/financials/summary?x=1"), false, "query cannot smuggle");

console.log("botAccess.check: all checks passed");
