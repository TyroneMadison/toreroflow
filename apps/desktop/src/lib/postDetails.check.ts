/** Local so the file stays part of the app's typecheck without pulling in node types. */
const assert = {
  equal(actual: unknown, expected: unknown, message = "") {
    if (actual !== expected) throw new Error(`${message} expected ${String(expected)}, got ${String(actual)}`);
  },
  deepEqual(actual: unknown, expected: unknown, message = "") {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${message} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  },
  match(actual: string, re: RegExp) {
    if (!re.test(actual)) throw new Error(`expected ${JSON.stringify(actual)} to match ${re}`);
  },
};
import {
  captionProblems,
  igPhotoBody,
  imagePostBlocked,
  intake,
  meterLimits,
  parseComposerType,
  tiktokBody,
  tkTouched,
  TIKTOK_DEFAULTS,
  waitReady,
} from "./postDetails";

// Untouched TikTok settings send nothing; any change does.
assert.equal(tkTouched(TIKTOK_DEFAULTS), false);
assert.equal(tkTouched({ ...TIKTOK_DEFAULTS, allowStitch: false }), true);

// Composer type from the URL, reel when unknown.
assert.equal(parseComposerType("carousel"), "carousel");
assert.equal(parseComposerType("story"), "reel");
assert.equal(parseComposerType(null), "reel");

// Image posts: Instagram and TikTok take them, the rest are disabled with a reason.
assert.equal(imagePostBlocked("instagram"), null);
assert.equal(imagePostBlocked("tiktok"), null);
assert.equal(imagePostBlocked("youtube"), "YouTube only takes videos, so image posts can't go there.");
assert.match(imagePostBlocked("facebook")!, /Instagram and TikTok only/);

// Intake: an image post is one picture and no video.
{
  const r = intake("image", 0, [
    { name: "a.jpg", type: "image/jpeg" },
    { name: "b.png", type: "image/png" },
    { name: "c.mp4", type: "video/mp4" },
  ]);
  assert.deepEqual(r.accepted, [0]);
  assert.match(r.notes.join(" "), /Only one picture/);
  assert.match(r.notes.join(" "), /c\.mp4 is a video/);
}
// A carousel stops at 10, takes clips, refuses other files.
{
  const files = Array.from({ length: 12 }, (_, i) => ({ name: `${i}.jpg`, type: "image/jpeg" }));
  const r = intake("carousel", 0, files);
  assert.equal(r.accepted.length, 10);
  assert.deepEqual(r.notes, ["Only 10 items fit in a carousel."]);
  const r2 = intake("carousel", 9, [
    { name: "clip.mov", type: "video/quicktime" },
    { name: "x.gif", type: "image/gif" },
  ]);
  assert.deepEqual(r2.accepted, [0]);
  assert.match(r2.notes[0]!, /x\.gif is not a JPG/);
}

// Caption problems across platforms, each once; TikTok has no hashtag cap.
{
  const tags = Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ");
  assert.deepEqual(captionProblems(["instagram", "tiktok"], tags, false), [
    "31 hashtags. Instagram allows 30. Remove 1 to post.",
  ]);
  assert.deepEqual(captionProblems(["tiktok"], tags, false), []);
  assert.deepEqual(captionProblems(["youtube"], "x".repeat(9000), false), []);
  assert.equal(captionProblems(["tiktok"], "x".repeat(2300), false).length, 1);
  assert.equal(captionProblems(["tiktok"], "x".repeat(2300), true).length, 0);
}

// The meter shows Instagram's limits first, then TikTok's.
assert.deepEqual(meterLimits(["tiktok", "instagram"], false), { platform: "instagram", chars: 2200, hashtags: 30, mentions: 20 });
assert.deepEqual(meterLimits(["tiktok"], true), { platform: "tiktok", chars: 4000, hashtags: null, mentions: null });
assert.equal(meterLimits(["youtube"], false), null);

// TikTok body: duet and stitch only on video.
assert.deepEqual(tiktokBody(TIKTOK_DEFAULTS, true), { privacyLevel: "PUBLIC_TO_EVERYONE", allowComment: true });
assert.deepEqual(tiktokBody({ ...TIKTOK_DEFAULTS, allowDuet: false }, false, { autoAddMusic: true }), {
  autoAddMusic: true,
  privacyLevel: "PUBLIC_TO_EVERYONE",
  allowComment: true,
  allowDuet: false,
  allowStitch: true,
});

// Instagram photo details: only what was filled in, collaborators capped at 3.
assert.equal(igPhotoBody({ collaborators: [], userTags: [], locationId: " " }), undefined);
assert.deepEqual(igPhotoBody({ collaborators: ["a", "b", "c", "d"], userTags: ["x"], locationId: "123" }), {
  collaborators: ["a", "b", "c"],
  userTags: ["x"],
  locationId: "123",
});

// Upload then schedule: waits through processing, stops on failure, gives up as null.
const seq = (...st: string[]) => {
  let i = 0;
  return () => Promise.resolve({ status: st[Math.min(i++, st.length - 1)]! });
};
const noSleep = () => Promise.resolve();
void (async () => {
  assert.equal((await waitReady(seq("uploaded", "processing", "ready"), 5, noSleep))?.status, "ready");
  assert.equal(await waitReady(seq("processing"), 3, noSleep), null);
  let threw = false;
  await waitReady(seq("processing", "failed"), 5, noSleep).catch(() => (threw = true));
  assert.equal(threw, true, "failed processing throws");
  console.log("postDetails.check: all checks passed");
})();
