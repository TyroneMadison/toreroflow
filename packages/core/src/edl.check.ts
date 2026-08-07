import { addCut, emptyDoc } from "./editDoc";
import { edlFromDoc, locate, outputDuration, toOutputTime } from "./edl";

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

/** Round to 3dp so segment boundaries compare exactly. */
function r3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

// Two clips: a is 10s with cuts [2,3] and [5,6.5], b is 5s with cut [0,1].
let doc = emptyDoc(["a", "b"]);
doc = addCut(doc, "a", { start: 2, end: 3 });
doc = addCut(doc, "a", { start: 5, end: 6.5 });
doc = addCut(doc, "b", { start: 0, end: 1 });
const durations = { a: 10, b: 5 };
const edl = edlFromDoc(doc, durations);

deepEq(
  edl.map((s) => ({ assetId: s.assetId, srcIn: r3(s.srcIn), srcOut: r3(s.srcOut) })),
  [
    { assetId: "a", srcIn: 0, srcOut: 2 },
    { assetId: "a", srcIn: 3, srcOut: 5 },
    { assetId: "a", srcIn: 6.5, srcOut: 10 },
    { assetId: "b", srcIn: 1, srcOut: 5 },
  ],
  "edl walks clips in order, full duration minus cuts",
);
eq(r3(outputDuration(edl)), 11.5, "output duration sums segment lengths");

// Slivers under 0.05s are dropped, exactly 0.05s survives.
let sliver = emptyDoc(["c"]);
sliver = addCut(sliver, "c", { start: 0.04, end: 10 });
deepEq(edlFromDoc(sliver, { c: 10 }), [], "a 0.04s leading sliver is dropped");
let edge = emptyDoc(["c"]);
edge = addCut(edge, "c", { start: 0.05, end: 10 });
deepEq(
  edlFromDoc(edge, { c: 10 }),
  [{ assetId: "c", srcIn: 0, srcOut: 0.05 }],
  "an exactly 0.05s segment is kept",
);

// Clips with no known duration are skipped.
deepEq(
  edlFromDoc(emptyDoc(["a", "x"]), { a: 2 }),
  [{ assetId: "a", srcIn: 0, srcOut: 2 }],
  "unknown duration skips the clip",
);

// locate: output time to segment and source time.
deepEq(locate(edl, 0), { segIndex: 0, assetId: "a", srcTime: 0 }, "locate at 0");
deepEq(locate(edl, 2), { segIndex: 1, assetId: "a", srcTime: 3 }, "a boundary belongs to the next segment");
deepEq(locate(edl, 2.5), { segIndex: 1, assetId: "a", srcTime: 3.5 }, "locate inside segment 1");
deepEq(locate(edl, 7.5), { segIndex: 3, assetId: "b", srcTime: 1 }, "locate crosses into clip b");
deepEq(locate(edl, 8.5), { segIndex: 3, assetId: "b", srcTime: 2 }, "locate inside clip b");
eq(locate(edl, 11.5), null, "locate at the output end is null");
eq(locate(edl, -0.1), null, "locate before 0 is null");
eq(locate([], 0), null, "locate on an empty edl is null");

// toOutputTime: source time to output time, null inside a cut.
eq(toOutputTime(edl, "a", 1), 1, "source 1 on a maps straight through");
eq(toOutputTime(edl, "a", 4), 3, "source 4 on a lands after the first cut collapses");
eq(r3(toOutputTime(edl, "a", 7) ?? NaN), 4.5, "source 7 on a lands after both cuts collapse");
eq(r3(toOutputTime(edl, "b", 2) ?? NaN), 8.5, "source 2 on b lands after all of a");
eq(toOutputTime(edl, "a", 2.5), null, "a source time inside a cut is null");
eq(toOutputTime(edl, "b", 0.5), null, "inside b's cut is null too");
eq(toOutputTime(edl, "zzz", 1), null, "unknown asset is null");

// Round trips both ways.
const loc = locate(edl, 8.5);
eq(loc && r3(toOutputTime(edl, loc.assetId, loc.srcTime) ?? NaN), 8.5, "locate then toOutputTime round trips");
const out = toOutputTime(edl, "a", 4);
eq(out !== null && r3(locate(edl, out)?.srcTime ?? NaN), 4, "toOutputTime then locate round trips");

console.log("edl.check: all assertions passed");
