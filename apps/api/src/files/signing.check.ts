import assert from "node:assert/strict";
import { FILE_LINK_TTL_MS, signedFilePath, verifyFileLink } from "./signing";

/**
 * Runnable check: `pnpm --filter @toreroflow/api test`.
 *
 * This is the only thing standing between a public API and every invoice, tax
 * export and client video in the storage directory, so the cases that matter
 * are the attacks rather than the happy path: a link edited to point at another
 * file, a link kept past its expiry, and a request with no signature at all.
 */

const SECRET = "test-secret-not-a-real-one";
const KEY = "cli_abc/asset_def/source.mp4";

const parse = (path: string) => {
  const q = new URLSearchParams(path.slice(path.indexOf("?") + 1));
  return { e: q.get("e") ?? undefined, s: q.get("s") ?? undefined };
};

// A link this server made, this server accepts.
const link = signedFilePath(KEY, SECRET);
assert.equal(verifyFileLink(KEY, parse(link), SECRET), "ok", "a fresh signed link is served");
assert.match(link, /^\/files\/cli_abc\/asset_def\/source\.mp4\?/, "the key stays a path, not one escaped segment");

// The signature covers the path, so a link to one file cannot be edited into a
// link to another. This is the whole point: storage keys are guessable in shape
// even when the ids are not.
assert.equal(
  verifyFileLink("cli_abc/asset_def/../../secrets.pdf", parse(link), SECRET),
  "bad-signature",
  "a link cannot be repointed at another file",
);
assert.equal(
  verifyFileLink("cli_other/asset_def/source.mp4", parse(link), SECRET),
  "bad-signature",
  "not even at the same file under another client",
);

// No signature at all is the ordinary case for a stranger who guessed a path.
assert.equal(verifyFileLink(KEY, {}, SECRET), "unsigned", "an unsigned request is refused");
assert.equal(verifyFileLink(KEY, { e: "123" }, SECRET), "unsigned", "half a signature is not a signature");
assert.equal(
  verifyFileLink(KEY, { e: String(Date.now() + 1000), s: "obviously-wrong" }, SECRET),
  "bad-signature",
  "a made up signature is refused",
);

// Expiry is enforced, and the expiry itself is signed, so pushing the date out
// invalidates the signature rather than extending the link.
// Two hours clear of the deadline, not one second: expiries round up to the
// hour, so a link signed a second too early is still good for up to an hour.
const then = Date.now() - FILE_LINK_TTL_MS - 2 * 60 * 60 * 1000;
const old = signedFilePath(KEY, SECRET, then);
assert.equal(verifyFileLink(KEY, parse(old), SECRET), "expired", "a link past its time stops working");
const stretched = { ...parse(link), e: String(Date.now() + FILE_LINK_TTL_MS * 100) };
assert.equal(
  verifyFileLink(KEY, stretched, SECRET),
  "bad-signature",
  "moving the expiry forward breaks the signature rather than extending the link",
);

// Another server's secret does not open this server's files.
assert.equal(
  verifyFileLink(KEY, parse(link), "a-different-secret"),
  "bad-signature",
  "a link signed elsewhere is refused",
);

/*
 * Normalisation. The signature is over one canonical form, so the same file
 * cannot be addressed by a spelling that was never signed: a leading slash, a
 * doubled slash, or a percent-escaped separator.
 */
for (const spelling of [`/${KEY}`, `cli_abc//asset_def/source.mp4`, encodeURIComponent(KEY)]) {
  assert.equal(
    verifyFileLink(spelling, parse(link), SECRET),
    "ok",
    `"${spelling}" is the same file and verifies against the same signature`,
  );
}

/*
 * Signed twice inside the same hour bucket, the same link comes back, so the
 * webview caches a thumbnail instead of refetching it on every render. Two
 * calls that straddle a bucket boundary do differ, which costs one refetch an
 * hour and is the price of links that rotate at all.
 */
const midHour = 1_800_001_800_000; // half past the hour
assert.equal(
  signedFilePath(KEY, SECRET, midHour),
  signedFilePath(KEY, SECRET, midHour + 60_000),
  "two calls a minute apart inside one hour give the same URL",
);
assert.notEqual(
  signedFilePath(KEY, SECRET, midHour),
  signedFilePath(KEY, SECRET, midHour + 2 * 60 * 60 * 1000),
  "and two hours apart they differ, so links still rotate",
);

// And two different files never share a signature.
const other = signedFilePath("cli_abc/asset_def/thumb.jpg", SECRET);
assert.notEqual(parse(link).s, parse(other).s, "different files get different signatures");

console.log("file signing: all checks passed");
