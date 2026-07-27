import { donutSegments, sparkPath } from "./financials";

/** Local so the file stays part of the app's typecheck without pulling in node types. */
const assert = {
  equal(actual: unknown, expected: unknown, message?: string) {
    if (actual !== expected) {
      const msg = message ? `${message}\n  ` : "";
      throw new Error(`${msg}expected: ${String(expected)}, actual: ${String(actual)}`);
    }
  },
  deepEqual(actual: unknown, expected: unknown, message?: string) {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) {
      const msg = message ? `${message}\n  ` : "";
      throw new Error(`${msg}expected: ${b}, actual: ${a}`);
    }
  },
  ok(cond: unknown, message?: string) {
    if (!cond) throw new Error(message || "assertion failed");
  },
};

// Segments sum to 100 percent and walk clockwise from 12 o'clock. The SVG
// circle has circumference 100, first offset 25, each next offset minus the
// arcs before it, matching the signed-off mockup's numbers.
const segs = donutSegments([
  { cents: 150000, color: "#57d6a0" },
  { cents: 120000, color: "#4ea8ff" },
  { cents: 85000, color: "#8b7bff" },
]);
assert.equal(segs.length, 3);
const total = segs.reduce((a, s) => a + s.pct, 0);
assert.ok(Math.abs(total - 100) < 0.01, `pcts sum to ${total}`);
assert.equal(segs[0]!.dashoffset, 25);
assert.ok(Math.abs(segs[1]!.dashoffset - (25 - segs[0]!.pct)) < 0.01);
assert.ok(Math.abs(segs[2]!.dashoffset - (25 - segs[0]!.pct - segs[1]!.pct)) < 0.01);

// Zero total produces no segments rather than NaN.
assert.deepEqual(donutSegments([{ cents: 0, color: "#fff" }]), []);

// Sparkline: flat-zero input stays on the baseline with no NaN anywhere.
const flat = sparkPath([0, 0, 0], 220, 54);
assert.ok(!flat.line.includes("NaN"));
assert.ok(!flat.area.includes("NaN"));

// Rising input ends higher (smaller y) than it starts.
const rise = sparkPath([100, 200, 400], 220, 54);
const ys = rise.line
  .split("L")
  .map((p) => Number(p.replace("M", "").trim().split(" ")[1]));
assert.ok(ys[ys.length - 1]! < ys[0]!);

console.log("financials lib: all checks passed");
