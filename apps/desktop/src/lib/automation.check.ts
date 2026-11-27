/*
 * Runnable check: `pnpm --filter @toreroflow/desktop test`.
 * The query param a bot passes, and the html attributes it ends up as.
 */
import { automationAttributes, automationParam } from "./theme";
import { dockSection, SECTIONS, pageOf, sectionHome, sectionOf } from "./nav";

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

// Every screen sits in exactly one section, with a unique slug. Measure and
// Reports merged into one Reports tab (2026-11-27), Analytics first.
const reports = SECTIONS.find((s) => s.id === "reports")!;
eq(SECTIONS.map((s) => s.id), ["overview", "create", "reports", "settings"], "four Dock tabs: Measure merged into Reports");
eq(reports.label, "Reports", "the merged tab is called Reports");
eq(sectionHome(reports), "analytics", "the Reports tab opens Analytics first");
eq(reports.pages.map((p) => p.slug), ["analytics", "reports", "rollup", "monthly-report", "insights", "comments"], "the same six pages, Analytics first");
const pages = SECTIONS.flatMap((s) => s.pages);
eq(new Set(pages.map((p) => p.id)).size, 26, "all twenty-six screens (the phone More page included) are mapped once");
eq(pages.length, 26, "no page is listed under two tabs");
eq(new Set(pages.map((p) => p.slug)).size, pages.length, "slugs are unique");
eq(sectionOf("calendar").id, "create", "calendar lives under Create");
eq(pageOf("overview").slug, "account-overview", "Account Overview does not collide with the section");
eq(sectionOf("comments").id, "reports", "the comments inbox lights the Reports tab");
eq(
  reports.pages.map((p) => sectionOf(p.id).id),
  ["reports", "reports", "reports", "reports", "reports", "reports"],
  "every Reports page lights the Reports tab",
);
eq([sectionOf("fanout").id, sectionOf("queue").id, sectionOf("rollup").id, sectionOf("templates").id], ["create", "create", "reports", "overview"], "the workflow pages sit where the mockups put them");
eq([sectionOf("approvals").id, sectionOf("requests").id, sectionOf("failed").id, sectionOf("insights").id, sectionOf("monthly").id], ["create", "create", "overview", "reports", "reports"], "the ideas pages sit in their sections");

eq(
  [dockSection("analytics"), dockSection("reports"), dockSection("comments"), dockSection("calendar"), dockSection("dashboard")],
  ["reports", "reports", "reports", "create", "overview"],
  "every Reports page, Analytics included, lights the one Reports tab",
);

console.log("automation: all checks passed");
