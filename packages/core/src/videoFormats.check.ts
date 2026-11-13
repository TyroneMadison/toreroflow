import assert from "node:assert/strict";
import { VIDEO_FORMATS, VIDEO_FORMAT_GUIDE, cleanVideoFormat } from "./videoFormats";

assert.equal(new Set(VIDEO_FORMATS.map((f) => f.toLowerCase())).size, VIDEO_FORMATS.length, "no duplicate formats");
for (const f of VIDEO_FORMATS) assert.ok(VIDEO_FORMAT_GUIDE[f], `guide line for ${f}`);
assert.ok(!VIDEO_FORMATS.some((f) => /[\u2013\u2014]/.test(f)), "no dashes in labels");
assert.equal(cleanVideoFormat("ranking"), "Ranking");
assert.equal(cleanVideoFormat(" Comparison "), "Comparison");
assert.equal(cleanVideoFormat("nonsense"), "");
console.log("videoFormats ok");
import { FORMAT_FUNNEL_WEIGHTS, reconcileFunnel, formatsForStage, bestStageFor } from "./videoFormats";
for (const f of VIDEO_FORMATS) {
  const w = FORMAT_FUNNEL_WEIGHTS[f];
  assert.ok(Math.abs(w.top + w.middle + w.bottom - 1) < 1e-9, `weights sum to 1 for ${f}`);
}
assert.equal(bestStageFor("Ranking"), "bottom");
assert.equal(bestStageFor("Storytelling"), "top");
assert.ok(formatsForStage("middle").includes("Comparison") && formatsForStage("bottom").includes("Comparison"));
assert.deepEqual(reconcileFunnel("Ranking", "top"), { format: "Ranking", funnelStage: "bottom" });
assert.deepEqual(reconcileFunnel("Comparison", "bottom"), { format: "Comparison", funnelStage: "bottom" });
assert.deepEqual(reconcileFunnel("Skits", null), { format: "Skits", funnelStage: "top" });
assert.deepEqual(reconcileFunnel("junk", "middle"), { format: "", funnelStage: "middle" });
console.log("funnel weights ok");
