import assert from "node:assert/strict";
import {
  cleanHookClassification, keepNicheFit, unseenVideos, sampleInspiration, topPerformers,
  normalizeHookText, hookFromCaption, inspirationPrompt, FALLBACK_FORMAT, HOOK_NICHE_MIN,
} from "./hookLibrary";

// niche threshold
const scored = [{ t: "a", nicheScore: 0.49 }, { t: "b", nicheScore: 0.5 }, { t: "c", nicheScore: 0.9 }];
assert.deepEqual(keepNicheFit(scored).map((h) => h.t), ["b", "c"], "keeps >= 0.5 only");
assert.equal(HOOK_NICHE_MIN, 0.5);

// format validation
const ok = cleanHookClassification({ format: "ranking", funnelStage: "bottom", nicheScore: 0.7, reworded: "New line" }, "Old line");
assert.equal(ok.format, "Ranking", "case-insensitive match to the 17");
assert.equal(ok.funnelStage, "bottom");
const bad = cleanHookClassification({ format: "Vlog montage", funnelStage: "nonsense", nicheScore: 7 });
assert.equal(bad.format, FALLBACK_FORMAT, "unknown format falls back");
assert.equal(bad.funnelStage, "middle", "stage follows the fallback format");
assert.equal(bad.nicheScore, 1, "score clamped");
assert.equal(cleanHookClassification({ nicheScore: "x" }).nicheScore, 0);
assert.equal(cleanHookClassification({ reworded: "Same line!" }, "same line").reworded, null, "unchanged reword dropped");
assert.equal(cleanHookClassification({ format: "Skits", funnelStage: "bottom" }).funnelStage, "top", "mismatched stage reconciled");

// seen-video skipping
const vids = [{ videoId: "a" }, { videoId: "b" }, { videoId: "b" }, { videoId: "c" }, { videoId: "d" }];
assert.deepEqual(unseenVideos(vids, ["a"]).map((v) => v.videoId), ["b", "c", "d"], "seen and repeats skipped");
assert.deepEqual(unseenVideos(vids, ["a"], 2).map((v) => v.videoId), ["b", "c"], "capped");
assert.equal(unseenVideos(vids, ["a", "b", "c", "d"]).length, 0);

// inspiration sampler
const lib = [
  { text: "1", sourceType: "OWN", format: "Ranking", funnelStage: "bottom", nicheScore: 0.6, stats: { lift: 3 } },
  { text: "2", sourceType: "WEB", format: "Ranking", funnelStage: "bottom", nicheScore: 0.95 },
  { text: "3", sourceType: "CREATOR", format: "Skits", funnelStage: "top", nicheScore: 0.7 },
  { text: "4", sourceType: "CREATOR", format: "Ranking", funnelStage: "middle", nicheScore: 0.8 },
  { text: "5", sourceType: "WEB", format: "Comparison", funnelStage: "middle", nicheScore: 0.55 },
];
const s3 = sampleInspiration(lib, 3);
assert.equal(s3.length, 3);
assert.equal(s3[0]!.text, "1", "proven performer first");
assert.deepEqual(new Set(s3.map((h) => h.format)).size, 3, "three different formats before any repeat");
assert.equal(sampleInspiration(lib, 8).length, 5, "never more than the library");
assert.equal(sampleInspiration(lib, 4)[3]!.text, "4", "second Ranking is the one with a new stage");
assert.equal(sampleInspiration([], 8).length, 0);
assert.ok(inspirationPrompt(s3).includes("never copy"));
assert.equal(inspirationPrompt([]), "");

// own top performers
const posts = [10, 12, 11, 40, 9].map((views, i) => ({ videoId: `v${i}`, account: "yt", hook: `Hook ${i}`, views, likes: 1 }));
const top = topPerformers(posts);
assert.deepEqual(top.map((p) => p.videoId), ["v3"], "only the post well above the median");
assert.equal(top[0]!.stats.lift, 3.6);
assert.equal(topPerformers(posts.slice(0, 2)).length, 0, "too few posts for a median");

assert.equal(normalizeHookText("  Stop. Before you RENT!  "), "stop before you rent");
assert.equal(hookFromCaption("\nWatch this first\nsecond line #ad"), "Watch this first");
assert.equal(hookFromCaption("Big news #rentals #cars"), "Big news");
console.log("hookLibrary ok");
