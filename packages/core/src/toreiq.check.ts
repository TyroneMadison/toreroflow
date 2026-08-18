// The scoring's one structural promise: unmeasurable signals leave the score
// entirely, so 100 always means "everything measurable is right" and a
// channel with no history is never docked for the history it does not have.
// The rest pins each heuristic at its boundaries.
import assert from "node:assert/strict";
import {
  bestHoursFor,
  channelTopWords,
  keywords,
  scoreUpload,
  sectionBadge,
  suggestTags,
  type ToreIqInput,
} from "./toreiq";

const base: ToreIqInput = {
  title: "3 Corvette Buying Mistakes That Cost Me $12,000",
  description:
    "Corvette buying mistakes I made so you don't have to make them. Every step of the " +
    "auction, the inspection and the paperwork, with the exact checklist I use now.\n" +
    "0:00 Intro\n2:10 The auction trap\n7:45 The inspection\n12:30 Paperwork\n" +
    "Full guide: https://torerone.com/guide\n#corvette #cars",
  tags: [
    "corvette",
    "corvette buying",
    "car auction",
    "buying mistakes",
    "used cars",
    "corvette c8",
    "car buying guide",
    "auction tips",
    "used corvette",
  ],
  hasCustomThumbnail: true,
  categorySet: true,
  languageSet: true,
  playlistSet: true,
  scheduledHour: 18,
  bestHours: [18, 20, 12],
  channelTopWords: ["corvette", "camaro", "auction"],
};

// A genuinely well-packaged upload scores green, and a gutted one scores red.
{
  const good = scoreUpload(base);
  assert.equal(good.total, 100, `everything measurable is right: ${JSON.stringify(good.sections.map(s => [s.label, s.score, s.max]))}`);
  assert.equal(good.grade, "green", "and that is green");

  const bad = scoreUpload({
    ...base,
    title: "VIDEO!!!",
    description: "",
    tags: [],
    hasCustomThumbnail: false,
    categorySet: false,
    languageSet: false,
    playlistSet: false,
    scheduledHour: 4,
  });
  assert.equal(bad.grade, "red", `an empty upload is red, got ${bad.total}`);
}

// The normalization rule: no history means fewer measurable points, not a
// penalty. The same fields score the same total with and without history
// when the history findings would have passed.
{
  const withHistory = scoreUpload(base);
  const noHistory = scoreUpload({ ...base, channelTopWords: [], bestHours: [] });
  assert.equal(noHistory.total, 100, "a young channel can still reach 100");
  assert.equal(withHistory.total, 100, "history adds findings, not a handicap");
  const measurable = (r: typeof withHistory) => r.sections.reduce((s, x) => s + x.max, 0);
  assert.equal(measurable(withHistory) - measurable(noHistory), 14, "history adds 8 title + 6 timing points to the ceiling");
}

// Missing the channel's proven words costs exactly the vocabulary points.
{
  const off = scoreUpload({ ...base, title: "3 Truck Buying Mistakes That Cost Me $12,000" });
  const title = off.sections.find((s) => s.key === "title")!;
  assert.equal(title.max - title.score, 8, "only the vocabulary finding fails");
  assert.equal(
    title.findings.some((f) => !f.ok && f.text.includes("corvette")),
    true,
    "and the finding names the words that work",
  );
}

// Title boundaries.
{
  const short = scoreUpload({ ...base, title: "Corvette [4K]" });
  assert.equal(
    short.sections[0]!.findings.some((f) => !f.ok && f.text.includes("too short")),
    true,
    "a 13-character title is called short",
  );
  const shouty = scoreUpload({ ...base, title: "3 CORVETTE BUYING MISTAKES THAT COST ME $12,000!!!" });
  assert.equal(
    shouty.sections[0]!.findings.some((f) => !f.ok && f.text.includes("All-caps")),
    true,
    "shouting is named",
  );
}

// The badge is the section rescaled to 0-100 for the field corner.
{
  const r = scoreUpload({ ...base, hasCustomThumbnail: false });
  const thumb = r.sections.find((s) => s.key === "thumbnail")!;
  assert.equal(sectionBadge(thumb), 0, "no thumbnail is a zero badge");
  assert.equal(sectionBadge(r.sections.find((s) => s.key === "title")!), 100, "a full section is 100");
}

// Channel vocabulary: built from the top quarter, deduped within a title,
// and silent below a real sample.
{
  const posts = [
    ...Array.from({ length: 6 }, (_, i) => ({ title: `Corvette auction day ${i}`, views: 9000 + i })),
    ...Array.from({ length: 18 }, (_, i) => ({ title: `Vlog ${i}`, views: 10 + i })),
  ];
  const words = channelTopWords(posts);
  assert.equal(words.includes("corvette"), true, "the winners' vocabulary surfaces");
  assert.equal(words.includes("vlog"), false, "the losers' does not");
  assert.deepEqual(channelTopWords(posts.slice(0, 5)), [], "under 8 posts says nothing");
}

// Best hours need three posts in an hour before it becomes advice.
{
  const at = (h: number, views: number) => ({
    publishedAt: new Date(2026, 7, 10, h, 0, 0).toISOString(),
    views,
  });
  const posts = [at(18, 5000), at(18, 6000), at(18, 4000), at(4, 90000), at(9, 100), at(9, 120), at(9, 90)];
  const hours = bestHoursFor(posts);
  assert.equal(hours.includes(4), false, "one lucky 4am video is not advice");
  assert.equal(hours[0], 18, "the sampled strong hour leads");
}

// Tag ideas: phrases from the title outrank single words, channel vocabulary
// outranks both, and nothing already added comes back.
{
  const ideas = suggestTags(base.title, base.description, ["camaro"], ["corvette buying"]);
  assert.equal(ideas.some((i) => i.tag === "corvette buying"), false, "already-added tags stay out");
  const camaro = ideas.find((i) => i.tag === "camaro");
  assert.equal(camaro !== undefined && camaro.score >= 84, true, "proven channel words score highest");
  assert.equal(ideas.some((i) => i.tag.includes(" ")), true, "phrases are offered, not just words");
}

// The keyword splitter drops stopwords and keeps meaning.
assert.deepEqual(keywords("How to Win the Pen Sale"), ["win", "pen", "sale"]);

console.log("toreiq.check: all checks passed");
