import { DEFAULT_TEXT_STYLE, applyTemplate, emptyDoc, type TextItem, type TextStyle } from "./editDoc";
import { applyCase, assFromDoc, hexToAss } from "./captionsToAss";

/** Local assert so the file typechecks with the app and needs no node types. */
function eq(actual: unknown, expected: unknown, message: string) {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
  }
}

/** Sum of every \k value on a dialogue line, in centiseconds. */
function kSum(line: string): number {
  const re = /\\k(\d+)/g;
  let total = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) total += Number(m[1]);
  return total;
}

// hexToAss: ASS colors are &HAABBGGRR&, alpha first, BGR order.
eq(hexToAss("#FF6F61"), "&H00616FFF&", "coral with 0 alpha flips to BGR behind the alpha");
eq(hexToAss("#000000", 102), "&H66000000&", "the alpha byte lands in the top pair");
eq(hexToAss("#FFFFFF", 255), "&HFFFFFFFF&", "255 alpha is fully transparent");

// applyCase matches the preview's CSS text-transform.
eq(applyCase("hello world.", "upper"), "HELLO WORLD.", "upper uppercases everything");
eq(applyCase("hello big world", "title"), "Hello Big World", "title capitalizes each word");
eq(applyCase("hello McRib", "title"), "Hello McRib", "title leaves inner caps alone");
eq(applyCase("hEllo", "asis"), "hEllo", "asis changes nothing");

// The golden: two chunks and one text item, exact string. classic template,
// default styles, caption y 30 puts the line at (540,1536) on 1080x1920.
const doc = emptyDoc(["a"]);
const textItem: TextItem = {
  id: "t1",
  at: 3,
  dur: 1,
  content: "Yo",
  x: 0,
  y: 0,
  style: JSON.parse(JSON.stringify(DEFAULT_TEXT_STYLE)) as TextStyle,
  animIn: "none",
  animOut: "none",
};
const chunks = [
  { start: 0, end: 1.5, text: "Hello world" },
  { start: 2, end: 2.5, text: "again" },
];
const golden = assFromDoc({ chunks, texts: [textItem], captions: doc.captions });
const expected = [
  "[Script Info]",
  "ScriptType: v4.00+",
  "PlayResX: 1080",
  "PlayResY: 1920",
  "WrapStyle: 2",
  "ScaledBorderAndShadow: yes",
  "",
  "[V4+ Styles]",
  "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
  "Style: C,Montserrat,48,&H00FFFFFF&,&H00FFFFFF&,&H00000000&,&H00000000&,-1,0,0,0,100,100,0,0,1,6,0,5,0,0,0,1",
  "Style: T1,Montserrat,48,&H00FFFFFF&,&H00FFFFFF&,&H00000000&,&H00000000&,-1,0,0,0,100,100,0,0,1,6,0,5,0,0,0,1",
  "",
  "[Events]",
  "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  "Dialogue: 0,0:00:00.00,0:00:01.50,C,,0,0,0,,{\\pos(540,1536)}Hello world",
  "Dialogue: 0,0:00:02.00,0:00:02.50,C,,0,0,0,,{\\pos(540,1536)}again",
  "Dialogue: 1,0:00:03.00,0:00:04.00,T1,,0,0,0,,Yo",
  "",
].join("\n");
eq(golden, expected, "the small document renders to the exact golden ASS file");
eq(golden.includes("\\k"), false, "classic has no accent, so no karaoke tags");

// Karaoke: trendy defines an accent, so words get \k tags and the accent
// becomes SecondaryColour. Trendy also uppercases.
const trendy = applyTemplate(emptyDoc(["a"]), "trendy");
const kAss = assFromDoc({
  chunks: [
    { start: 0, end: 1, text: "one two three" },
    { start: 2, end: 3.7, text: "a b c" },
  ],
  texts: [],
  captions: trendy.captions,
});
const kLines = kAss.split("\n");
const cStyle = kLines.find((l) => l.startsWith("Style: C,")) ?? "";
eq(cStyle.split(",")[4], "&H00616FFF&", "karaoke SecondaryColour is the accent color");
const kEvents = kLines.filter((l) => l.startsWith("Dialogue:"));
eq(
  kEvents[0],
  "Dialogue: 0,0:00:00.00,0:00:01.00,C,,0,0,0,,{\\pos(540,1536)}{\\k33}ONE {\\k33}TWO {\\k34}THREE",
  "karaoke tags each word and the template case applies first",
);
eq(kSum(kEvents[0]), 100, "k values sum to the 1s chunk duration in cs");
eq(kSum(kEvents[1]), 170, "k values sum to the 1.7s chunk duration within rounding");

// The animation chip is the karaoke gate: "none" silences an accent template,
// "karaoke" fires without one, and only the chunk timing sets the \k budget.
const secondary = (ass: string) => (ass.split("\n").find((l) => l.startsWith("Style: C,")) ?? "").split(",")[4];
const oneChunk = [{ start: 0, end: 1, text: "one two" }];
const noneTrendy = applyTemplate(emptyDoc(["a"]), "trendy");
noneTrendy.captions.style.animation = "none";
const noneAss = assFromDoc({ chunks: oneChunk, texts: [], captions: noneTrendy.captions });
eq(noneAss.includes("\\k"), false, "none produces no karaoke tags even on an accent template");
eq(secondary(noneAss), "&H00FFFFFF&", "none keeps SecondaryColour at the text color");

const kChip = emptyDoc(["a"]);
kChip.captions.style.animation = "karaoke";
const kChipAss = assFromDoc({ chunks: oneChunk, texts: [], captions: kChip.captions });
eq(kChipAss.includes("\\k"), true, "the karaoke chip fires without a template accent");
eq(secondary(kChipAss), "&H00616FFF&", "the style accent becomes SecondaryColour");

// A saved custom template is not in CAPTION_TEMPLATES; with no chip chosen
// its own accent keeps karaoke instead of a lookup miss silencing it.
const legacyCustom = emptyDoc(["a"]);
legacyCustom.captions.template = "custom-1";
eq(
  assFromDoc({ chunks: oneChunk, texts: [], captions: legacyCustom.captions }).includes("\\k"),
  true,
  "a custom template with no animation set keeps its karaoke",
);

// The other chips map to real caption-level tags.
const withAnim = (animation: string) => {
  const d = emptyDoc(["a"]);
  d.captions.style.animation = animation;
  return assFromDoc({ chunks: [{ start: 0, end: 1, text: "one two three" }], texts: [], captions: d.captions });
};
eq(withAnim("fade").includes("\\fad(160,120)"), true, "fade emits \\fad per caption");
eq(withAnim("pop").includes("\\fscx90\\fscy90\\t(0,120,\\fscx100\\fscy100)"), true, "pop scales in over 120ms");
eq(withAnim("slideup").includes("\\move(540,1554,540,1536,0,140)"), true, "slide up moves from y+18 over 140ms");
const typeEvents = withAnim("typewriter").split("\n").filter((l) => l.startsWith("Dialogue:"));
eq(typeEvents.length, 3, "typewriter emits one event per word");
eq(typeEvents[2]?.endsWith("one two three"), true, "typewriter's last event carries the whole chunk");
eq(typeEvents[0]?.endsWith("one"), true, "typewriter starts from the first word");

// Caption breaks override their chunk's text by index.
const withBreak = assFromDoc({
  chunks,
  texts: [],
  captions: { ...doc.captions, breaks: [{ chunkIndex: 1, text: "patched" }] },
});
eq(withBreak.includes("{\\pos(540,1536)}patched"), true, "a break replaces its chunk text");
eq(withBreak.includes("again"), false, "the replaced text is gone");

// A break with empty text removes that caption's event; the other stays.
const removed = assFromDoc({
  chunks,
  texts: [],
  captions: { ...doc.captions, breaks: [{ chunkIndex: 0, text: "" }] },
});
eq(removed.includes("Hello world"), false, "an empty break removes the caption");
eq(removed.includes("again"), true, "later chunks keep their own index and text");

// Disabled captions emit no caption style and no caption events.
const offAss = assFromDoc({
  chunks,
  texts: [],
  captions: { ...doc.captions, enabled: false },
});
eq(offAss.includes("Style: C"), false, "no caption style when disabled");
eq(offAss.includes("Dialogue:"), false, "no caption events when disabled");

console.log("captionsToAss.check: all assertions passed");
