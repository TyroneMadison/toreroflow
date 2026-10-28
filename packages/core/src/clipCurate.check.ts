import assert from "node:assert/strict";
import type { Word } from "./autoCut";
import {
  clipText, curateWindows, dedupeClips, heuristicCurate, heuristicJudge, lengthTargets, linesToRanges,
  nudgeRanges, numberedLines, overlapRatio, rangesDuration, seedClipDoc, sentenceFeatures, sentences,
  sentenceSpan, snapRanges, targetClipCount, type Range,
} from "./clipCurate";
import { rankClips, median } from "./clipScore";

let passed = 0;
const ok = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`ok - ${name}`);
};

/** Words at 0.35 s each with a 0.25 s pause between sentences. */
function speak(lines: string[], t0 = 0): Word[] {
  const out: Word[] = [];
  let t = t0;
  for (const line of lines) {
    for (const w of line.split(" ")) {
      out.push({ start: t, end: t + 0.3, word: w, kind: /^(um|uh),?$/i.test(w) ? "filler" : "word" });
      t += 0.35;
    }
    t += 0.25;
  }
  return out;
}

const script = [
  "So I want to talk about money today.",
  "Why do most people never build real savings?",
  "Because they spend the first 10 percent before it lands.",
  "Here's the rule I follow every single month.",
  "Um, uh, like, yeah.",
  "Pay yourself first with an automatic transfer of 20 percent.",
  "It works because you never see the money.",
  "and then the next thing is the budget.",
  "The biggest mistake is tracking every coffee.",
  "Track three categories instead and the system holds.",
  "That is the whole lesson in one sentence.",
];
// Repeat with variety so the source runs several minutes.
const lines: string[] = [];
for (let k = 0; k < 14; k++) for (const l of script) lines.push(l.replace("10", String(10 + k)));
const words = speak(lines);
const ss = sentences(words);
const dur = words[words.length - 1].end;

ok("sentences split on terminal punctuation", () => {
  assert.equal(ss.length, lines.length);
  assert.equal(ss[1].text, "Why do most people never build real savings?");
  assert.equal(ss[4].fillers, 2);
});
ok("sentences split on long gap without punctuation", () => {
  const w: Word[] = [
    { start: 0, end: 0.3, word: "hello" },
    { start: 0.4, end: 0.7, word: "there" },
    { start: 2, end: 2.3, word: "next" },
  ];
  assert.equal(sentences(w).length, 2);
});
ok("silence words ignored", () => {
  const w: Word[] = [
    { start: 0, end: 0.3, word: "Hi." },
    { start: 0.3, end: 0.5, word: " ", kind: "silence" },
  ];
  assert.equal(sentences(w).length, 1);
});
ok("numbered lines format", () => {
  const first = numberedLines(ss).split("\n")[0];
  assert.match(first, /^\[0\] \(0:00–0:0\d\) So I want/);
});
ok("windows cover all sentences with overlap", () => {
  const long = speak(Array.from({ length: 400 }, () => "This sentence is about five seconds long, give or take a word."));
  const s2 = sentences(long);
  const win = curateWindows(s2, 720, 60);
  assert.ok(win.length >= 2);
  assert.equal(win[0].from, 0);
  assert.equal(win[win.length - 1].to, s2.length - 1);
  for (let k = 1; k < win.length; k++) assert.ok(win[k].from <= win[k - 1].to, "windows overlap");
});
ok("windows empty", () => assert.deepEqual(curateWindows([]), []));
ok("lines to ranges", () => {
  const r = linesToRanges(ss, [[3, 3], [1, 2]]);
  assert.deepEqual(r, [[ss[3].start, ss[3].end], [ss[1].start, ss[2].end]]);
  assert.deepEqual(linesToRanges(ss, [[9999, 9999]]), []);
});
ok("snap pads first and last word", () => {
  const r = snapRanges([[ss[1].start + 0.01, ss[1].end - 0.01]], words);
  assert.ok(Math.abs(r[0][0] - (ss[1].start - 0.15)) < 1e-6);
  assert.ok(Math.abs(r[0][1] - (ss[1].end + 0.25)) < 1e-6);
});
ok("snap merges ranges under 0.3 s apart", () => {
  const r = snapRanges([[ss[1].start, ss[1].end], [ss[2].start, ss[2].end]], words);
  assert.equal(r.length, 1);
});
ok("snap keeps out-of-order hook separate", () => {
  const r = snapRanges([[ss[3].start, ss[3].end], [ss[1].start, ss[2].end]], words);
  assert.equal(r.length, 2);
});
ok("snap clamps to duration and drops empty", () => {
  const r = snapRanges([[ss[ss.length - 1].start, dur + 5], [dur + 10, dur + 20]], words, dur);
  assert.equal(r.length, 1);
  assert.ok(Math.abs(r[0][1] - dur) < 1e-3);
});
ok("overlap ratio", () => {
  assert.equal(overlapRatio([[0, 10]], [[0, 10]]), 1);
  assert.equal(overlapRatio([[0, 10]], [[5, 15]]), 0.5);
  assert.equal(overlapRatio([[0, 10]], [[20, 30]]), 0);
});
ok("dedupe within target only", () => {
  const c = [
    { ranges: [[0, 10]] as Range[], lengthTarget: "15-60" },
    { ranges: [[0.5, 10]] as Range[], lengthTarget: "15-60" },
    { ranges: [[0.5, 10]] as Range[], lengthTarget: "60-180" },
  ];
  assert.equal(dedupeClips(c).length, 2);
});
ok("features: question hook, dangling start", () => {
  assert.ok(sentenceFeatures(ss[1]).hook >= 3);
  assert.equal(sentenceFeatures(ss[0]).dangling, true);
  assert.equal(sentenceFeatures(ss[7]).dangling, true);
  assert.equal(sentenceFeatures(ss[4]).filler > 0.34, true);
});
ok("targets and count", () => {
  assert.deepEqual(lengthTargets("auto").map((t) => t.key), ["15-60", "60-180"]);
  assert.deepEqual(lengthTargets("30-60").map((t) => t.key), ["30-60"]);
  assert.deepEqual(lengthTargets("bogus").length, 2);
  assert.equal(targetClipCount(60), 5);
  assert.equal(targetClipCount(900), 20);
});

const drafts = heuristicCurate(ss, dur, lengthTargets("auto"), { count: 12 });
ok("curate returns clips across both targets", () => {
  assert.ok(drafts.length >= 8, `got ${drafts.length}`);
  assert.ok(new Set(drafts.map((d) => d.lengthTarget)).size === 2);
});
ok("curate never starts on a dangling opener", () => {
  for (const d of drafts) {
    const first = ss.find((s) => Math.abs(s.start - d.ranges[0][0]) < 0.01)!;
    assert.ok(first, "starts on a sentence");
    assert.equal(sentenceFeatures(first).dangling, false, first.text);
  }
});
ok("curate stitches out tangents", () => {
  const tangents = ss.filter((s) => s.text === "Um, uh, like, yeah.");
  const spans = (d: (typeof drafts)[number]) => [Math.min(...d.ranges.map((r) => r[0])), Math.max(...d.ranges.map((r) => r[1]))];
  assert.ok(
    drafts.some((d) => d.ranges.length > 1 && tangents.some((t) => t.start > spans(d)[0] && t.end < spans(d)[1])),
    "a stitched clip that spans a tangent",
  );
  for (const d of drafts) assert.ok(!clipText(d.ranges, words).includes("Um, uh, like, yeah."));
});
ok("curate pulls a hook forward", () => {
  const pulled = drafts.filter((d) => d.hookPulled);
  assert.ok(pulled.length >= 1);
  for (const d of pulled) assert.ok(d.ranges[0][0] > d.ranges[1][0], "hook is later in source");
});
ok("curate fits length targets", () => {
  for (const d of drafts) {
    const len = d.ranges[d.ranges.length - 1][1] - Math.min(...d.ranges.map((r) => r[0]));
    const t = d.lengthTarget === "15-60" ? [15, 60] : [60, 180];
    assert.ok(len >= t[0] - 0.01 && len <= t[1] + 0.01, `${d.lengthTarget} span ${len}`);
    assert.ok(d.ranges.length <= 5);
    assert.ok(d.title.length > 0 && d.why.length > 0);
  }
});
ok("curate respects a refine span", () => {
  const span = sentenceSpan(ss, ss[20].start, ss[60].end)!;
  const r = heuristicCurate(ss, dur, lengthTargets("15-60"), { ...span, count: 3 });
  assert.ok(r.length >= 1);
  for (const d of r) for (const [a, b] of d.ranges) assert.ok(a >= ss[20].start - 0.01 && b <= ss[60].end + 0.01);
});
ok("curate is deterministic", () => {
  assert.deepEqual(heuristicCurate(ss, dur, lengthTargets("auto"), { count: 12 }), drafts);
});
ok("curate empty", () => assert.deepEqual(heuristicCurate([], 0, lengthTargets("auto")), []));

ok("judge spreads 4-9 and ranks to the 99..79 curve", () => {
  const j = heuristicJudge(drafts, ss);
  for (const s of j) for (const k of ["hook", "flow", "value", "trend"] as const) assert.ok(s[k] >= 4 && s[k] <= 9);
  const all = j.flatMap((s) => [s.hook, s.flow, s.value, s.trend]);
  assert.ok(Math.max(...all) - Math.min(...all) >= 4, "a real spread");
  assert.equal(j[0].relevance, null);
  for (const s of j) assert.ok(s.comments.hook && s.comments.flow && s.comments.value && s.comments.trend);
  const r = rankClips(j);
  assert.equal(r[0].score, 99);
  const n = r.length;
  assert.ok(Math.abs(median(r.map((x) => x.score)) - 79) <= 2);
  assert.equal(r[n - 1].score, 59);
});
ok("judge with prompt sets relevance", () => {
  const j = heuristicJudge(drafts, ss, "automatic transfer savings");
  assert.ok(j.every((s) => s.relevance !== null && s.relevance >= 0 && s.relevance <= 10));
  assert.ok(j.some((s) => (s.relevance ?? 0) > 0));
});
ok("judge single clip", () => assert.equal(heuristicJudge([drafts[0]], ss)[0].hook, 7));

ok("nudge extends and shrinks by a sentence", () => {
  const base: Range[] = [[ss[5].start, ss[7].end]];
  assert.equal(nudgeRanges(base, ss, "start", "extend")[0][0], ss[4].start);
  assert.equal(nudgeRanges(base, ss, "start", "shrink")[0][0], ss[6].start);
  assert.equal(nudgeRanges(base, ss, "end", "extend")[0][1], ss[8].end);
  assert.equal(nudgeRanges(base, ss, "end", "shrink")[0][1], ss[6].end);
  assert.deepEqual(base, [[ss[5].start, ss[7].end]], "input untouched");
});
ok("sentence span", () => {
  assert.deepEqual(sentenceSpan(ss, ss[2].start, ss[4].end), { from: 2, to: 4 });
  assert.equal(sentenceSpan(ss, dur + 5, dur + 10), null);
});
ok("clip text in play order", () => {
  const t = clipText([[ss[3].start, ss[3].end], [ss[1].start, ss[1].end]], words);
  assert.ok(t.startsWith("Here's the rule"));
  assert.ok(t.includes(" … Why do most"));
});
ok("seed doc: one clip per range, shots and captions", () => {
  const shots = [{ start: 0, end: 10, layout: "fill" }] as never;
  const d = seedClipDoc("asset1", [[5, 8], [1, 3]], { shots, aspect: "9:16", facesKey: "k/faces.json", name: "Hook" });
  assert.equal(d.v, 2);
  assert.deepEqual(d.clips.map((c) => c.id), ["asset1", "asset1~2"]);
  assert.deepEqual(d.clips.map((c) => [c.srcIn, c.srcOut]), [[5, 8], [1, 3]]);
  assert.equal(d.shots.asset1, shots);
  assert.equal(d.faces?.asset1, "k/faces.json");
  assert.equal(d.captions.enabled, true);
  assert.equal(d.export.name, "Hook");
  assert.equal(rangesDuration([[5, 8], [1, 3]]), 5);
});

console.log(`clipCurate.check: ${passed} passed`);
