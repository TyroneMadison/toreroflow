import assert from "node:assert/strict";
import { DEFAULT_MAX_CHARS, knowledgeContext } from "./knowledgeContext";

/**
 * Runnable check: `pnpm --filter @toreroflow/core test`.
 *
 * Every AI feature in the app reads this block, so the failures worth pinning
 * are the quiet ones: a section order that shifts between callers, one big file
 * eating the notes, an empty client producing a page of headings that reads to
 * the model like a brand with nothing to say, and a budget that is not actually
 * a budget.
 */

const empty = { notes: [], files: [] };

/* ---- nothing in, nothing out ---- */

assert.equal(knowledgeContext(empty), "", "a brand with no knowledge gets no block at all");
assert.equal(
  knowledgeContext({ notes: [], files: [], nicheProfile: null, ideas: [] }),
  "",
  "empty extras do not conjure headings",
);
assert.equal(
  knowledgeContext({
    notes: [{ title: "  ", body: "  " }],
    files: [{ name: "brief.pdf", extractedText: "" }],
    nicheProfile: {},
    ideas: [{ text: "", status: "idea" }],
  }),
  "",
  "blank content is the same as no content",
);

/* ---- a file still being extracted is not knowledge ---- */

{
  const block = knowledgeContext({
    notes: [{ title: "Voice", body: "Blunt, no fluff." }],
    files: [
      { name: "waiting.pdf", extractedText: "" },
      { name: "done.pdf", extractedText: "Founded 2019." },
    ],
  });
  assert.ok(!block.includes("waiting.pdf"), "a file with no text is not listed, so nothing guesses at it");
  assert.ok(block.includes("done.pdf"));
  assert.ok(block.includes("Founded 2019."));
}

/* ---- the order is fixed ---- */

{
  const block = knowledgeContext({
    notes: [{ title: "Voice", body: "Blunt." }],
    files: [{ name: "brief.pdf", extractedText: "Detailing shop." }],
    nicheProfile: { niche: "Car detailing", audience: "Owners in Perth" },
    ideas: [{ text: "Ceramic coating myths", status: "idea" }],
  });
  const at = (h: string) => block.indexOf(h);
  assert.ok(at("## Brand knowledge") === 0, "brand knowledge leads");
  assert.ok(at("## Brand knowledge") < at("## Files"));
  assert.ok(at("## Files") < at("## Niche"));
  assert.ok(at("## Niche") < at("## Open ideas"));
  assert.ok(block.includes("### Voice"));
  assert.ok(block.includes("### brief.pdf"));
  assert.ok(block.includes("niche: Car detailing"));
  assert.ok(block.includes("- Ceramic coating myths (idea)"));
}

/* ---- a section only appears when it has something to say ---- */

{
  const notesOnly = knowledgeContext({ notes: [{ title: "Voice", body: "Blunt." }], files: [] });
  assert.equal(notesOnly, "## Brand knowledge\n### Voice\nBlunt.");
  assert.ok(!notesOnly.includes("## Files"));
  assert.ok(!notesOnly.includes("## Niche"));
  assert.ok(!notesOnly.includes("## Open ideas"));
}

/* ---- the niche profile has already changed shape once ---- */

assert.ok(
  knowledgeContext({ ...empty, nicheProfile: "Car detailing in Perth" }).includes(
    "## Niche\nCar detailing in Perth",
  ),
  "a plain string niche still reads",
);
assert.ok(
  knowledgeContext({ ...empty, nicheProfile: { voice: ["blunt", "funny"] } }).includes(
    "voice: blunt, funny",
  ),
  "the quiz's tag arrays flatten instead of printing as objects",
);
assert.equal(knowledgeContext({ ...empty, nicheProfile: 7 }), "", "a nonsense profile is skipped");
assert.ok(
  !knowledgeContext({ ...empty, nicheProfile: { niche: "Cars", audience: "" } }).includes("audience"),
  "half-filled forms do not emit empty fields",
);

/* ---- per source before global: one huge file cannot crowd out the notes ---- */

{
  const max = 4000;
  const block = knowledgeContext({
    notes: [{ title: "Voice", body: "Blunt, no fluff." }],
    files: [{ name: "huge.pdf", extractedText: "x".repeat(100000) }],
    maxChars: max,
  });
  assert.ok(block.startsWith("## Brand knowledge"), "the notes survive the flood");
  assert.ok(block.includes("Blunt, no fluff."));
  assert.ok(block.includes("## Files"), "and the file still gets its share");
  assert.ok(block.includes(" ..."), "which is marked as a fragment");
  assert.ok(block.length <= max, "the budget is a budget");
  // An eighth of the budget each, so eight sources fit before the global cap bites.
  assert.ok(
    block.split("x".repeat(100)).length - 1 <= Math.ceil(max / 8 / 100),
    "the file is cut to its per source share, not to whatever was left",
  );
}

{
  // Eight big notes, all cut to the same share, none allowed to take the lot.
  const notes = Array.from({ length: 8 }, (_, i) => ({
    title: `Note ${i}`,
    body: "y".repeat(50000),
  }));
  const block = knowledgeContext({ notes, files: [], maxChars: 8000 });
  assert.ok(block.length <= 8000);
  assert.ok(block.includes("### Note 0"));
  assert.ok(block.includes("### Note 1"), "more than the first source makes it in");
}

/* ---- the global cap cuts at a section boundary, from the end ---- */

{
  // Notes and files are already cut to an eighth of the budget each, so a niche
  // is the only section that can arrive too big for what is left. The ideas
  // behind it are small enough to have fitted in the gap it leaves, which is
  // the point: the list stops at the first section that does not fit instead of
  // stepping over it for a smaller one further down.
  const max = 600;
  const block = knowledgeContext({
    notes: [{ title: "Big", body: "z".repeat(4000) }],
    files: [],
    nicheProfile: { niche: "Car detailing ".repeat(60) },
    ideas: [{ text: "Ceramic coating myths", status: "idea" }],
    maxChars: max,
  });
  assert.ok(block.startsWith("## Brand knowledge"));
  assert.ok(
    !block.includes("## Niche") && !block.includes("## Open ideas"),
    "later sections are dropped whole rather than half printed",
  );
  assert.ok(
    max - block.length > "## Open ideas\n- Ceramic coating myths (idea)".length,
    "and the ideas go even though what was left over would have held them",
  );
  assert.ok(block.length <= max);
}

{
  // A section that fits keeps its neighbours out only when there is no room,
  // and the prefix is stable: the same brand read twice gives the same halves.
  const input = {
    notes: [{ title: "Voice", body: "Blunt." }],
    files: [{ name: "brief.pdf", extractedText: "w".repeat(2000) }],
    nicheProfile: { niche: "Cars ".repeat(300) },
    ideas: [{ text: "Myths", status: "idea" }],
    maxChars: 1200,
  };
  assert.equal(knowledgeContext(input), knowledgeContext(input));
  const block = knowledgeContext(input);
  assert.ok(block.includes("## Brand knowledge") && block.includes("## Files"));
  assert.ok(!block.includes("## Niche"), "the prefix stops where the budget does");
}

/* ---- and when even the first section is too big, it is cut mid text ---- */

{
  const block = knowledgeContext({
    notes: [{ title: "Big", body: "q".repeat(5000) }],
    files: [],
    maxChars: 200,
  });
  assert.ok(block.length <= 200, "a single oversized section still respects the budget");
  assert.ok(block.startsWith("## Brand knowledge"));
  assert.ok(block.endsWith(" ..."), "and says it was cut");
}

/* ---- the default budget ---- */

assert.equal(DEFAULT_MAX_CHARS, 24000);
{
  const notes = Array.from({ length: 40 }, (_, i) => ({ title: `N${i}`, body: "k".repeat(9000) }));
  const block = knowledgeContext({ notes, files: [] });
  assert.ok(block.length <= DEFAULT_MAX_CHARS, "the default is enforced, not just documented");
}

console.log("knowledgeContext.check.ts: ok");
