import assert from "node:assert/strict";
import {
  carouselCaption,
  carouselDraftSchema,
  csvFileName,
  MAX_CAROUSEL_SLIDES,
  toCanvaCsv,
} from "./carousel";

/**
 * Runnable check: `pnpm --filter @toreroflow/core test`.
 *
 * Two properties are defended here. A CSV that a spreadsheet misreads turns a
 * comma in a headline into an extra column and silently shifts every field
 * after it, which shows up as a design with the wrong words on it. And one row
 * is one design, so a 7 slide carousel must be 7 rows: getting that backwards
 * produces a single crowded image and no carousel at all.
 */

/* ---- one row per slide ---- */
{
  const csv = toCanvaCsv({
    topic: "Financing myths",
    slides: [
      { headline: "Myth 1", body: "You need 20% down" },
      { headline: "Myth 2", body: "Dealers set the rate" },
      { headline: "Myth 3", body: "Cash is always cheaper" },
    ],
  });
  const lines = csv.trim().split("\r\n");
  assert.equal(lines.length, 4, "a header and one row per slide");
  assert.equal(lines[0], "slide,of,headline,body,topic");
  assert.equal(lines[1], "1,3,Myth 1,You need 20% down,Financing myths");
  assert.equal(lines[3], "3,3,Myth 3,Cash is always cheaper,Financing myths");
  assert.equal(csv.endsWith("\r\n"), true, "importers drop a last row with no newline");
}

/* ---- a field that would break the columns ---- */
{
  const csv = toCanvaCsv({
    topic: "Hooks",
    slides: [
      { headline: 'He said, "no way"', body: "Line one\nLine two" },
      { headline: "Plain", body: "" },
    ],
  });
  // A comma and a quote in one field: quoted, with the quote doubled.
  assert.equal(csv.includes('"He said, ""no way"""'), true, "quotes are doubled, field wrapped");
  // A newline inside a field must stay inside its quotes, not start a row.
  assert.equal(csv.includes('"Line one\nLine two"'), true);
  // An empty body is an empty field, not a missing column.
  assert.equal(csv.trim().split("\r\n")[2], "2,2,Plain,,Hooks");
  // Every row has the same number of top-level columns as the header.
  const topLevelCommas = (row: string) => {
    let inQuotes = false;
    let count = 0;
    for (let i = 0; i < row.length; i++) {
      const c = row[i];
      if (c === '"') inQuotes = !inQuotes;
      else if (c === "," && !inQuotes) count++;
    }
    return count;
  };
  for (const row of csv.trim().split("\r\n")) {
    assert.equal(topLevelCommas(row), 4, `row must have 5 columns: ${row}`);
  }
}

/* ---- the ceiling Instagram actually enforces ---- */
{
  assert.equal(MAX_CAROUSEL_SLIDES, 10);
  const slides = Array.from({ length: 10 }, (_, i) => ({ headline: `S${i}`, body: "" }));
  assert.equal(
    carouselDraftSchema.safeParse({ topic: "t", slides, caption: "", hashtags: [] }).success,
    true,
  );
  // Eleven is refused rather than trimmed: losing a slide quietly is worse.
  assert.equal(
    carouselDraftSchema.safeParse({
      topic: "t",
      slides: [...slides, { headline: "one too many", body: "" }],
    }).success,
    false,
  );
  // And a carousel with nothing in it is not a carousel.
  assert.equal(carouselDraftSchema.safeParse({ topic: "t", slides: [] }).success, false);
}

/* A headline is required; a body is optional and defaults to empty. */
{
  const parsed = carouselDraftSchema.parse({ topic: "t", slides: [{ headline: "Only this" }] });
  assert.equal(parsed.slides[0]!.body, "");
  assert.equal(parsed.caption, "");
  assert.deepEqual(parsed.hashtags, []);
  assert.equal(carouselDraftSchema.safeParse({ topic: "t", slides: [{ body: "x" }] }).success, false);
}

/* ---- the caption as posted ---- */
{
  assert.equal(
    carouselCaption({ caption: "Three myths about financing.", hashtags: ["cars", "#finance"] }),
    "Three myths about financing.\n\n#cars #finance",
    "tags are normalised to one leading hash and follow a blank line",
  );
  assert.equal(carouselCaption({ caption: "Just words", hashtags: [] }), "Just words");
  assert.equal(carouselCaption({ caption: "", hashtags: ["only"] }), "#only");
  // A stray bare hash contributes nothing rather than posting a lone "#".
  assert.equal(carouselCaption({ caption: "x", hashtags: ["#", ""] }), "x");
}

/* ---- a filename that can be found again ---- */
{
  assert.equal(csvFileName("Financing myths!", "2026-07-30T12:00:00Z"), "financing-myths-2026-07-30.csv");
  assert.equal(csvFileName("   ", "2026-07-30T00:00:00Z"), "carousel-2026-07-30.csv");
  assert.equal(csvFileName("A".repeat(200), "2026-01-02T00:00:00Z").length <= 50 + 15, true);
}

console.log("carousel: all checks passed");
