import {
  appendClip,
  emptyDoc,
  migrateDoc,
  moveClip,
  newClipId,
  outputSize,
  removeClip,
  setAspect,
  setClipLayout,
  setShotAdjust,
  splitClip,
  SRC_END,
  clearShotAdjust,
  type EditDocV1,
} from "./editDoc";
import { edlFromDoc } from "./edl";
import {
  applyClipFx,
  cropCss,
  cropPx,
  defaultCrops,
  fitRect,
  layoutAt,
  layoutBoundaries,
  panelsFor,
} from "./reframe";

let passed = 0;
function ok(cond: boolean, message: string) {
  if (!cond) throw new Error(message);
  passed++;
}
const near = (a: number, b: number, e = 1e-6) => Math.abs(a - b) < e;

// --- migrateDoc: v1 -> v2 keeps clip ids = asset ids and the full source.
const v1: EditDocV1 = {
  v: 1,
  clips: [{ assetId: "a" }, { assetId: "b" }],
  cuts: { a: [{ start: 1, end: 2 }] },
  splits: {},
  wordEdits: {},
  broll: [],
  graphics: [],
  zooms: [],
  sfx: [],
  music: [],
  clipFx: {},
  captions: emptyDoc([]).captions,
} as unknown as EditDocV1;
const m = migrateDoc(v1);
ok(m.v === 2, "migrated to v2");
ok(m.clips[0].id === "a" && m.clips[0].srcIn === 0 && m.clips[0].srcOut === SRC_END, "v1 clip spans the source");
ok(m.output.aspect === "9:16", "v1 aspect is 9:16");
ok(migrateDoc(m) === m, "v2 passes through by reference");
ok(edlFromDoc(m, { a: 10, b: 5 }).length === 3, "migrated EDL still honours cuts");

// --- clip operations
let d = emptyDoc(["a"]);
ok(newClipId(d, "a") === "a~2", "second clip of an asset gets a suffix");
d = splitClip(d, d.clips[0].id, 4);
ok(d.clips.length === 2 && d.clips[0].srcOut === 4 && d.clips[1].srcIn === 4, "split at source 4");
const edl = edlFromDoc(d, { a: 10 });
ok(edl.length === 2 && edl[1].clipId === d.clips[1].id, "EDL carries clip ids");
d = moveClip(d, d.clips[1].id, 0);
ok(d.clips[0].srcIn === 4, "move reorders");
d = appendClip(d, "b");
d = removeClip(d, d.clips[0].id);
ok(d.clips.length === 2, "remove drops one clip");

// --- output sizes keep the v1 9:16 numbers.
const s916 = outputSize("9:16", 1080);
ok(s916.width === 1080 && s916.height === 1920, "9:16 1080 = 1080x1920");
const s169 = outputSize("16:9", 1080);
ok(s169.width === 1920 && s169.height === 1080, "16:9 1080 = 1920x1080");
const s11 = outputSize("1:1", 1080);
ok(s11.width === 1080 && s11.height === 1080, "1:1 square");
ok(setAspect(d, "1:1").output.aspect === "1:1", "setAspect");

// --- panels
const [p0, p1] = panelsFor("split", 1080, 1920);
ok(p0.h + p1.h === 1920 && p1.y === p0.h, "split panels tile the frame");
const ss = panelsFor("screenshare", 1080, 1920);
ok(ss[0].h === 1152 && ss[1].h === 768, "screenshare 60/40");

// --- fitRect: aspect and bounds
const srcA = 16 / 9;
const r = fitRect({ x: 0.45, y: 0, w: 0.2, h: 1 }, 9 / 16, srcA);
ok(near((r.w / r.h) * srcA, 9 / 16), "fitRect forces the panel aspect");
ok(r.x + r.w / 2 <= 0.5 + 1e-9, "fitRect clamps inside the frame");
const fill = defaultCrops("fill", 1080, 1920, srcA)[0];
ok(near(fill.h, 1) && near(fill.x, 0), "default fill is a full-height centered crop");
const sp = defaultCrops("split", 1080, 1920, srcA);
ok(sp[0].x < 0 && sp[1].x > 0, "split defaults look left and right");

// --- cropPx: even and in bounds
const px = cropPx(fill, 1920, 1080);
ok(px.w % 2 === 0 && px.h === 1080 && px.x === Math.round((1920 - px.w) / 2), "centered pixel crop");
ok(near(px.w, 608, 2), "9:16 of 1080 tall is ~608 wide");
const css = cropCss({ x: 0, y: 0, w: 0.5, h: 1 });
ok(near(css.width, 200) && near(css.left, -50), "css crop centers a half-width window");

// --- clipFx zoom/move inside a crop
const z = applyClipFx(fill, { zoom: 2, x: 0, y: 0 }, 9 / 16, srcA);
ok(near(z.h, 0.5), "zoom 2 halves the window");

// --- resolution precedence: legacy < shot < clip layout < manual override
let L = emptyDoc(["a"]);
ok(layoutAt(L, "a", "a", 1, 1920, 1080, 1080, 1920).kind === "legacy", "no layout = legacy (golden path)");
L = { ...L, shots: { a: [{ start: 0, end: 5, layout: "split", crops: [], auto: true }] } };
ok(layoutAt(L, "a", "a", 1, 1920, 1080, 1080, 1920).kind === "split", "auto shot applies on auto layout");
ok(layoutAt(L, "a", "a", 6, 1920, 1080, 1080, 1920).kind === "legacy", "outside the shot is legacy");
L = setClipLayout(L, "a", { kind: "fill", fitBg: "blur" });
ok(layoutAt(L, "a", "a", 1, 1920, 1080, 1080, 1920).kind === "fill", "chosen clip layout beats the auto shot");
L = setShotAdjust(L, "a", { start: 2, end: 3, layout: "fit" });
const at = layoutAt(L, "a", "a", 2.5, 1920, 1080, 1080, 1920);
ok(at.kind === "fit" && at.manual && at.start === 2 && at.end === 3, "manual override wins inside its span");
const before = layoutAt(L, "a", "a", 1, 1920, 1080, 1080, 1920);
ok(before.end === 2, "span ends at the next override");
ok(JSON.stringify(layoutBoundaries(L, "a", 0, 10)) === "[2,3,5]", "boundaries listed in order");
L = setShotAdjust(L, "a", { start: 2.5, end: 4, layout: "split" });
ok(L.shotAdjust.a.length === 2 && L.shotAdjust.a[0].end === 2.5, "overlapping override trims the old one");
L = clearShotAdjust(L, "a", 0, 10);
ok(!L.shotAdjust.a, "clear removes overrides");

console.log(`reframe.check: ${passed} passed`);
