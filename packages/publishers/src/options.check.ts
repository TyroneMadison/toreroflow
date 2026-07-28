// Local so the file stays part of the package's typecheck without pulling
// in node's assert types beyond the existing @types/node devDependency.
import assert from "node:assert/strict";
import { buildPostExtras } from "./options";

// Instagram short-form with every option set.
const ig = buildPostExtras({
  platform: "instagram",
  format: "short_form",
  coverUrl: "https://cdn.example/cover.jpg",
  instagram: {
    trial: true,
    graduationStrategy: "SS_PERFORMANCE",
    collaborators: ["caleb", "torerone"],
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
  collaborators: ["caleb", "torerone"],
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
