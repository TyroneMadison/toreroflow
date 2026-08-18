// Local so the file stays part of the package's typecheck without pulling
// in node's assert types beyond the existing @types/node devDependency.
import assert from "node:assert/strict";
import { mediaItemsFor } from "./zernio";
import { buildPostExtras } from "./options";

// Instagram short-form with every option set.
const ig = buildPostExtras({
  platform: "instagram",
  format: "short_form",
  coverUrl: "https://cdn.example/cover.jpg",
  instagram: {
    trial: true,
    graduationStrategy: "SS_PERFORMANCE",
    collaborators: ["northstar", "torerone"],
    audioName: "Torerone Original",
    shareToFeed: false,
    firstComment: "#cars #detroit",
    aiLabel: true,
  },
});
assert.deepEqual(ig.platformSpecificData, {
  contentType: "reels",
  instagramThumbnail: "https://cdn.example/cover.jpg",
  trialParams: { graduationStrategy: "SS_PERFORMANCE" },
  collaborators: ["northstar", "torerone"],
  audioName: "Torerone Original",
  shareToFeed: false,
  firstComment: "#cars #detroit",
  isAiGenerated: true,
});
assert.equal(ig.tiktokSettings, undefined);
assert.equal(ig.mediaThumbnail, undefined);

// Instagram with nothing chosen still declares the reel.
assert.deepEqual(buildPostExtras({ platform: "instagram", format: "short_form", coverUrl: null }), {
  platformSpecificData: { contentType: "reels" },
});

// Trial defaults to manual graduation.
const trial = buildPostExtras({
  platform: "instagram",
  format: "short_form",
  coverUrl: null,
  instagram: { trial: true },
});
assert.deepEqual(trial.platformSpecificData?.trialParams, { graduationStrategy: "MANUAL" });

// Empty collaborator entries are dropped; more than three never pass through.
const collab = buildPostExtras({
  platform: "instagram",
  format: "short_form",
  coverUrl: null,
  instagram: { collaborators: ["a", "", "b", "c", "d"] },
});
assert.deepEqual(collab.platformSpecificData?.collaborators, ["a", "b", "c"]);

// YouTube long-form: cover + title mapping.
const ytLong = buildPostExtras({
  platform: "youtube",
  format: "long_form",
  coverUrl: "https://cdn.example/cover.jpg",
  youtubeTitle: "How to charge the ZR1X",
});
assert.deepEqual(ytLong.platformSpecificData, { title: "How to charge the ZR1X" });
assert.equal(ytLong.mediaThumbnail, "https://cdn.example/cover.jpg");

// YouTube short-form never carries a thumbnail (YouTube's rule for Shorts).
const ytShort = buildPostExtras({
  platform: "youtube",
  format: "short_form",
  coverUrl: "https://cdn.example/cover.jpg",
  youtubeTitle: "T",
});
assert.equal(ytShort.mediaThumbnail, undefined);
assert.deepEqual(ytShort.platformSpecificData, { title: "T" });

// TikTok cover goes to the top-level settings object.
assert.deepEqual(
  buildPostExtras({ platform: "tiktok", format: "short_form", coverUrl: "https://cdn.example/c.jpg" }),
  { tiktokSettings: { video_cover_image_url: "https://cdn.example/c.jpg" } },
);

// TikTok without a cover sends nothing.
assert.deepEqual(buildPostExtras({ platform: "tiktok", format: "short_form", coverUrl: null }), {});

// Platforms with no options produce the legacy body.
assert.deepEqual(buildPostExtras({ platform: "facebook", format: "short_form", coverUrl: null }), {});
assert.deepEqual(buildPostExtras({ platform: "snapchat", format: null, coverUrl: null }), {});

// YouTube with every option set: aiLabel becomes containsSyntheticMedia,
// relatedVideoUrl never reaches the wire (the route consumes it).
const ytFull = buildPostExtras({
  platform: "youtube",
  format: "short_form",
  coverUrl: null,
  youtubeTitle: "ZR1X charging",
  youtube: {
    visibility: "unlisted",
    madeForKids: false,
    firstComment: "Full build on the channel",
    categoryId: "2",
    playlistId: "PLabc123",
    aiLabel: true,
    relatedVideoUrl: "https://www.youtube.com/watch?v=abc123",
  },
});
assert.deepEqual(ytFull.platformSpecificData, {
  title: "ZR1X charging",
  visibility: "unlisted",
  firstComment: "Full build on the channel",
  categoryId: "2",
  playlistId: "PLabc123",
  containsSyntheticMedia: true,
});

// Made for kids rides the wire and drops the first comment: kids videos
// have comments permanently disabled, so the pair can never coexist.
const ytKids = buildPostExtras({
  platform: "youtube",
  format: "short_form",
  coverUrl: null,
  youtube: { madeForKids: true, firstComment: "never sent" },
});
assert.deepEqual(ytKids.platformSpecificData, { madeForKids: true });

// Untouched YouTube options still send nothing at all.
assert.deepEqual(
  buildPostExtras({ platform: "youtube", format: "short_form", coverUrl: null }),
  {},
);

console.log("options builder: all checks passed");

/*
 * A story is its own post and carries none of the reel's settings.
 *
 * Instagram does not display a story's caption and rejects collaborators,
 * trials and first comments on one. Sending them anyway would mean a target
 * that looks configured on screen and is quietly stripped on the wire, so
 * the story branch is deliberately bare.
 */
{
  const story = buildPostExtras({
    platform: "instagram",
    format: "short_form",
    coverUrl: "https://example.com/cover.jpg",
    instagram: {
      story: true,
      trial: true,
      collaborators: ["someone"],
      firstComment: "first!",
      shareToFeed: true,
      audioName: "some audio",
      aiLabel: true,
    },
  });
  assert.deepEqual(
    story.platformSpecificData,
    { contentType: "story" },
    "a story must carry contentType only",
  );
  assert.equal(story.mediaThumbnail, undefined, "stories take no thumbnail");
}

/* Without the flag, Instagram is still a reel with all its options intact. */
{
  const reel = buildPostExtras({
    platform: "instagram",
    format: "short_form",
    coverUrl: null,
    instagram: { collaborators: ["a"], firstComment: "hi" },
  });
  const psd = reel.platformSpecificData as Record<string, unknown>;
  assert.equal(psd.contentType, "reels");
  assert.deepEqual(psd.collaborators, ["a"]);
  assert.equal(psd.firstComment, "hi");
}

/* story: false is the same as not asking for one. */
{
  const reel = buildPostExtras({
    platform: "instagram",
    format: "short_form",
    coverUrl: null,
    instagram: { story: false, firstComment: "hi" },
  });
  assert.equal((reel.platformSpecificData as Record<string, unknown>).contentType, "reels");
}

/*
 * ---- what a post carries ----
 *
 * One video or a set of images, never both. Sending a video alongside images
 * would leave the provider deciding what lands on a client's account.
 */
{
  const video = mediaItemsFor({ mediaUrl: "https://x/v.mp4" });
  assert.deepEqual(video, [{ url: "https://x/v.mp4", type: "video" }]);

  const withThumb = mediaItemsFor({ mediaUrl: "https://x/v.mp4", mediaThumbnail: "https://x/t.jpg" });
  assert.deepEqual(withThumb, [
    { url: "https://x/v.mp4", type: "video", thumbnail: "https://x/t.jpg" },
  ]);

  // A carousel: every image, in the order given, because the first one decides
  // the aspect ratio of the whole post.
  const carousel = mediaItemsFor({ imageUrls: ["https://x/1.png", "https://x/2.png"] });
  assert.deepEqual(carousel, [
    { url: "https://x/1.png", type: "image" },
    { url: "https://x/2.png", type: "image" },
  ]);
  assert.equal(carousel.every((i) => i.type === "image"), true);

  // Both present is not a real state, but it must resolve one way, not two.
  const both = mediaItemsFor({ mediaUrl: "https://x/v.mp4", imageUrls: ["https://x/1.png"] });
  assert.equal(both.length, 1);
  assert.equal(both[0]!.type, "image", "images win, never a mixture");

  // Nothing at all sends no media key rather than an empty array.
  assert.deepEqual(mediaItemsFor({}), []);
  assert.deepEqual(mediaItemsFor({ imageUrls: [] }), []);
}

/*
 * Carousels on the wire.
 *
 * These shapes come straight from the provider's platform docs and each field
 * is load-bearing: a TikTok photo post without the consent flags is refused,
 * one without media_type is treated as a video and fails on an image, and an
 * Instagram carousel declared a reel posts wrongly or not at all. The
 * Instagram case is also a regression pin: every Instagram target used to get
 * contentType "reels" unconditionally, and a carousel had never actually been
 * published when that was caught.
 */
{
  const ig = buildPostExtras({
    platform: "instagram",
    format: null,
    coverUrl: null,
    carousel: true,
    caption: "three cars, one budget",
    instagram: { firstComment: "should not leak", aiLabel: true },
  });
  assert.equal(ig.platformSpecificData, undefined, "an instagram carousel is a plain media list");
  assert.equal(ig.tiktokSettings, undefined);
  assert.equal(ig.contentOverride, undefined, "instagram keeps the caption as content");

  const tk = buildPostExtras({
    platform: "tiktok",
    format: null,
    coverUrl: null,
    carousel: true,
    caption: "three cars, one budget, full breakdown",
    tiktok: { autoAddMusic: true },
    tiktokTitle: "Three cars, one budget",
  });
  assert.deepEqual(tk.tiktokSettings, {
    media_type: "photo",
    content_preview_confirmed: true,
    express_consent_given: true,
    auto_add_music: true,
    description: "three cars, one budget, full breakdown",
  });
  assert.equal(tk.contentOverride, "Three cars, one budget", "the name is the photo post's title");

  // Music is opt-in: leaving the toggle off must not send the key at all,
  // because sending auto_add_music false is a different request than silence.
  const quiet = buildPostExtras({
    platform: "tiktok",
    format: null,
    coverUrl: null,
    carousel: true,
    caption: "c",
    tiktok: null,
  });
  assert.equal("auto_add_music" in (quiet.tiktokSettings ?? {}), false);

  // No title picked: content stays whatever the caller sends (the caption),
  // and the provider trims it to the 90-char title itself.
  assert.equal(quiet.contentOverride, undefined);

  // A tiktok VIDEO is untouched by all of this: cover behavior as before.
  const vid = buildPostExtras({
    platform: "tiktok",
    format: "short_form",
    coverUrl: "https://x/cover.jpg",
    tiktok: { autoAddMusic: true },
  });
  assert.deepEqual(vid.tiktokSettings, { video_cover_image_url: "https://x/cover.jpg" });
}

/* ---- reel or feed post, decided by length ---- */

/*
 * The 106 second video that could not be published for three days. Declaring
 * it a reel pins Instagram to 90 seconds; omitting contentType sends it as a
 * feed post, which Instagram takes up to an hour of.
 */
const igLong = buildPostExtras({
  platform: "instagram",
  format: "short_form",
  coverUrl: null,
  durationSec: 106,
});
assert.equal(
  igLong.platformSpecificData?.contentType,
  "reels",
  "106 seconds is tried AS A REEL first, because the Reels tab is the whole prize",
);

// After Instagram has actually refused it, the retry goes as a feed post.
const igRetry = buildPostExtras({
  platform: "instagram",
  format: "short_form",
  coverUrl: null,
  durationSec: 106,
  instagramFeedPost: true,
});
assert.ok(
  !igRetry.platformSpecificData?.contentType,
  "the fallback must NOT declare a reel, or it fails the same way twice",
);

const igShort = buildPostExtras({
  platform: "instagram",
  format: "short_form",
  coverUrl: null,
  durationSec: 64,
});
assert.equal(
  igShort.platformSpecificData?.contentType,
  "reels",
  "under 90 seconds stays a reel, which is what earns the Reels tab",
);

// The boundary, both sides of it.
const at = (d: number) =>
  buildPostExtras({ platform: "instagram", format: "short_form", coverUrl: null, durationSec: d })
    .platformSpecificData?.contentType;
assert.equal(at(180), "reels", "three minutes is still tried as a reel");
assert.equal(at(180.5), undefined, "past three minutes the Reels tab is not on offer at all");

// No duration at all behaves as it always did, so nothing already scheduled
// changes shape when this ships.
assert.equal(
  buildPostExtras({ platform: "instagram", format: "short_form", coverUrl: null })
    .platformSpecificData?.contentType,
  "reels",
  "an unknown duration stays a reel, matching every video sent before this",
);

// A trial is a Reels feature: sending it on a feed post asks the provider to
// reject the whole post over an option that cannot apply.
const igLongTrial = buildPostExtras({
  platform: "instagram",
  format: "short_form",
  coverUrl: null,
  instagramFeedPost: true,
  durationSec: 200,
  instagram: { trial: true, collaborators: ["someone"], firstComment: "hi" },
});
assert.ok(!igLongTrial.platformSpecificData?.trialParams, "no trial params on a feed post");
assert.deepEqual(
  igLongTrial.platformSpecificData?.collaborators,
  ["someone"],
  "collaborators still ride a feed post",
);
assert.equal(igLongTrial.platformSpecificData?.firstComment, "hi", "so does a first comment");

// A story is a story whatever the length: its own guard refuses over 60s well
// before this, and it must never be quietly turned into a feed post.
assert.equal(
  buildPostExtras({
    platform: "instagram",
    format: "short_form",
    coverUrl: null,
    durationSec: 200,
    instagram: { story: true },
  }).platformSpecificData?.contentType,
  "story",
  "a story stays a story",
);

console.log("options builder: instagram length checks passed");

/*
 * Catalog audio, which Instagram accepts on reels and refuses everywhere else.
 *
 * The refusal happens at container creation, so getting this wrong does not
 * degrade to a post without music: it fails the publish outright. The feed-post
 * case matters most, because that is the fallback a refused reel takes, and
 * carrying the audio into it would fail the retry too and read as the fallback
 * being broken.
 */
const igAudio = buildPostExtras({
  platform: "instagram",
  format: "short_form",
  coverUrl: null,
  durationSec: 42,
  instagram: { audioId: "482851939985510", audioVolume: 80, videoVolume: 0 },
});
assert.deepEqual(igAudio.platformSpecificData, {
  contentType: "reels",
  audioConfiguration: { audioId: "482851939985510", audioVolume: 80, videoVolume: 0 },
});

// Volume zero is a real choice (mute the video under the track), so it has to
// survive rather than being dropped as falsy.
assert.equal(
  (
    igAudio.platformSpecificData?.audioConfiguration as { videoVolume?: number }
  ).videoVolume,
  0,
  "a muted video keeps its zero",
);

// Volumes are optional; an unset one is Instagram's default, not a value of ours.
assert.deepEqual(
  buildPostExtras({
    platform: "instagram",
    format: "short_form",
    coverUrl: null,
    instagram: { audioId: "abc" },
  }).platformSpecificData?.audioConfiguration,
  { audioId: "abc" },
  "no volume sent when none was chosen",
);

// Out of range cannot reach the wire.
assert.deepEqual(
  buildPostExtras({
    platform: "instagram",
    format: "short_form",
    coverUrl: null,
    instagram: { audioId: "abc", audioVolume: 140, videoVolume: -20 },
  }).platformSpecificData?.audioConfiguration,
  { audioId: "abc", audioVolume: 100, videoVolume: 0 },
  "volumes clamp to 0-100",
);

// Too long to be a reel: the feed post carries no audio.
assert.equal(
  buildPostExtras({
    platform: "instagram",
    format: "short_form",
    coverUrl: null,
    durationSec: 400,
    instagram: { audioId: "abc" },
  }).platformSpecificData?.audioConfiguration,
  undefined,
  "a feed post refuses catalog audio",
);

// The same, via the fallback flag rather than the duration.
assert.equal(
  buildPostExtras({
    platform: "instagram",
    format: "short_form",
    coverUrl: null,
    durationSec: 42,
    instagramFeedPost: true,
    instagram: { audioId: "abc" },
  }).platformSpecificData?.audioConfiguration,
  undefined,
  "a refused reel drops its track on the retry",
);

// Stories and carousels reject it at creation too.
assert.equal(
  buildPostExtras({
    platform: "instagram",
    format: "short_form",
    coverUrl: null,
    instagram: { story: true, audioId: "abc" },
  }).platformSpecificData?.audioConfiguration,
  undefined,
  "a story carries no catalog audio",
);
assert.equal(
  buildPostExtras({
    platform: "instagram",
    format: "short_form",
    coverUrl: null,
    carousel: true,
    instagram: { audioId: "abc" },
  }).platformSpecificData,
  undefined,
  "a carousel carries no catalog audio",
);

console.log("options builder: instagram catalog audio checks passed");
