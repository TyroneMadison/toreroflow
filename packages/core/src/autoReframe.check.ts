/**
 * The five auto reframe cases from the master prompt (section 3.5) on
 * synthetic face tracks, plus the smoothing and key lookup they rely on.
 */
import { applyAutoShots, emptyDoc, type EditDoc } from "./editDoc";
import { autoReframe, faceStats, keyAt, layoutAt, REFRAME, trackingKeys, type FaceBox, type FaceTrack } from "./reframe";

let passed = 0;
function ok(cond: boolean, message: string) {
  if (!cond) throw new Error(message);
  passed++;
}
const near = (a: number, b: number, eps = 0.02) => Math.abs(a - b) <= eps;

const FPS = 5;
/** A track from a function of time returning that sample's faces. */
function track(dur: number, at: (t: number, i: number) => FaceBox[], w = 1920, h = 1080): FaceTrack {
  const frames = [];
  for (let i = 0; i < Math.round(dur * FPS); i++) {
    const t = i / FPS;
    frames.push({ t, faces: at(t, i) });
  }
  return { fps: FPS, w, h, frames };
}
/** A face centered at cx/cy; talking faces get a churning mouth, others the codec floor. */
function face(cx: number, i: number, talking: boolean, opts: { cy?: number; size?: number; still?: boolean } = {}): FaceBox {
  const size = opts.size ?? 0.2;
  const wob = opts.still ? 0 : Math.sin(i * 1.7) * 0.012;
  return {
    x: cx - size * 0.28 + wob,
    y: (opts.cy ?? 0.4) - size / 2,
    w: size * 0.56,
    h: size,
    score: 0.9,
    mouth: talking ? 0.03 + 0.05 * Math.abs(Math.sin(i * 2.3)) : opts.still ? 0 : 0.0008,
  };
}
const OUT = { W: 1080, H: 1920 };
// 9:16 fill on 16:9 is a 0.316-wide window, the number the spec quotes.
const FILL_W = (9 / 16) / (16 / 9);

// 1. Single-camera talking head: one static fill shot on the face.
{
  const tr = track(20, (_t, i) => [face(0.6, i, true)]);
  const shots = autoReframe(tr, [], 20, OUT);
  ok(shots.length === 1 && shots[0].layout === "fill", "talking head: one fill shot");
  ok(near(shots[0].crops[0].x, 0.1) && near(shots[0].crops[0].w, FILL_W, 0.002), "talking head: full-height crop on the face");
  ok(!shots[0].keys, "talking head: static, no keys");
}

// 2. Two-camera podcast: alternating fill shots at the cuts, no pans.
{
  const tr = track(30, (t, i) => [face(t >= 10 && t < 20 ? 0.62 : 0.38, i, true)]);
  const shots = autoReframe(tr, [10, 20], 30, OUT);
  ok(shots.length === 3 && shots.every((s) => s.layout === "fill"), "podcast: three fill shots");
  ok(shots[0].start === 0 && shots[1].start === 10 && shots[2].start === 20, "podcast: layout changes only at camera cuts");
  ok(shots[0].crops[0].x < 0 && shots[1].crops[0].x > 0 && shots[2].crops[0].x < 0, "podcast: crops alternate with the speaker");
  ok(shots.every((s) => !s.keys), "podcast: no pans");
}

// 3. Wide two-shot with both talking: split, one crop on each face.
{
  const tr = track(12, (t, i) => {
    const left = Math.floor(t / 2) % 2 === 0;
    return [face(0.22, i, left), face(0.78, i + 3, !left)];
  });
  const shots = autoReframe(tr, [], 12, OUT);
  ok(shots.length === 1 && shots[0].layout === "split", "two-shot: split");
  const [a, b] = shots[0].crops;
  ok(a.x < -0.15 && b.x > 0.15, "two-shot: left face on top, right face below");
  ok(near(a.x, -0.28, 0.06) && near(b.x, 0.28, 0.06), "two-shot: crops centered on the faces");
  // Panel aspect 1080x960 = 9:8, the ratio the spec names for split crops.
  ok(near((a.w * 1920) / (a.h * 1080), 9 / 8, 0.01), "two-shot: each crop is 9:8");
}

// 4. A poster in the background is fake: never framed, even when alone.
{
  const tr = track(15, (t, i) => {
    const poster = face(0.85, i, false, { still: true, size: 0.15 });
    return t < 10 ? [face(0.4, i, true), poster] : [poster];
  });
  const shots = autoReframe(tr, [10], 15, OUT);
  ok(shots[0].layout === "fill" && near(shots[0].crops[0].x, -0.1), "poster: the talker is framed");
  ok(shots[1].layout === "fit", "poster: a shot with only the poster falls back to fit");
  ok(faceStats(tr).fakes === 1 && faceStats(tr).faces === 1, "poster: counted as one fake");
  // A quiet listener who moves is real, not a poster.
  const lis = track(10, (_t, i) => [face(0.3, i, true), face(0.7, i, false)]);
  ok(faceStats(lis).fakes === 0, "a silent but moving listener is real");
}

// 5. Walking vlog: the speaker crosses the frame, so smooth tracking keys.
{
  const tr = track(10, (t, i) => [face(0.2 + 0.06 * t, i, true)]);
  const shots = autoReframe(tr, [], 10, OUT);
  ok(shots.length === 1 && shots[0].layout === "fill", "vlog: one fill shot");
  const keys = shots[0].keys ?? [];
  ok(keys.length >= 3, `vlog: tracking keys present (${keys.length})`);
  let fastest = 0;
  for (let k = 1; k < keys.length; k++) {
    ok(keys[k].x >= keys[k - 1].x - 1e-6, "vlog: keys follow the walk one way");
    fastest = Math.max(fastest, (keys[k].x - keys[k - 1].x) / (keys[k].t - keys[k - 1].t));
  }
  ok(fastest <= REFRAME.maxSpeed + 1e-3, `vlog: pan speed capped (${fastest.toFixed(3)}/s)`);
  ok(keys[keys.length - 1].x > keys[0].x + 0.2, "vlog: the camera actually travels");
}

// Smoothing: a sway inside the dead zone never moves the camera.
{
  const ts = Array.from({ length: 50 }, (_, i) => i / 5);
  const keys = trackingKeys(ts, ts.map((_, i) => 0.5 + 0.03 * Math.sin(i)), 0);
  ok(keys.every((k) => k.x === 0), "dead zone: a 3% sway keeps the crop still");
}

// keyAt holds before/after and interpolates linear keys.
{
  const keys = [
    { t: 1, x: -0.1, y: 0, zoom: 1, ease: "linear" as const },
    { t: 3, x: 0.1, y: 0, zoom: 1, ease: "hold" as const },
    { t: 4, x: 0.2, y: 0, zoom: 1, ease: "linear" as const },
  ];
  ok(keyAt(keys, 0).x === -0.1 && keyAt(keys, 9).x === 0.2, "keyAt holds outside the keys");
  ok(near(keyAt(keys, 2).x, 0, 1e-9), "keyAt interpolates linear");
  ok(keyAt(keys, 3.5).x === 0.1, "keyAt holds on a hold key");
}

// layoutAt follows keys on an untouched auto fill shot; a drag stops them.
{
  let doc: EditDoc = emptyDoc(["a"]);
  const tr = track(10, (t, i) => [face(0.2 + 0.06 * t, i, true)]);
  doc = { ...doc, shots: { a: autoReframe(tr, [], 10, OUT) } };
  const early = layoutAt(doc, "a", "a", 0.5, 1920, 1080, 1080, 1920);
  const late = layoutAt(doc, "a", "a", 9.5, 1920, 1080, 1080, 1920);
  ok(!!early.keys?.length && late.crops[0].x > early.crops[0].x + 0.1, "layoutAt: crop follows the keys");
  doc = { ...doc, shotAdjust: { a: [{ start: 0, end: 10, crops: [{ x: 0, y: 0, w: 1, h: 1 }] }] } };
  const held = layoutAt(doc, "a", "a", 9.5, 1920, 1080, 1080, 1920);
  ok(!held.keys && near(held.crops[0].x, 0, 1e-9), "layoutAt: a manual crop is static");

  const base = emptyDoc(["a"]);
  const applied = applyAutoShots(base, "a", [{ start: 0, end: 10, layout: "split", auto: true, crops: [] }], "k/faces.json");
  ok(applied.shots.a.length === 1 && applied.faces?.a === "k/faces.json", "applyAutoShots stores shots and faces");
  ok(applied.layout === base.layout && applied.shotAdjust === base.shotAdjust, "applyAutoShots leaves layouts and overrides");
}

console.log(`autoReframe.check: ${passed} passed`);
