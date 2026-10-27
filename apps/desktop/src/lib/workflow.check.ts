/*
 * Runnable check: `pnpm --filter @toreroflow/desktop test`.
 * W1 overrides and reset, W2 summary, fix links and who may override, W3
 * moves, W4 formatting and the empty state, W5 template form and prefill.
 */
import { DraftSchema, resolveTarget, type Draft, type PreflightResult } from "@toreroflow/contracts";
import {
  blankTemplate,
  fixLabel,
  fixTarget,
  fmtMetric,
  formToTemplate,
  isOverridden,
  loadStashedDraft,
  moveId,
  newDraft,
  preflightSummary,
  principalFrom,
  queueOrder,
  resetField,
  rollupHasData,
  setOverride,
  stashDraft,
  templateToForm,
} from "./workflow";
import { canEditTemplates, canOverridePreflight } from "@toreroflow/contracts";

function eq(actual: unknown, expected: unknown, message: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${message}\n  expected: ${e}\n  actual:   ${a}`);
}

// ---- W1: editing Instagram leaves YouTube and TikTok on the draft ----
const base = newDraft("d1", "caleb", "v1", "2021 M3 walkaround.", "2026-10-29T22:00:00.000Z", "M3 full walkaround");
let d = setOverride(base, "instagram", "caption", "M3 Comp, $54,900 #bmw");
const yt = d.targets.find((t) => t.platform === "youtube")!;
const ig = d.targets.find((t) => t.platform === "instagram")!;
const tk = d.targets.find((t) => t.platform === "tiktok")!;
eq(resolveTarget(d, ig).caption, "M3 Comp, $54,900 #bmw", "Instagram posts its override");
eq([resolveTarget(d, yt).caption, resolveTarget(d, tk).caption], ["2021 M3 walkaround.", "2021 M3 walkaround."], "YouTube and TikTok keep the draft");
eq([isOverridden(yt), isOverridden(ig), isOverridden(tk)], [false, true, false], "only Instagram is marked Overridden");
// Unchanged cards follow the draft live.
d = { ...d, caption: "New draft caption." };
eq(resolveTarget(d, d.targets[0]!).caption, "New draft caption.", "an untouched card follows a draft edit");
eq(resolveTarget(d, d.targets[1]!).caption, "M3 Comp, $54,900 #bmw", "an overridden card does not");
// Reset deletes the key, never sets it empty.
d = resetField(d, "instagram", "caption");
eq("caption" in d.targets[1]!.overrides, false, "reset deletes the key");
eq(resolveTarget(d, d.targets[1]!).caption, "New draft caption.", "after reset Instagram follows the draft again");
eq(base.targets.every((t) => !isOverridden(t)), true, "the original draft was never mutated");
eq(DraftSchema.safeParse(d).success, true, "the edited draft still meets the contract");

// ---- W2 ----
const issue = (platform: "instagram" | "tiktok" | "youtube", code: string, field: string) => ({
  platform,
  code,
  message: code,
  fixRoute: `/create/d1#${platform}.${field}`,
});
const blocked: PreflightResult = {
  blocking: [issue("instagram", "cover_missing", "cover"), issue("tiktok", "video_too_long", "cutId"), issue("instagram", "too_many_hashtags", "caption")],
  warnings: [issue("youtube", "font_off_brand", "cover")],
  ok: [issue("youtube", "title_ok", "title")],
};
eq(preflightSummary(blocked), { blocked: true, text: "3 issues across 2 platforms." }, "blocking summary");
eq(preflightSummary({ blocking: [], warnings: [], ok: [] }).blocked, false, "nothing blocking is clear");
eq(blocked.blocking.map(fixLabel), ["Fix cover", "Pick a cut", "Edit caption"], "fix labels follow the field");
eq(fixLabel(blocked.warnings[0]!), "Review brand", "brand kit warnings review the brand");
eq(fixTarget(blocked.blocking[1]!), { platform: "tiktok", field: "cutId" }, "fix link names the platform and field");
const jwt = (payload: object) => `x.${btoa(JSON.stringify(payload))}.y`;
eq(canOverridePreflight(principalFrom("owner", jwt({ sub: "u" }))), true, "the operator may override");
eq(canOverridePreflight(principalFrom("owner", jwt({ role: "bot", bot: "polly" }))), true, "Polly may override");
eq(canOverridePreflight(principalFrom("owner", jwt({ role: "bot", bot: "nova" }))), false, "another bot may not");
eq(canOverridePreflight(principalFrom("viewer", null)), false, "a viewer may not");
eq(canEditTemplates(principalFrom("owner", jwt({ role: "bot", bot: "polly" }))), true, "Polly can edit templates");

// ---- W3 ----
eq(moveId(["a", "b", "c", "d"], "c", 0), ["c", "a", "b", "d"], "move to the top");
eq(moveId(["a", "b", "c"], "a", 2), ["b", "c", "a"], "move to the end");
eq(moveId(["a", "b"], "a", 99), ["b", "a"], "past the end clamps");
eq(moveId(["a", "b"], "z", 0), ["a", "b"], "an unknown id changes nothing");
const q = (id: string, priority: "rush" | "normal", position: number) => ({ id, draftId: id, priority, position, state: "queued" as const });
eq(queueOrder([q("a", "normal", 0), q("b", "rush", 1), q("c", "normal", 2)]).map((i) => i.id), ["b", "a", "c"], "rush goes first");

// ---- W4 ----
eq([fmtMetric("views", 137_600), fmtMetric("likes", 9334), fmtMetric("avgWatchSeconds", 372), fmtMetric("shares", null)], ["137.6K", "9,334", "6:12", "n/a"], "metric formats");
const nulls = { youtube: null, instagram: null, tiktok: null, total: null };
eq(rollupHasData({ videoId: "v", rows: [{ metric: "views", ...nulls }] }), false, "all null is the Zernio empty state");
eq(rollupHasData({ videoId: "v", rows: [{ metric: "views", ...nulls, tiktok: 4, total: 4 }] }), true, "one number shows the table");

// ---- W5: the prefill keeps every field of the applied draft ----
const applied: Draft = {
  id: "template-t1-v1",
  brandId: "caleb",
  videoId: "v1",
  caption: "{car} {year}, ${price}. {hook}\n\n#bmw #carsforsale",
  title: "M3 review",
  postAt: "2026-10-29T22:00:00.000Z",
  targets: [
    { platform: "youtube", overrides: {} },
    { platform: "instagram", overrides: {} },
  ],
};
const mem = new Map<string, string>();
const store = { setItem: (k: string, v: string) => void mem.set(k, v), getItem: (k: string) => mem.get(k) ?? null };
stashDraft(applied, store);
eq(loadStashedDraft(store), applied, "every draft field survives the hand-off to the composer");
eq(loadStashedDraft({ getItem: () => "{not json" }), null, "a broken hand-off is ignored");
const t = { ...blankTemplate("caleb"), name: " Long-form weekly ", hashtags: ["bmw", "carsforsale"], postTimes: ["18:00", "12:00"] };
const form = templateToForm(t);
eq([form.hashtags, form.postTimes], ["#bmw #carsforsale", "18:00, 12:00"], "the form shows tags and times");
eq(formToTemplate(form), { ...t, name: "Long-form weekly" }, "and reads them back unchanged");

console.log("workflow checks passed");
