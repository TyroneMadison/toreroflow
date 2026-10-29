/**
 * Phase 7 render features in buildRenderPlan: transitions, face-anchored
 * zooms, colour emoji, progress bar, enhance and censor audio. Pure args
 * checks, then (when ffmpeg is on PATH) one real render of synthetic clips
 * so the filtergraph is proven to parse and run.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { edlFromDoc, emptyDoc, type EditDoc } from "@toreroflow/core";
import { buildRenderPlan } from "./renderEdit";

let passed = 0;
const ok = (c: boolean, m: string) => {
  assert.ok(c, m);
  passed++;
};

const base = emptyDoc(["a", "b"]);
const doc: EditDoc = {
  ...base,
  transitions: { auto: "crossfade", dur: 0.4 },
  enhance: { on: true, lufs: -14 },
  censor: { mask: true, audio: "bleep", words: ["darn"] },
  overlays: { progress: { on: true, color: "#ff5a36", position: "bottom", height: 12 } },
};
const edl = edlFromDoc(doc, { a: 2, b: 2 });
const tmp = mkdtempSync(join(tmpdir(), "p7-"));
const assets = [
  { id: "a", kind: "clip", path: join(tmp, "a.mp4"), durationSec: 2, width: 1080, height: 1920 },
  { id: "b", kind: "clip", path: join(tmp, "b.mp4"), durationSec: 2, width: 1080, height: 1920 },
];
const out = { path: join(tmp, "out.mp4"), width: 540, height: 960, fps: 30, format: "mp4" as const, videoBitrateK: 2000 };
const emojiDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../assets/emoji");
const plan = buildRenderPlan({
  doc,
  edl,
  assets,
  assPath: null,
  out,
  emoji: { dir: emojiDir, overlays: [{ file: "1f525.png", start: 0.5, end: 1.5, x: 100, y: 200, size: 80 }] },
  censorSpans: [{ start: 1, end: 1.3 }],
});
const j = plan.args.join(" ");
ok(plan.totalOutSec === 4, "transitions keep the length");
ok(j.includes("xfade=transition=fade:duration=0.4:offset=2"), "xfade at the clip join");
ok(j.includes("tpad=stop_mode=clone:stop_duration=0.4"), "outgoing side frozen for the dur");
ok(j.includes("concat=n=2:v=0:a=1[acat]"), "audio stays a plain concat");
ok(j.includes("1f525.png"), "emoji png input");
ok(j.includes("overlay=x=100:y=200:enable='between(t,0.5,1.5)'"), "emoji overlay gated");
ok(j.includes("overlay=x='-W+W*t/4'"), "progress bar slides to full at the end");
ok(j.includes("highpass=f=80") && j.includes("loudnorm=I=-14") && j.includes("aresample=48000"), "enhance chain");
ok(j.includes("volume=0:enable='between(t,1,1.3)'"), "voice muted in the span");
ok(j.includes("sine=frequency=1000") && j.includes("[bleep]"), "bleep mixed in");

// No transition at a jump cut inside one clip.
const one = emptyDoc(["a"]);
const plain = buildRenderPlan({
  doc: { ...one, transitions: { auto: "crossfade", dur: 0.4 } },
  edl: edlFromDoc(one, { a: 2 }),
  assets,
  assPath: null,
  out,
});
ok(!plain.args.join(" ").includes("xfade"), "single clip: no xfade");

// Face anchor: a face at the right of the frame moves the zoompan x off centre.
const zdoc: EditDoc = { ...one, zooms: [{ id: "z", at: 0.2, kind: "pushin", size: "m", anchor: "face" }] };
const track = { fps: 10, w: 1080, h: 1920, frames: [{ t: 0.2, faces: [{ x: 700, y: 400, w: 200, h: 200 }] }] } as never;
const zp = buildRenderPlan({ doc: zdoc, edl: edlFromDoc(zdoc, { a: 2 }), assets, assPath: null, out, faceTracks: { a: track } });
const zj = zp.args.join(" ");
ok(zj.includes("zoompan"), "face zoom renders");
ok(!zj.includes("x='iw/2-(iw/zoom/2)'"), "face track moves the zoom x");

// Real run when ffmpeg exists.
const ff = spawnSync("ffmpeg", ["-version"]);
if (ff.status === 0) {
  for (const [p, c] of [
    [assets[0].path, "red"],
    [assets[1].path, "blue"],
  ]) {
    const r = spawnSync("ffmpeg", ["-y", "-v", "error", "-f", "lavfi", "-i", `color=c=${c}:s=1080x1920:r=30:d=2`, "-f", "lavfi", "-i", "sine=frequency=300:duration=2:sample_rate=48000", "-shortest", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", p]);
    assert.equal(r.status, 0, String(r.stderr));
  }
  const r = spawnSync("ffmpeg", plan.args.map((a) => (a === "pipe:1" ? "pipe:1" : a)), { maxBuffer: 64 << 20 });
  ok(r.status === 0, `real render runs: ${String(r.stderr).slice(-800)}`);
  ok(existsSync(out.path) && statSync(out.path).size > 1000, "output written");
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", out.path]);
  const dur = Number(String(probe.stdout).trim());
  ok(Math.abs(dur - 4) < 0.2, `output is 4s (got ${dur})`);
}
console.log(`renderPolish.check: ${passed} passed`);
