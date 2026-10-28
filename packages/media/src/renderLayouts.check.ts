/**
 * Layout render check: plan shape for fill / fit / split / screenshare and a
 * real ffmpeg run on a tiny generated source, so the filtergraph is proven
 * to parse and produce the right output size. Needs ffmpeg on PATH (CI
 * installs it, same as instagramCopy.check).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { edlFromDoc, emptyDoc, setClipLayout, setShotAdjust, outputSize, setAspect, type EditDoc } from "@toreroflow/core";
import { buildRenderPlan } from "./renderEdit";

let passed = 0;
function ok(cond: boolean, message: string) {
  if (!cond) throw new Error(message);
  passed++;
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tf-layouts-"));
const src = path.join(dir, "src.mp4");
execFileSync("ffmpeg", [
  "-v", "error", "-y",
  "-f", "lavfi", "-i", "testsrc2=size=640x360:rate=30:duration=2",
  "-f", "lavfi", "-i", "sine=frequency=440:duration=2",
  "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", src,
]);
const assets = [{ id: "a", kind: "clip", path: src, durationSec: 2, width: 640, height: 360 }];

function plan(doc: EditDoc, name: string) {
  const { width, height } = outputSize(doc.output.aspect, 360);
  const outPath = path.join(dir, `${name}.mp4`);
  const p = buildRenderPlan({
    doc,
    edl: edlFromDoc(doc, { a: 2 }),
    assets,
    assPath: null,
    out: { path: outPath, width, height, fps: 30, format: "mp4", videoBitrateK: 800 },
  });
  return { p, outPath, width, height, fc: p.args[p.args.indexOf("-filter_complex") + 1] };
}

function render(name: string, doc: EditDoc) {
  const r = plan(doc, name);
  execFileSync("ffmpeg", r.p.args.filter((a) => a !== "-progress" && a !== "pipe:1"), { stdio: "pipe" });
  const dims = execFileSync("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", r.outPath,
  ]).toString().trim();
  ok(dims === `${r.width},${r.height}`, `${name}: output ${dims} != ${r.width}x${r.height}`);
  return r;
}

const base = emptyDoc(["a"]);
const fill = render("fill", setClipLayout(base, "a", { kind: "fill", fitBg: "blur" }));
ok(/crop=202:360:219:0,scale=360:640/.test(fill.fc), `fill crops the centered 9:16 window: ${fill.fc}`);

const fit = render("fit", setClipLayout(base, "a", { kind: "fit", fitBg: "blur" }));
ok(fit.fc.includes("boxblur") && fit.fc.includes("overlay"), "fit blur builds a blurred cover under the frame");
const fitColor = plan(setClipLayout(base, "a", { kind: "fit", fitBg: "color", bgColor: "#ff8800" }), "fitc");
ok(fitColor.fc.includes("color=0xff8800"), "fit color pads with the chosen color");

const split = render("split", setClipLayout(base, "a", { kind: "split", fitBg: "blur" }));
ok(split.fc.includes("vstack=inputs=2"), "split stacks two crops");

const screen = render("screenshare", setClipLayout(base, "a", { kind: "screenshare", fitBg: "blur" }));
ok(screen.fc.includes("vstack=inputs=2"), "screenshare stacks screen over face");

// Manual override mid-clip splits the segment and changes layout there only.
const adj = render("adjust", setShotAdjust(base, "a", { start: 1, end: 2, layout: "split" }));
ok((adj.fc.match(/concat=n=2/) ?? []).length === 1, "override at 1s splits the clip into two pieces");
ok(adj.fc.includes("pad=360:640"), "first piece keeps the v1 letterbox");

// Auto shots: a tracked fill pans by expression, a static one is a plain crop.
const tracked: EditDoc = {
  ...base,
  shots: {
    a: [
      {
        start: 0, end: 2, layout: "fill", auto: true, crops: [{ x: -0.2, y: 0, w: 1, h: 1 }],
        keys: [
          { t: 0, x: -0.2, y: 0, zoom: 1, ease: "linear" },
          { t: 2, x: 0.2, y: 0, zoom: 1, ease: "linear" },
        ],
      },
    ],
  },
};
const track = render("tracked", tracked);
ok(/crop=202:360:x='if\(lt\(\(t\+0\),0\),91,if\(lt\(\(t\+0\),2\),91\+\(256\)/.test(track.fc), `tracked fill pans from the first key to the last: ${track.fc}`);
const still = render("autoStill", { ...base, shots: { a: [{ start: 0, end: 2, layout: "fill", auto: true, crops: [{ x: 0.2, y: 0, w: 1, h: 1 }] }] } });
ok(/crop=202:360:347:0,/.test(still.fc), "static auto shot crops at its rect");

// Other aspects render at their own size.
render("square", setClipLayout(setAspect(base, "1:1"), "a", { kind: "fill", fitBg: "blur" }));
render("wide", setAspect(base, "16:9"));

fs.rmSync(dir, { recursive: true, force: true });
console.log(`renderLayouts.check: ${passed} passed`);
