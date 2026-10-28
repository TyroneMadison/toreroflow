/**
 * v1 fixtures for the golden render check. The expected args were generated
 * once from the pre-revamp renderEdit (origin/main 3512912) and committed in
 * __golden__/renderEdit.v1.json; new render features must only add filters
 * when a doc uses them, so these plans stay byte-identical.
 */
import { DEFAULT_CLIP_FX, addCut, edlFromDoc, emptyDoc, type EditDoc } from "@toreroflow/core";

export function goldenCases(): { name: string; input: unknown }[] {
  const out = { path: "/out/r.mp4", width: 1080, height: 1920, fps: 30, format: "mp4" as const, videoBitrateK: 8000 };
  const assets = [
    { id: "a", kind: "clip", path: "/s/a.mp4", durationSec: 10, width: 1080, height: 1920 },
    { id: "b", kind: "clip", path: "/s/b.mp4", durationSec: 6, width: 1920, height: 1080 },
    { id: "r", kind: "broll", path: "/s/r.mp4", durationSec: 4, width: 1920, height: 1080 },
    { id: "m", kind: "audio", path: "/s/m.mp3", durationSec: 30, width: 0, height: 0 },
  ];
  let d: EditDoc = emptyDoc(["a", "b"]);
  d = addCut(d, "a", { start: 2, end: 3 });
  const plain = { doc: d, edl: edlFromDoc(d, { a: 10, b: 6 }), assets, assPath: null, out };
  const rich: EditDoc = {
    ...d,
    zooms: [{ id: "z", at: 4, kind: "punchin", size: "m" }],
    clipFx: { a: { ...DEFAULT_CLIP_FX, volume: 80 } },
    broll: [{ id: "x", assetId: "r", at: 1, dur: 2, x: 0, y: 0, scale: 0.5, shape: "rounded", volume: 100, fadeIn: 0.2, fadeOut: 0.2 }],
    audio: [{ id: "u", assetId: "m", at: 0, dur: 8, volume: 40 } as never],
  };
  const richIn = { doc: rich, edl: edlFromDoc(rich, { a: 10, b: 6 }), assets, assPath: "/o/c.ass", fontsDir: "/f", out };
  return [
    { name: "plain-two-clips", input: plain },
    { name: "zoom-broll-music-captions", input: richIn },
  ];
}
