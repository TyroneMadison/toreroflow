import {
  addCut,
  applyTemplate,
  CAPTION_TEMPLATES,
  DEFAULT_CAPTION_STYLE,
  DEFAULT_TEXT_STYLE,
  emptyDoc,
  normalizeCuts,
  removeCutsOverlapping,
  splitAt,
  toggleWordRemoved,
  ZOOM,
} from "./editDoc";

/** Local assert so the file typechecks with the app and needs no node types. */
function eq(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
  }
}

function deepEq(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) {
    throw new Error(`${message}\n  expected: ${b}\n  actual:   ${a}`);
  }
}

// emptyDoc shape
const doc = emptyDoc(["a", "b"]);
eq(doc.v, 1, "doc version is 1");
deepEq(doc.clips, [{ assetId: "a" }, { assetId: "b" }], "clips keep the given order");
deepEq(doc.cuts, {}, "no cuts yet");
deepEq(doc.splits, {}, "no splits yet");
deepEq(doc.wordEdits, {}, "no word edits yet");
deepEq(doc.color, { b: 0, c: 0, s: 0, w: 0 }, "universal color starts neutral");
eq(doc.captions.enabled, true, "captions start enabled");
eq(doc.captions.template, "classic", "classic is the starting template");
deepEq(doc.captions.style, DEFAULT_CAPTION_STYLE, "caption style starts at the default");
eq(doc.captions.style === DEFAULT_CAPTION_STYLE, false, "the default style object is never shared");
deepEq(
  doc.export,
  { name: "", resolution: 1080, fps: 30, format: "mp4", bitrate: "recommended" },
  "export defaults",
);
eq(DEFAULT_TEXT_STYLE.bold, true, "text default is bold");
eq(DEFAULT_TEXT_STYLE.color, "#FFFFFF", "text default is white");
eq(DEFAULT_TEXT_STYLE.outline.on, true, "text default outline is on");
eq(DEFAULT_TEXT_STYLE.outline.color, "#000000", "text default outline is black");
eq(DEFAULT_TEXT_STYLE.shadow.on, false, "text default shadow is off");
eq(DEFAULT_TEXT_STYLE.background.on, false, "text default background is off");
eq(DEFAULT_CAPTION_STYLE.wordsPerLine, 3, "captions default to 3 words per line");
eq(DEFAULT_CAPTION_STYLE.lines, 1, "captions default to 1 line");

// ZOOM table
eq(ZOOM.pushin.scale.s, 1.06, "push in small");
eq(ZOOM.pushin.scale.m, 1.12, "push in medium");
eq(ZOOM.pushin.scale.l, 1.2, "push in large");
eq(ZOOM.punchin.scale.s, 1.15, "punch in small");
eq(ZOOM.punchin.scale.m, 1.3, "punch in medium");
eq(ZOOM.punchin.scale.l, 1.5, "punch in large");
eq(ZOOM.quickzoom.scale.s, 1.2, "quick zoom small");
eq(ZOOM.quickzoom.scale.m, 1.4, "quick zoom medium");
eq(ZOOM.quickzoom.scale.l, 1.6, "quick zoom large");
eq(ZOOM.quickzoom.inSec, 0.15, "quick zoom ramps in over 0.15s");
eq(ZOOM.quickzoom.holdSec, 0.6, "quick zoom holds 0.6s");
eq(ZOOM.quickzoom.outSec, 0.15, "quick zoom ramps back over 0.15s");

// normalizeCuts: out of order input, overlap merge, adjacency merge, clamp
deepEq(
  normalizeCuts([
    { start: 5, end: 6 },
    { start: 1, end: 2 },
  ]),
  [
    { start: 1, end: 2 },
    { start: 5, end: 6 },
  ],
  "cuts sort by start",
);
deepEq(
  normalizeCuts([
    { start: 1, end: 3 },
    { start: 2, end: 4 },
  ]),
  [{ start: 1, end: 4 }],
  "overlapping cuts merge",
);
deepEq(
  normalizeCuts([
    { start: 1, end: 2 },
    { start: 2, end: 3 },
  ]),
  [{ start: 1, end: 3 }],
  "adjacent cuts merge",
);
deepEq(
  normalizeCuts([{ start: -2, end: 30 }], 10),
  [{ start: 0, end: 10 }],
  "cuts clamp to 0..duration",
);
deepEq(normalizeCuts([{ start: 3, end: 3 }]), [], "zero-width cuts drop, splits are separate");

// addCut normalizes and never mutates
let d = emptyDoc(["a"]);
const beforeAdd = JSON.stringify(d);
let d2 = addCut(d, "a", { start: 4, end: 6 });
d2 = addCut(d2, "a", { start: 1, end: 2 });
d2 = addCut(d2, "a", { start: 5, end: 8 });
deepEq(
  d2.cuts["a"],
  [
    { start: 1, end: 2 },
    { start: 4, end: 8 },
  ],
  "addCut keeps the list normalized",
);
eq(JSON.stringify(d), beforeAdd, "addCut leaves the input doc untouched");
eq(d2 === d, false, "addCut returns a new doc");

// removeCutsOverlapping
let d3 = removeCutsOverlapping(d2, "a", { start: 5, end: 6 });
deepEq(d3.cuts["a"], [{ start: 1, end: 2 }], "an overlapped cut is removed whole");
d3 = removeCutsOverlapping(d3, "a", { start: 2, end: 3 });
deepEq(d3.cuts["a"], [{ start: 1, end: 2 }], "touching an endpoint is not overlap");
d3 = removeCutsOverlapping(d3, "a", { start: 0, end: 10 });
deepEq(d3.cuts, {}, "removing the last cut drops the asset key");

// toggleWordRemoved round trip
let t = emptyDoc(["a"]);
const beforeToggle = JSON.stringify(t);
const t1 = toggleWordRemoved(t, "a", 1.2, 1.6);
deepEq(t1.cuts["a"], [{ start: 1.2, end: 1.6 }], "toggling a kept word cuts it");
const t2 = toggleWordRemoved(t1, "a", 1.2, 1.6);
deepEq(t2.cuts, {}, "toggling it back restores it exactly");
eq(JSON.stringify(t), beforeToggle, "toggleWordRemoved leaves the input doc untouched");
deepEq(JSON.parse(JSON.stringify(t2)), JSON.parse(beforeToggle), "round trip equals the original doc");

// toggling a word inside a bigger cut carves it out
let m = addCut(emptyDoc(["a"]), "a", { start: 1, end: 5 });
m = toggleWordRemoved(m, "a", 2, 3);
deepEq(
  m.cuts["a"],
  [
    { start: 1, end: 2 },
    { start: 3, end: 5 },
  ],
  "a word inside a cut splits the cut",
);
m = toggleWordRemoved(m, "a", 2, 3);
deepEq(m.cuts["a"], [{ start: 1, end: 5 }], "re-removing the word heals the cut");

// splitAt
let s = emptyDoc(["a"]);
const beforeSplit = JSON.stringify(s);
let s1 = splitAt(s, "a", 4.5);
s1 = splitAt(s1, "a", 2.5);
s1 = splitAt(s1, "a", 4.5);
deepEq(s1.splits["a"], [2.5, 4.5], "splits stay sorted and deduped");
deepEq(s1.cuts, {}, "a split is a boundary, not a cut");
eq(JSON.stringify(s), beforeSplit, "splitAt leaves the input doc untouched");

// caption templates
eq(CAPTION_TEMPLATES.length, 12, "twelve templates");
deepEq(
  CAPTION_TEMPLATES.map((tp) => tp.id),
  [
    "none",
    "classic",
    "boxed",
    "editorial",
    "aesthetic",
    "luxe",
    "minimal",
    "clean",
    "simple",
    "trendy",
    "highlight",
    "bold",
  ],
  "template ids",
);
eq(CAPTION_TEMPLATES[0].label, "No Captions", "the first template turns captions off");

// applyTemplate overrides only the style fields the template defines
let c = emptyDoc(["a"]);
c = {
  ...c,
  captions: {
    ...c.captions,
    breaks: [{ chunkIndex: 2, text: "keep me" }],
    style: { ...c.captions.style, size: 99, wordsPerLine: 5 },
  },
};
const beforeTpl = JSON.stringify(c);
const boxed = applyTemplate(c, "boxed");
eq(boxed.captions.template, "boxed", "template id is set");
eq(boxed.captions.enabled, true, "a real template enables captions");
eq(boxed.captions.style.background.on, true, "boxed turns the background on");
eq(boxed.captions.style.background.shape, "full", "boxed uses the full background");
eq(boxed.captions.style.size, 99, "fields the template does not define keep their values");
eq(boxed.captions.style.wordsPerLine, 5, "caption-only fields survive a template");
deepEq(boxed.captions.breaks, [{ chunkIndex: 2, text: "keep me" }], "breaks are untouched");
eq(JSON.stringify(c), beforeTpl, "applyTemplate leaves the input doc untouched");
eq(boxed === c, false, "applyTemplate returns a new doc");

const off = applyTemplate(c, "none");
eq(off.captions.enabled, false, "No Captions disables captions");
eq(applyTemplate(c, "nope"), c, "an unknown template id is a no-op");

console.log("editDoc: all checks passed");
