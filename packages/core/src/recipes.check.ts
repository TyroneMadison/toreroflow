import type { Word } from "./autoCut";
import { emptyDoc } from "./editDoc";
import { edlFromDoc, outputDuration } from "./edl";
import { applyRecipe, mapLimit, parseConcurrency, recipeSummary, versionsToPrune } from "./recipes";
import { srtTime, toSrt, toTxt, transcriptFromDoc } from "./transcriptExport";
import { addCut } from "./editDoc";

function ok(cond: boolean, message: string) {
  if (!cond) throw new Error(message);
}
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
const durations = { [A]: 40 };
const W = { [A]: words };
const doc0 = emptyDoc([A]);

// Empty recipe: same doc reference, nothing changed.
{
  const r = applyRecipe(doc0, {}, durations, W);
  ok(r.doc === doc0, "empty recipe keeps the doc");
  ok(r.change.cuts === 0 && r.change.hook === null, "empty recipe changes nothing");
}

// Full recipe: aspect, template, cleanup cuts, hook, highlights, zooms.
{
  const r = applyRecipe(
    doc0,
    {
      aspect: "1:1",
      captions: { template: "bold", style: { case: "upper" } },
      ai: { fillers: true, pauses: true, badTakes: true, hook: true, highlights: true, emojis: false, zooms: true },
    },
    durations,
    W,
  );
  ok(r.doc.output.aspect === "1:1", "aspect applied");
  ok(r.doc.captions.style.case === "upper", "style override over template");
  ok(r.change.cuts > 0 && r.change.cutSec > 0, "cleanup made cuts");
  ok(outputDuration(edlFromDoc(r.doc, durations)) < 40 - r.change.cutSec + 0.01, "cuts shorten the edit");
  ok(!!r.doc.hook && r.doc.hook.text === r.change.hook, "hook set");
  ok(r.change.emojis === 0 && Object.keys(r.doc.captions.highlight?.emojis ?? {}).length === 0, "emojis off");
  ok(r.change.keywords > 0, "keywords on");
  ok(r.doc.zooms.every((z) => z.id.startsWith("az-")), "auto zoom ids");
  // A second run replaces its zooms instead of stacking them.
  const again = applyRecipe(r.doc, { ai: { zooms: true } }, durations, W);
  ok(again.doc.zooms.length === r.doc.zooms.length, "zooms replace, not stack");
}

ok(recipeSummary({ aspect: "9:16", captions: { template: "karaoke" }, ai: { hook: true } }) === "9:16 · karaoke · hook", "summary");

// Versions: keep the newest N.
{
  const rows = Array.from({ length: 5 }, (_, i) => ({ id: `v${i}`, createdAt: new Date(2026, 0, 1, 0, i) }));
  const gone = versionsToPrune(rows, 3);
  ok(gone.length === 2 && gone.includes("v0") && gone.includes("v1"), "prunes the oldest");
}

// SRT / TXT.
ok(srtTime(3661.5) === "01:01:01,500", "srt time");
{
  const srt = toSrt(
    [
      { start: 0, end: 1.2, text: "hello there" },
      { start: 1.2, end: 2, text: "world" },
    ],
    { breaks: [{ chunkIndex: 1, text: "WORLD" }] },
  );
  ok(srt === "1\n00:00:00,000 --> 00:00:01,200\nhello there\n\n2\n00:00:01,200 --> 00:00:02,000\nWORLD\n", "srt body: " + JSON.stringify(srt));
  const txt = toTxt([
    { start: 0, end: 0.3, word: "a" },
    { start: 0.4, end: 0.6, word: "b" },
    { start: 3, end: 3.2, word: "c" },
  ]);
  ok(txt === "a b\n\nc\n", "txt paragraphs");
}

// transcriptFromDoc follows the cut and word edits.
{
  const d = { ...addCut(doc0, A, { start: words[6].start, end: words[6].end }, 40), wordEdits: { [A]: { 0: "We" } } };
  const t = transcriptFromDoc(d, durations, W);
  ok(t.txt.startsWith("We said no") && !t.txt.includes(" um "), "txt follows edits and cuts: " + t.txt.slice(0, 40));
  ok(t.srt.startsWith("1\n00:00:00,000 --> "), "srt starts at zero");
}

// mapLimit never runs more than the limit at once and keeps order.
{
  let live = 0;
  let peak = 0;
  const out = await mapLimit([5, 1, 3, 2], 2, async (n) => {
    live++;
    peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, n));
    live--;
    return n * 10;
  });
  ok(peak === 2 && out.join() === "50,10,30,20", "mapLimit");
}
ok(parseConcurrency(undefined) === 1 && parseConcurrency("2") === 2 && parseConcurrency("9") === 4 && parseConcurrency("x") === 1 && parseConcurrency("0") === 1, "parseConcurrency");
console.log("recipes.check: all assertions passed");
