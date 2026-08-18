import assert from "node:assert/strict";
import {
  batches,
  googleAuthUrl,
  parseReport,
  REPORT_BATCH,
  reportDate,
  toStoreFields,
  type VideoAnalytics,
} from "./youtubeAnalytics";

/**
 * Runnable check: `pnpm --filter @toreroflow/publishers test`.
 *
 * Everything here is a property that fails silently in production if it breaks.
 * A misparsed report does not throw; it writes a wrong number onto a client's
 * video and it looks completely plausible. So the report parser is pinned by
 * column name against a deliberately reordered header, the zero rules are
 * pinned in both directions, and the consent URL is pinned on the two
 * parameters that decide whether a refresh token comes back at all.
 */

/* ---- the consent URL ---- */

const url = new URL(
  googleAuthUrl(
    { clientId: "cid", clientSecret: "unused", redirectUri: "https://api.example.com/cb" },
    "state-token",
  ),
);

// Without both of these Google returns no refresh token on a re-authorization,
// and the sync dies an hour later with nothing saying why.
assert.equal(url.searchParams.get("access_type"), "offline", "offline is what earns a refresh token");
assert.equal(url.searchParams.get("prompt"), "consent", "consent is what re-earns one");
assert.equal(url.searchParams.get("state"), "state-token", "state must survive to the callback");
assert.equal(
  url.searchParams.get("redirect_uri"),
  "https://api.example.com/cb",
  "the redirect must go out exactly as registered",
);
/*
 * The scope list is closed: exactly these three, nothing arrives by accident.
 *
 * This used to assert read-only across the board, which was the right rule
 * while the connection existed for analytics alone. The long-form enrichment
 * ended that on 2026-08-18: videos.update needs write, and force-ssl was
 * chosen over the narrower "youtube" scope because it also covers the caption
 * and thumbnail calls of later pieces, one consent screen instead of three.
 * The guard's job is unchanged: a NEW scope appearing here must break a check
 * and force exactly this paragraph to be rewritten by someone who can say why.
 */
assert.deepEqual(
  (url.searchParams.get("scope") ?? "").split(" ").sort(),
  [
    "https://www.googleapis.com/auth/youtube.force-ssl",
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/yt-analytics.readonly",
  ].sort(),
  "the scope list is exactly the three the app can justify",
);

/* ---- the report parser ---- */

/*
 * Headers deliberately NOT in the order the API documents, and with the video
 * dimension in the middle rather than first. A positional parser passes on the
 * documented order and silently swaps two metrics on any other one; this is the
 * case that catches it.
 */
const report = {
  columnHeaders: [
    { name: "shares" },
    { name: "video" },
    { name: "subscribersGained" },
    { name: "averageViewDuration" },
    { name: "estimatedMinutesWatched" },
  ],
  rows: [
    [12, "vid-a", 3, 41, 900],
    [0, "vid-b", 0, 0, 0],
    // No video id: dropped rather than guessed at.
    [7, 99, 1, 2, 3],
  ],
};

const parsed = parseReport(report);
assert.equal(parsed.size, 2, "a row with no video id is not a video");
assert.equal(parsed.get("vid-a")?.shares, 12, "shares read by name, not by position");
assert.equal(parsed.get("vid-a")?.subscribersGained, 3, "subscribers read by name");
assert.equal(parsed.get("vid-a")?.averageViewDuration, 41, "watch read by name");
// Asked for but absent from this response: absent, never zero.
assert.equal(parsed.get("vid-a")?.views, null, "a metric the report omitted is not a zero");
assert.equal(parseReport({}).size, 0, "an empty body is no videos, not a crash");
assert.equal(
  parseReport({ columnHeaders: [{ name: "views" }], rows: [[5]] }).size,
  0,
  "a report with no video dimension cannot be keyed, so nothing is written",
);

/* ---- the zero rules, which are a ruling and not a preference ---- */

const full: VideoAnalytics = {
  views: 500,
  likes: 10,
  comments: 2,
  shares: 4,
  estimatedMinutesWatched: 30,
  averageViewDuration: 17,
  averageViewPercentage: 40,
  subscribersGained: 6,
};

const fields = toStoreFields(full);
assert.equal(fields.shares, 4, "shares carry through");
assert.equal(fields.follows, 6, "subscribers gained is what follows has been waiting for");
assert.equal(fields.avgWatchSec, 17, "average view duration is already seconds");
assert.equal(fields.totalWatchSec, 30 * 60, "estimated minutes watched becomes seconds");

// Views, likes and comments stay with the catalogue sync. Two sources for one
// number is how a lifetime view count starts moving backwards.
assert.ok(!("views" in fields), "views are the Data API's to write");

const zeroed = toStoreFields({
  ...full,
  shares: 0,
  subscribersGained: 0,
  averageViewDuration: 0,
  estimatedMinutesWatched: 0,
});
assert.equal(zeroed.shares, 0, "a video really can be shared zero times");
assert.equal(zeroed.follows, 0, "a video really can gain zero subscribers");
assert.ok(
  !("avgWatchSec" in zeroed),
  "zero watch time on a viewed video is uncomputed, not measured",
);
assert.ok(
  !("totalWatchSec" in zeroed),
  "zero minutes watched on a viewed video is uncomputed, not measured",
);

// A metric the report did not carry at all writes nothing, so a field another
// source already filled is never overwritten with an absence.
const empty = toStoreFields({
  views: null,
  likes: null,
  comments: null,
  shares: null,
  estimatedMinutesWatched: null,
  averageViewDuration: null,
  averageViewPercentage: null,
  subscribersGained: null,
});
assert.deepEqual(empty, {}, "nothing reported means nothing written");

/* ---- batching and dates ---- */

const ids = Array.from({ length: 451 }, (_, i) => `v${i}`);
const chunks = batches(ids);
assert.equal(chunks.length, 3, "451 ids at 200 a request is three requests");
assert.ok(
  chunks.every((c) => c.length <= REPORT_BATCH),
  "no batch may exceed the row cap, or the extra videos come back with no rows at all",
);
assert.equal(chunks.flat().length, ids.length, "batching loses nothing");
assert.deepEqual(batches([]), [], "no videos is no requests");

assert.equal(
  reportDate(new Date("2026-08-12T23:30:00.000Z")),
  "2026-08-12",
  "report dates are UTC calendar days",
);

console.log("youtubeAnalytics.check.ts: ok");
