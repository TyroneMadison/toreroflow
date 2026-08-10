/**
 * Pins buildRenderPlan (pure). Expectations are substrings of the joined
 * args on purpose, so legitimate filter reordering does not break the check.
 */

import assert from "node:assert/strict";
import { addCut, edlFromDoc, emptyDoc, type EditDoc } from "@toreroflow/core";
import { buildRenderPlan } from "./renderEdit";

// One 10s clip with a cut [2,3] makes two segments: [0,2] and [3,10].
let doc = emptyDoc(["a"]);
doc = addCut(doc, "a", { start: 2, end: 3 });
const edl = edlFromDoc(doc, { a: 10 });
const assets = [
  { id: "a", kind: "clip", path: "C:\\store\\a.mp4", durationSec: 10, width: 1080, height: 1920 },
];
const out = {
  path: "C:\\out\\render-1.mp4",
  width: 1080,
  height: 1920,
  fps: 30,
  format: "mp4" as const,
  videoBitrateK: 10000,
};

const plan = buildRenderPlan({ doc, edl, assets, assPath: null, out });
const joined = plan.args.join(" ");

assert.equal(plan.totalOutSec, 9, "two segments total 9s");
assert.ok(joined.includes("trim=start=0:end=2"), "first segment video trim");
assert.ok(joined.includes("trim=start=3:end=10"), "second segment video trim");
assert.ok(joined.includes("atrim=start=3:end=10"), "audio trim mirrors video");
assert.ok(joined.includes("concat=n=2:v=1:a=1"), "concat pairs both segments");
assert.ok(joined.includes("-b:v 10000k"), "bitrate flag");
assert.ok(joined.includes("-maxrate 15000k"), "maxrate is 1.5x");
assert.ok(joined.includes("-bufsize 20000k"), "bufsize is 2x");
assert.ok(joined.includes("pad=1080:1920"), "pad to the exact output size");
assert.ok(!joined.includes("subtitles="), "no subtitles filter without an ass file");
assert.ok(joined.includes("+faststart"), "mp4 gets faststart");
assert.ok(joined.includes("-f mp4"), "mp4 container");
assert.ok(joined.includes("-progress pipe:1"), "progress goes to stdout");
assert.equal(plan.args.filter((a) => a === "-i").length, 1, "one -i per unique path");
assert.equal(plan.args[plan.args.length - 1], "C:\\out\\render-1.mp4", "output path last");

// mov container with captions: subtitles filter present, path escaped, no faststart.
const plan2 = buildRenderPlan({
  doc,
  edl,
  assets,
  assPath: "C:\\out\\captions.ass",
  fontsDir: "C:\\repo\\assets\\fonts",
  out: { ...out, path: "C:\\out\\render-1.mov", format: "mov" },
});
const joined2 = plan2.args.join(" ");
assert.ok(joined2.includes("subtitles=filename=C\\:/out/captions.ass"), "escaped ass path");
assert.ok(joined2.includes("fontsdir=C\\:/repo/assets/fonts"), "fontsdir rides along");
assert.ok(!joined2.includes("+faststart"), "mov skips faststart");
assert.ok(joined2.includes("-f mov"), "mov container");

// A zoom item lands as a zoompan on the segment that contains its at.
const zoomDoc: EditDoc = { ...doc, zooms: [{ id: "z1", at: 3, kind: "punchin", size: "m" }] };
const plan3 = buildRenderPlan({ doc: zoomDoc, edl, assets, assPath: null, out });
assert.ok(plan3.args.join(" ").includes("zoompan=z="), "zoom item renders via zoompan");

// Broll gates with enable, audio items are delayed and amixed over clip audio.
const ovDoc: EditDoc = {
  ...doc,
  broll: [
    {
      id: "b1",
      assetId: "b",
      at: 1,
      dur: 2.5,
      x: 0,
      y: 0,
      scale: 0.45,
      shape: "full",
      volume: 100,
      fadeIn: 0,
      fadeOut: 0,
    },
  ],
  audio: [{ id: "m1", assetId: "m", at: 0.5, dur: 4, volume: 80, kind: "music" }],
};
const plan4 = buildRenderPlan({
  doc: ovDoc,
  edl,
  assets: [
    ...assets,
    { id: "b", kind: "clip", path: "C:\\store\\b.mp4", durationSec: 6, width: 1080, height: 1920 },
    { id: "m", kind: "audio", path: "C:\\store\\m.mp3", durationSec: 30, width: 0, height: 0 },
  ],
  assPath: null,
  out,
});
const joined4 = plan4.args.join(" ");
assert.ok(joined4.includes("enable='between(t,1,3.5)'"), "broll gated to its window");
assert.ok(joined4.includes("adelay=500"), "audio item delayed to its at");
assert.ok(joined4.includes("volume=0.8"), "audio item volume applied");
assert.ok(joined4.includes("amix=inputs=2"), "clip audio plus one item");
assert.ok(joined4.includes("atrim=start=0:end=4"), "no srcIn means the take starts at 0");
assert.equal(plan4.args.filter((a) => a === "-i").length, 3, "three unique inputs");

// Detached clip audio carries a source offset; losing it would restart a
// trimmed clip's sound from the top of the take, quietly out of sync.
{
  const plan5 = buildRenderPlan({
    doc: {
      ...ovDoc,
      audio: [{ id: "d1", assetId: "m", at: 1, dur: 4, volume: 100, kind: "detached", srcIn: 2.5 }],
    },
    edl,
    assets: [
      ...assets,
      { id: "b", kind: "clip", path: "C:\\store\\b.mp4", durationSec: 6, width: 1080, height: 1920 },
      { id: "m", kind: "audio", path: "C:\\store\\m.mp3", durationSec: 30, width: 0, height: 0 },
    ],
    assPath: null,
    out,
  });
  const joined5 = plan5.args.join(" ");
  assert.ok(joined5.includes("atrim=start=2.5:end=6.5"), "srcIn shifts the audio trim window");
}

// A partial clipFx entry (an old doc, or a bug that shipped one) must not
// take the whole render down; missing color reads as no adjustment.
{
  const plan6 = buildRenderPlan({
    doc: { ...doc, clipFx: { a: { volume: 0 } as never } },
    edl,
    assets,
    assPath: null,
    out,
  });
  assert.ok(plan6.args.length > 0, "a color-less clipFx entry still plans");
  assert.ok(plan6.args.join(" ").includes("volume=0"), "and its volume is honored");
}

// An empty edit refuses to plan.
assert.throws(
  () => buildRenderPlan({ doc, edl: [], assets, assPath: null, out }),
  /empty/,
  "empty edl throws",
);

console.log("renderEdit.check: all assertions passed");
