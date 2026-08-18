// videos.update replaces every mutable property of every part the request
// names. These checks exist so the merge can never quietly become the thing
// that wipes a client's title, reverts a public video, or resends a publishAt
// that YouTube refuses. Each block below is one way that has actually happened
// to people using this API.
import assert from "node:assert/strict";
import {
  enrichFieldsFrom,
  mergeVideoUpdate,
  videoIdFromUrl,
  type VideoResource,
} from "./youtubeEnrich";

const live: VideoResource = {
  snippet: {
    title: "How to win a pen sale",
    description: "The full breakdown.",
    categoryId: "27",
    tags: ["old-tag"],
  },
  status: {
    privacyStatus: "public",
    license: "youtube",
    embeddable: true,
    publishAt: "2026-08-18T22:00:00Z",
    madeForKids: false,
  },
};

// Updating tags must carry the title, description and categoryId through,
// because naming part=snippet replaces the whole snippet.
{
  const { parts, body } = mergeVideoUpdate("vid1", live, { tags: ["sales", "pen"] });
  assert.deepEqual(parts, ["snippet"]);
  const snippet = body.snippet as Record<string, unknown>;
  assert.equal(snippet.title, "How to win a pen sale", "the title survives");
  assert.equal(snippet.description, "The full breakdown.", "so does the description");
  assert.equal(snippet.categoryId, "27", "and the category");
  assert.deepEqual(snippet.tags, ["sales", "pen"], "the tags are ours");
}

// Updating the license keeps the video public and drops the stale publishAt,
// which YouTube refuses on anything already published.
{
  const { parts, body } = mergeVideoUpdate("vid1", live, { license: "creativeCommon" });
  assert.deepEqual(parts, ["status"]);
  const status = body.status as Record<string, unknown>;
  assert.equal(status.privacyStatus, "public", "privacy is preserved, not defaulted");
  assert.equal(status.license, "creativeCommon", "our name maps to the API's");
  assert.equal("publishAt" in status, false, "a public video sends no publishAt");
  assert.equal(status.madeForKids, false, "unrelated status fields ride along unchanged");
}

// A still-private video keeps its scheduled publishAt: dropping it there
// would unschedule the client's premiere.
{
  const scheduled: VideoResource = {
    ...live,
    status: { ...live.status, privacyStatus: "private" },
  };
  const { body } = mergeVideoUpdate("vid1", scheduled, { embeddable: false });
  const status = body.status as Record<string, unknown>;
  assert.equal(status.publishAt, "2026-08-18T22:00:00Z", "a private video keeps its schedule");
  assert.equal(status.embeddable, false);
}

// Only the parts that change are named. Blast radius stays minimal.
{
  const { parts } = mergeVideoUpdate("vid1", live, { recordingDate: "2026-08-15" });
  assert.deepEqual(parts, ["recordingDetails"], "one field, one part");
}
{
  const { parts, body } = mergeVideoUpdate("vid1", live, {
    tags: ["a"],
    embeddable: false,
    recordingDate: "2026-08-15",
    paidPromotion: true,
  });
  assert.deepEqual(parts, ["snippet", "status", "recordingDetails", "paidProductPlacementDetails"]);
  assert.deepEqual(body.recordingDetails, { recordingDate: "2026-08-15T00:00:00Z" });
  assert.deepEqual(body.paidProductPlacementDetails, { hasPaidProductPlacement: true });
}

// Nothing to change is no request at all.
assert.deepEqual(mergeVideoUpdate("vid1", live, {}).parts, []);

// "standard" is our word; the API's is "youtube".
assert.equal(
  (mergeVideoUpdate("vid1", live, { license: "standard" }).body.status as { license?: string })
    .license,
  "youtube",
);

// The stored-options extractor: only real fields count, and none means null.
{
  const fields = enrichFieldsFrom({
    youtube: {
      title: "ignored here",
      visibility: "public",
      tags: ["sales", "pen"],
      embeddable: false,
      recordingDate: "2026-08-15",
      defaultLanguage: "en",
      paidPromotion: true,
      license: "creativeCommon",
    },
  });
  assert.deepEqual(fields, {
    tags: ["sales", "pen"],
    license: "creativeCommon",
    embeddable: false,
    recordingDate: "2026-08-15",
    defaultLanguage: "en",
    paidPromotion: true,
  });
}
assert.equal(enrichFieldsFrom({ youtube: { visibility: "public", madeForKids: true } }), null);
assert.equal(enrichFieldsFrom({ instagram: { trial: true } }), null);
assert.equal(enrichFieldsFrom(null), null);
assert.equal(
  enrichFieldsFrom({ youtube: { recordingDate: "15/08/2026" } }),
  null,
  "a malformed date never reaches the API",
);

// The URL parser, across every shape YouTube links arrive in.
assert.equal(videoIdFromUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
assert.equal(videoIdFromUrl("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
assert.equal(videoIdFromUrl("https://www.youtube.com/shorts/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
assert.equal(videoIdFromUrl("https://www.youtube.com/watch?feature=share&v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
assert.equal(videoIdFromUrl("https://www.instagram.com/reel/DcKcCogkVrI/"), null);
assert.equal(videoIdFromUrl(null), null);

console.log("youtubeEnrich.check: all checks passed");
