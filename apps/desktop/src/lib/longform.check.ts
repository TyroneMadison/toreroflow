import { fmtBytes, fmtClock, instagramRows, parseDest, parseHandles, phasesFor } from "./longform";
/** Local so the file stays part of the app's typecheck without pulling in node types. */
const assert = {
  equal(actual: unknown, expected: unknown, message = "") {
    if (actual !== expected) throw new Error(`${message} expected ${String(expected)}, got ${String(actual)}`);
  },
  deepEqual(actual: unknown, expected: unknown, message = "") {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${message} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
  },
  ok(value: unknown, message = "") {
    if (!value) throw new Error(message || "expected truthy");
  },
};

// Toggle state: unknown or missing ?dest= is YouTube, the old behavior.
assert.equal(parseDest(null), "youtube");
assert.equal(parseDest("tiktok"), "youtube");
assert.equal(parseDest("both"), "both");

// Field swap: YouTube keeps its five phases untouched.
const ids = (d: Parameters<typeof phasesFor>[0]) => phasesFor(d).map((p) => p.id);
assert.deepEqual(ids("youtube"), ["details", "suitability", "elements", "checks", "visibility"]);
assert.deepEqual(ids("instagram"), ["instagram", "checks", "visibility"]);
assert.deepEqual(ids("both"), ["details", "suitability", "elements", "instagram", "checks", "visibility"]);
assert.equal(phasesFor("instagram").at(-1)!.label, "Post time");
assert.equal(phasesFor("both").at(-1)!.label, "Visibility");

assert.deepEqual(parseHandles("@dudthecarguy, torerone  @x"), ["dudthecarguy", "torerone", "x"]);

const fit = { bytes: 284 * 1024 * 1024, blocks: [], warnings: [], needsCopy: false, is916: true, limit: { used: 3, total: 100 } };
const base = { handle: "dud", caption: "Full M3 walkaround #cars #m3", collaborators: [], locationId: "", fit, cover: "frame" as const };

// A clean file: everything green, the fit line says so.
{
  const rows = instagramRows(base);
  assert.equal(rows.every((r) => r.ok === true), true, JSON.stringify(rows));
  assert.ok(rows.some((r) => r.text === "Fits Instagram: 3 s to 15 min, under 300 MB."));
  assert.ok(rows.some((r) => /2\/30 hashtags/.test(r.text)));
}

// Validation messages: each limit turns red with its own sentence.
{
  const bad = instagramRows({
    ...base,
    handle: null,
    caption: "x".repeat(2201),
    collaborators: ["a", "b", "c", "d"],
    locationId: "Miami, Florida",
    fit: { ...fit, blocks: ["Instagram reels stop at 15 minutes and this video is 16:00."], limit: { used: 100, total: 100 } },
  });
  const red = bad.filter((r) => r.ok === false).map((r) => r.text);
  assert.equal(red.length, 6, JSON.stringify(red));
  assert.ok(red.some((t) => /2,200/.test(t)));
  assert.ok(red.some((t) => /4 collaborators/.test(t)));
  assert.ok(red.some((t) => /numeric id/.test(t)));
  assert.ok(red.some((t) => /15 minutes/.test(t)));
  assert.ok(red.some((t) => /all 100/.test(t)));
}

// Warnings are informational, never red; near the cap says to tell Nova.
{
  const rows = instagramRows({ ...base, fit: { ...fit, warnings: ["Instagram needs a smaller file."], limit: { used: 97, total: 100 } } });
  assert.equal(rows.some((r) => r.ok === false), false);
  assert.ok(rows.some((r) => r.ok === null && /Tell Nova/.test(r.text)));
}

assert.equal(fmtBytes(2.4 * 1024 ** 3), "2.4 GB");
assert.equal(fmtBytes(284 * 1024 ** 2), "284 MB");
assert.equal(fmtClock(768), "12:48");

console.log("longform: all checks passed");
