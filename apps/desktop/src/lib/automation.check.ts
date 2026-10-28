/*
 * Runnable check: `pnpm --filter @toreroflow/desktop test`.
 * The query param a bot passes, and the html attributes it ends up as.
 */
import { automationAttributes, automationParam } from "./theme";
import { SECTIONS, pageOf, sectionOf } from "./nav";

function eq(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\n  expected: ${e}\n  actual:   ${a}`);
}

eq(automationParam("?automation=1"), true, "?automation=1 turns it on");
eq(automationParam("?x=2&automation=true"), true, "true works too, among other params");
eq(automationParam("?automation=0"), false, "?automation=0 turns it off");
eq(automationParam(""), null, "no param says nothing, so the stored choice stands");
eq(automationParam("?automation=yes"), null, "an unknown value says nothing");

eq(
  automationAttributes(true),
  { "data-motion": "reduced", "data-glass": "low" },
  "on sets both attributes",
);
eq(automationAttributes(false), {}, "off sets neither");

// Every screen sits in exactly one section, with a unique slug.
const pages = SECTIONS.flatMap((s) => s.pages);
eq(new Set(pages.map((p) => p.id)).size, 19, "all nineteen screens are mapped once");
eq(new Set(pages.map((p) => p.slug)).size, pages.length, "slugs are unique");
eq(sectionOf("calendar").id, "create", "calendar lives under Create");
eq(pageOf("overview").slug, "account-overview", "Account Overview does not collide with the section");
eq(sectionOf("comments").id, "measure", "the comments inbox lives under Measure");
eq([sectionOf("fanout").id, sectionOf("queue").id, sectionOf("rollup").id, sectionOf("templates").id], ["create", "create", "measure", "overview"], "the workflow pages sit where the mockups put them");

console.log("automation: all checks passed");
