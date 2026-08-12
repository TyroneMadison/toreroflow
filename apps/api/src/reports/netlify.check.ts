import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { alreadyLive } from "./netlify";

/**
 * Runnable check: `pnpm --filter @toreroflow/api test`.
 *
 * This one decision costs money in one direction and silence in the other.
 * Answer "already live" when it is not, and a client's report stops updating
 * with the app cheerfully reporting success. Answer "changed" when nothing did,
 * and every press of a button spends 15 Netlify credits on bytes that were
 * already there, which is exactly how this account burned 945 credits on 63
 * deploys and was cut off mid-month.
 */

const sha = (s: string) => createHash("sha1").update(s).digest("hex");
const live = (path: string, content: string) => ({ path, sha: sha(content) });

const PAGE = "<html>report</html>";

/* ---- the saving case ---- */

assert.ok(
  alreadyLive([live("/caleb/index.html", PAGE)], { "/caleb/index.html": PAGE }),
  "identical bytes at the same path is nothing to deploy",
);

// The one that pays: several clients republished, none of them changed.
assert.ok(
  alreadyLive(
    [live("/a/index.html", "A"), live("/b/index.html", "B"), live("/c/index.html", "C")],
    { "/a/index.html": "A", "/b/index.html": "B", "/c/index.html": "C" },
  ),
  "a whole batch of unchanged pages is one skipped deploy, not three",
);

assert.ok(alreadyLive([], {}), "nothing to publish is nothing to deploy");
assert.ok(
  alreadyLive([live("/other/index.html", "x")], {}),
  "an empty addition set never deploys, whatever else is on the site",
);

/* ---- the cases that MUST still deploy ---- */

const mustDeploy = (existing: Array<{ path: string; sha: string }>, additions: Record<string, string>, why: string) =>
  assert.ok(!alreadyLive(existing, additions), why);

mustDeploy([live("/caleb/index.html", PAGE)], { "/caleb/index.html": "<html>new</html>" },
  "changed bytes must deploy, or the client's page silently stops updating");

mustDeploy([], { "/caleb/index.html": PAGE },
  "a page that has never been published must deploy");

mustDeploy([live("/someone-else/index.html", PAGE)], { "/caleb/index.html": PAGE },
  "same bytes at a DIFFERENT path is a new page, not a duplicate");

// The trap that matters in a batch: one changed among many unchanged.
mustDeploy(
  [live("/a/index.html", "A"), live("/b/index.html", "B"), live("/c/index.html", "C")],
  { "/a/index.html": "A", "/b/index.html": "CHANGED", "/c/index.html": "C" },
  "one changed page in a batch must still deploy the batch",
);

// Whitespace is a byte. A page differing only in trailing newline is different.
mustDeploy([live("/caleb/index.html", PAGE)], { "/caleb/index.html": `${PAGE}\n` },
  "a one-character difference is a difference");

/* ---- the regression this was actually written for ---- */

/*
 * The connect file used to carry a builtAt timestamp that nothing read. It
 * changed the hash on every press of "Copy welcome link", so every press was a
 * production deploy. If a per-call value ever creeps back into a published
 * file, this is what should catch it.
 */
const connect = (brand: string) => JSON.stringify({ brand, connect: [{ platform: "instagram", url: "https://x" }] });
assert.ok(
  alreadyLive([live("/connect/tok.json", connect("Caleb"))], { "/connect/tok.json": connect("Caleb") }),
  "the same connect payload twice must not deploy twice",
);
// And the proof that the timestamp was the whole problem: the same brand, the
// same links, two moments, and the skip can never fire.
const withStamp = (at: string) => JSON.stringify({ brand: "Caleb", connect: [], builtAt: at });
mustDeploy(
  [live("/connect/tok.json", withStamp("2026-08-12T10:00:00.000Z"))],
  { "/connect/tok.json": withStamp("2026-08-12T10:00:01.000Z") },
  "a per-call timestamp makes identical content look changed, which is why builtAt was removed",
);

console.log("netlify.check.ts: ok");
