import type { Word } from "./autoCut";
import {
  curveScale,
  hookAsText,
  outputWordRefs,
  reanchorDoc,
  speechCleanup,
  suggestBrollSpots,
  suggestHighlights,
  suggestHooks,
  suggestZooms,
  textsWithHook,
  wordMarks,
  ZOOM_CURVES,
  zoomItemFor,
  HOOK_STYLE,
} from "./aiPasses";
import { addCut, emptyDoc } from "./editDoc";
import { edlFromDoc } from "./edl";

function eq(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
  }
}
function ok(cond: boolean, message: string) {
  if (!cond) throw new Error(message);
}

/** Words from text, 0.3s each with 0.05s gaps; "|n" inserts an n-second pause. */
function wordsOf(text: string): Word[] {
  const out: Word[] = [];
  let t = 0;
  for (const tok of text.split(" ")) {
    if (tok.startsWith("|")) {
      t += Number(tok.slice(1));
      continue;
    }
    out.push({ start: t, end: t + 0.3, word: tok });
    t += 0.35;
  }
  return out;
}

const A = "a1";
const words = wordsOf(
  "I said no to my cousin. um So last spring my cousin calls me and he he needs work. you know " +
    "|1.2 Family is the hardest hire you'll ever make! I paid him money and it was a mistake.",
);
const dur = 40;
const doc0 = emptyDoc([A]);
const edl0 = edlFromDoc(doc0, { [A]: dur });
const refs = outputWordRefs(edl0, { [A]: words });
eq(refs.length, words.length, "all words survive an uncut doc");
eq(refs[3].i, 3, "refs keep source indices");

// ---- speech cleanup ----
const scan = speechCleanup(refs, { pauseSec: 0.6 });
ok(scan.fillers.some((f) => f.label === "um"), "single filler found");
ok(scan.fillers.some((f) => f.label === "you know" && f.i1 === f.i0 + 1), "multi-word filler spans 2 words");
eq(scan.pauses.length, 1, "one long pause");
ok(scan.pauses[0].end - scan.pauses[0].start > 0.9, "pause cut keeps padding only");
eq(scan.badTakes.length, 1, "one bad take (he he)");
eq(scan.badTakes[0].label, "he", "earlier take dropped");
ok(scan.badTakes[0].keep!.startsWith("he needs"), "retake kept");
const tighter = speechCleanup(refs, { pauseSec: 2 });
eq(tighter.pauses.length, 0, "pause slider raises the bar");
const custom = speechCleanup(refs, { fillers: ["so"] });
eq(custom.fillers.length, 1, "custom filler list");

// Applying the cleanup as cuts, then rescanning, finds nothing.
let cut = doc0;
for (const it of [...scan.fillers, ...scan.pauses, ...scan.badTakes]) {
  cut = addCut(cut, it.assetId, { start: it.start, end: it.end }, dur);
}
const refs2 = outputWordRefs(edlFromDoc(cut, { [A]: dur }), { [A]: words });
const scan2 = speechCleanup(refs2, { pauseSec: 0.6 });
eq(scan2.fillers.length + scan2.badTakes.length, 0, "cleanup is idempotent");
ok(!refs2.some((r) => r.word === "um"), "filler gone from output");

// ---- hook ----
const hooks = suggestHooks(refs);
ok(hooks.length >= 1 && hooks.length <= 3, "1-3 hook candidates");
const n = hooks[0].text.split(" ").length;
ok(n >= 3 && n <= 7, `hook length 3-7 words, got "${hooks[0].text}"`);
ok(/^[A-Z]/.test(hooks[0].text), "title case");
eq(hookAsText(doc0), null, "no hook, no text");
const withHook = { ...doc0, hook: { text: "Never Hire Family", dur: 5, style: HOOK_STYLE } };
eq(hookAsText(withHook)!.dur, 5, "hook text lasts its dur");
eq(textsWithHook(withHook).length, 1, "hook prepended to texts");
eq(textsWithHook(doc0), doc0.texts, "same list when no hook");

// ---- highlights ----
const hl = suggestHighlights(refs);
const lv = Object.values(hl.keywords[A] ?? {});
ok(lv.includes(2) && lv.includes(1), "both levels used");
ok(lv.length <= Math.ceil(refs.length * 0.12), "sparse highlights");
const fillerIdx = words.findIndex((w) => w.word === "um");
eq(hl.keywords[A]?.[fillerIdx], undefined, "fillers never highlighted");
ok(Object.keys(hl.emojis[A] ?? {}).length >= 1, "an emoji placed");
const marks = wordMarks(refs, { ...doc0, captions: { ...doc0.captions, highlight: hl } });
eq(marks.length, refs.length, "marks parallel to refs");

// ---- zooms ----
eq(Math.round(curveScale(ZOOM_CURVES.slow_push, 1.5) * 1000) / 1000, 1.09, "slow push midway");
eq(curveScale(ZOOM_CURVES.slow_push, 3.5), 1.18, "slow push hold");
eq(curveScale(ZOOM_CURVES.slow_push, 9), 1, "past curve");
const longRefs = outputWordRefs(edlFromDoc(emptyDoc([A]), { [A]: 200 }), {
  [A]: Array.from({ length: 300 }, (_, k) => ({ start: k * 0.5, end: k * 0.5 + 0.4, word: k % 17 === 0 ? "never" : "word" + (k % 5) })),
});
const zs = suggestZooms(longRefs);
ok(zs.length >= 4 && zs.length <= 6, `about one per 30s, got ${zs.length}`);
for (let k = 1; k < zs.length; k++) ok(zs[k].at - zs[k - 1].at >= 8, "zooms >= 8s apart");
const zi = zoomItemFor(zs[0], "z1");
eq(zi.anchor, "face", "face anchored");
ok(zi.curve!.length > 1, "curve expanded");

// ---- b-roll spots ----
const spots = suggestBrollSpots(refs);
ok(spots.length >= 1, "a b-roll spot");
ok(spots.every((s) => s.at >= 2 && s.keywords.length >= 1), "spots skip the hook and carry keywords");

// ---- reanchor after a later cut ----
const z = zoomItemFor(zs[0], "z1");
const anchored = { ...emptyDoc([A]), zooms: [z] };
const longWords = Array.from({ length: 300 }, (_, k) => ({ start: k * 0.5, end: k * 0.5 + 0.4, word: "w" }));
eq(reanchorDoc(anchored, { [A]: 200 }, { [A]: longWords }), anchored, "unchanged when in place");
const after = addCut(anchored, A, { start: 0, end: 5 }, 200);
const moved = reanchorDoc(after, { [A]: 200 }, { [A]: longWords });
eq(moved.zooms[0].at, Math.round((z.at - 5) * 1000) / 1000, "zoom follows its word after an earlier cut");

console.log("aiPasses checks passed");
