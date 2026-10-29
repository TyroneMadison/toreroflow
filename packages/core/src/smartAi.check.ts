import assert from "node:assert/strict";
import { rawScore, rankClips } from "./clipScore";
import {
  EVEN,
  applyVisual,
  blendTrend,
  languageHint,
  pickLanguage,
  transcriptSuspect,
  trendScore,
  trendTermsFrom,
  tuneJudge,
  tuningPrompt,
  visualFeatures,
} from "./smartAi";
import type { FaceTrack } from "./reframe";

// language
assert.deepEqual(pickLanguage({ forced: "es", detected: "en", prob: 0.99 }), { language: "es", source: "set" });
assert.deepEqual(pickLanguage({ detected: "fr", prob: 0.9 }), { language: "fr", source: "detected" });
assert.deepEqual(pickLanguage({ detected: "ar", prob: 0.31 }), { language: "en", source: "fallback" });
assert.deepEqual(pickLanguage({ detected: "ar", prob: 0.31, hint: "es" }), { language: "es", source: "fallback" });
assert.deepEqual(pickLanguage({ detected: "ar", prob: null }), { language: "en", source: "fallback" });
assert.deepEqual(pickLanguage({ detected: "en", prob: null }), { language: "en", source: "detected" });
assert.deepEqual(pickLanguage({}), { language: "en", source: "fallback" });
// The Phase 8 Drive job: "ar" with no probability recorded is suspect.
assert.equal(transcriptSuspect({ language: "ar" }), true);
assert.equal(transcriptSuspect({ language: "en" }), false);
assert.equal(transcriptSuspect({ language: "ar", languageSource: "set" }), false);
assert.equal(transcriptSuspect({ language: "ar", languageProb: 0.95, languageSource: "detected" }), false);
assert.equal(transcriptSuspect({ language: "ar", languageProb: 0.4, languageSource: "detected" }), true);
assert.equal(transcriptSuspect({ language: "es" }, "es"), false);
assert.equal(languageHint(["es", "en", "es", null]), "es");
assert.equal(languageHint([]), "en");

// visual
const track: FaceTrack = {
  fps: 5,
  w: 1280,
  h: 720,
  frames: Array.from({ length: 300 }, (_, i) => ({
    t: i / 5,
    faces: i / 5 < 30 ? [{ x: 0.4, y: 0.3, w: 0.2, h: 0.3, score: 0.9, mouth: 0.3 }] : [],
  })),
};
const face = visualFeatures([[0, 30]], [10, 20], track);
const empty = visualFeatures([[30, 60]], [], track);
assert.equal(face.facePct, 1);
assert.equal(empty.facePct, 0);
assert.ok(face.visual > empty.visual, `${face.visual} > ${empty.visual}`);
assert.match(face.note, /Face on screen 100%/);
assert.equal(empty.note, "No face on screen.");
assert.ok(face.visual <= 10 && empty.visual >= 0);
const none = visualFeatures([[0, 30]], [], null);
assert.equal(none.note, "No frame samples.");
const j = applyVisual({ hook: 5, flow: 5, value: 5, trend: 5, comments: { hook: "x" } }, face);
assert.ok(j.hook >= 6 && j.hook <= 7);
assert.equal(j.comments.hook, "x");
assert.ok(j.comments.visual);
assert.equal(applyVisual({ hook: 10, flow: 0, value: 10, trend: 0 }, face).hook, 10);

// trend
const tt = trendTermsFrom({
  niche: "Real estate investing",
  keywords: ["rental property"],
  topPosts: [
    { text: "How mortgage rates changed rental math", views: 1000 },
    { text: "Mortgage rates explained", views: 800 },
    { text: "my cat", views: 10 },
  ],
  liked: ["tenant screening tips", "tenant screening mistakes"],
});
const names = tt.map((t) => t.term);
for (const w of ["estate", "investing", "rental", "property", "mortgage", "rates", "tenant", "screening"]) assert.ok(names.includes(w), w);
assert.ok(!names.includes("cat"));
assert.equal(tt.find((t) => t.term === "estate")!.source, "niche");
const hot = trendScore("Mortgage rates are why your rental property cash flow died", tt);
const cold = trendScore("I made pancakes this morning", tt);
assert.ok(hot.score >= 8, String(hot.score));
assert.equal(cold.score, 0);
assert.ok(hot.hits.includes("mortgage"));
assert.equal(trendScore("anything", []).score, 0);
assert.equal(blendTrend(6, hot, false), 6);
assert.equal(blendTrend(5, { score: 10, hits: [] }, true), 8);

// judge tuning
assert.deepEqual(tuneJudge([]).weights, EVEN);
const samples = [
  { sub: { hook: 9, flow: 5, value: 5, trend: 5 }, feedback: "up", title: "Great opener" },
  { sub: { hook: 8, flow: 5, value: 6, trend: 5 }, feedback: null, perf: 2.1, title: "Posted winner" },
  { sub: { hook: 2, flow: 5, value: 5, trend: 5 }, feedback: "down:Starts mid-thought", title: "Mid start" },
  { sub: { hook: 3, flow: 6, value: 5, trend: 5 }, feedback: "down:Starts mid-thought", title: "Mid start 2" },
  { sub: { hook: 5, flow: 5, value: 5, trend: 5 }, feedback: null, title: "Unrated" },
];
const t = tuneJudge(samples);
assert.equal(t.n, 4);
assert.equal(t.reasons["Starts mid-thought"], 2);
assert.ok(t.weights.hook > 1.2, JSON.stringify(t.weights));
assert.ok(t.weights.flow < 1);
const avg = (t.weights.hook + t.weights.flow + t.weights.value + t.weights.trend) / 4;
assert.ok(Math.abs(avg - 1) < 0.05);
assert.deepEqual(t.examples.good, ["Great opener", "Posted winner"]);
assert.equal(t.examples.bad[0].reason, "Starts mid-thought");
assert.match(tuningPrompt(t), /hook x1\.\d+/);
assert.equal(tuningPrompt(tuneJudge(samples.slice(0, 2))), "");
// Weighted ranking flips a hook-strong clip above a flow-strong one.
const a = { hook: 9, flow: 3, value: 5, trend: 5 };
const b = { hook: 3, flow: 9, value: 5, trend: 5 };
assert.equal(rawScore(a), rawScore(b));
assert.equal(rankClips([b, a], false, t.weights)[0].item, a);
assert.equal(rawScore(a, false, EVEN), rawScore(a));

console.log("smartAi checks passed");
