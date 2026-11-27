// AI replies (F5): every default keeps the AI OFF and in drafts only (the
// Prisma schema, every migration that touches DmAiSettings, and the code's own
// defaults), the draft and send gates, handoff rules, quiet hours, the delay
// cap, and the model's answer cleaned before anyone can send it.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DM_AI_DEFAULTS,
  DM_AI_DELAY_CAP_SEC,
  DM_AI_QUIET_MS,
  dmAiDelayMs,
  dmAiHandoffMatch,
  dmAiNoDraft,
  dmAiNoSend,
  dmAiSettingsOf,
  dmAiSettingsPatchSchema,
  dmAiSystemPrompt,
  dmAiTranscript,
  inQuietHours,
  readDmAiDecision,
  type DmAiContext,
} from "./dmAi";

const here = path.dirname(fileURLToPath(import.meta.url));
const dbDir = path.resolve(here, "../../db/prisma");

// ---- 1. OFF everywhere until a person turns it on ----
// Fails if ANY default in the AI settings model turns the AI on or to autopilot.
const schema = readFileSync(path.join(dbDir, "schema.prisma"), "utf8");
const model = schema.match(/model DmAiSettings \{([\s\S]*?)\n\}/)?.[1];
assert.ok(model, "schema.prisma has the DmAiSettings model");
assert.match(model!, /^\s*enabled\s+Boolean\s+@default\(false\)/m, "DmAiSettings.enabled defaults to false");
assert.match(model!, /^\s*mode\s+String\s+@default\("drafts"\)/m, "DmAiSettings.mode defaults to drafts");
for (const line of model!.split("\n")) {
  const m = line.match(/^\s*(\w+)\s+Boolean\s+@default\((true|false)\)/);
  // The only booleans allowed to default to true are the ones that make it MORE careful or slower.
  if (m && m[2] === "true") assert.ok(["typing", "pauseOnTeamReply"].includes(m[1]!), `DmAiSettings.${m[1]} must not default to true`);
}
assert.doesNotMatch(model!, /autopilot["']?\)/, "no autopilot default in the schema");
const thread = schema.match(/model DmThread \{([\s\S]*?)\n\}/)?.[1] ?? "";
assert.match(thread, /aiOff\s+Boolean\s+@default\(false\)/);
// Every migration that creates or changes the table says the same.
const migDir = path.join(dbDir, "migrations");
const migrations = readdirSync(migDir).filter((d) => !d.endsWith(".toml"));
const touching = migrations.map((d) => readFileSync(path.join(migDir, d, "migration.sql"), "utf8")).filter((sql) => sql.includes('"DmAiSettings"'));
assert.ok(touching.length >= 1, "a migration creates DmAiSettings");
for (const sql of touching) {
  for (const m of sql.matchAll(/"enabled" BOOLEAN[^,\n]*/g)) assert.match(m[0], /DEFAULT false/, `migration default for enabled: ${m[0]}`);
  for (const m of sql.matchAll(/"mode" TEXT[^,\n]*/g)) assert.match(m[0], /DEFAULT 'drafts'/, `migration default for mode: ${m[0]}`);
  assert.doesNotMatch(sql, /SET DEFAULT true|DEFAULT 'autopilot'/);
}
// The code's own defaults, and a missing or broken row.
assert.equal(DM_AI_DEFAULTS.enabled, false);
assert.equal(DM_AI_DEFAULTS.mode, "drafts");
assert.ok(Object.isFrozen(DM_AI_DEFAULTS));
for (const row of [null, undefined, {}, { enabled: "yes" }, { enabled: 1 }, { mode: "AUTOPILOT" }, { enabled: null, mode: null }]) {
  const s = dmAiSettingsOf(row as never);
  assert.equal(s.enabled, false, `no row or a broken one reads as off: ${JSON.stringify(row)}`);
  assert.equal(s.mode, "drafts");
}
assert.equal(dmAiSettingsOf({ enabled: true, mode: "autopilot" }).mode, "autopilot");

// ---- 2. the patch schema ----
assert.ok(dmAiSettingsPatchSchema.safeParse({ enabled: true }).success);
assert.equal(dmAiSettingsPatchSchema.safeParse({ replyDelayMaxSec: DM_AI_DELAY_CAP_SEC + 1 }).success, false, "the wait is capped at 5 minutes");
assert.equal(dmAiSettingsPatchSchema.safeParse({ replyDelayMinSec: 90, replyDelayMaxSec: 20 }).success, false);
assert.equal(dmAiSettingsPatchSchema.safeParse({ mode: "yolo" }).success, false);
assert.equal(dmAiSettingsPatchSchema.safeParse({ links: [{ label: "x", url: "javascript:alert(1)" }] }).success, false);
assert.equal(dmAiSettingsPatchSchema.safeParse({ somethingElse: true }).success, false, "strict: unknown keys refused");
assert.equal(dmAiSettingsPatchSchema.safeParse({ quietStartHour: 24 }).success, false);
// A stored row past the cap is clamped, and min never exceeds max.
const clamped = dmAiSettingsOf({ replyDelayMinSec: 900, replyDelayMaxSec: 10 });
assert.ok(clamped.replyDelayMaxSec <= DM_AI_DELAY_CAP_SEC && clamped.replyDelayMinSec <= clamped.replyDelayMaxSec);
for (let k = 0; k < 50; k++) {
  const ms = dmAiDelayMs({ replyDelayMinSec: 20, replyDelayMaxSec: 90 });
  assert.ok(ms >= 20_000 && ms <= 90_000);
}
assert.equal(dmAiDelayMs({ replyDelayMinSec: 0, replyDelayMaxSec: 0 }), 0);

// ---- 3. handoff rules and quiet hours ----
const topics = { handoffTopics: [...DM_AI_DEFAULTS.handoffTopics], handoffWords: [] as string[] };
assert.equal(dmAiHandoffMatch("How much is a class?", topics)?.why, "Asked about price");
assert.equal(dmAiHandoffMatch("I want my money back", topics)?.why, "Asked about a refund");
assert.equal(dmAiHandoffMatch("Can I talk to someone real?", topics)?.why, "Asked for a person");
assert.equal(dmAiHandoffMatch("Third time asking about my order", topics)?.why, "Made a complaint");
assert.equal(dmAiHandoffMatch("Are you a bot?", topics), null, "the AI answers that itself, honestly");
assert.equal(dmAiHandoffMatch("Are you open on Sundays?", topics), null);
assert.equal(dmAiHandoffMatch("How much is it?", { handoffTopics: [], handoffWords: [] }), null, "a topic switched off does not hand off");
assert.equal(dmAiHandoffMatch("Can I bring my own mat?", { handoffTopics: [], handoffWords: ["mat"] })?.why, 'Said "mat"');
assert.equal(dmAiHandoffMatch("Great matinee", { handoffTopics: [], handoffWords: ["mat"] }), null, "own words match whole words");
const at = (iso: string) => new Date(iso);
assert.equal(inQuietHours(at("2026-11-27T23:30:00Z"), 22, 7, "UTC"), true);
assert.equal(inQuietHours(at("2026-11-27T06:59:00Z"), 22, 7, "UTC"), true);
assert.equal(inQuietHours(at("2026-11-27T07:00:00Z"), 22, 7, "UTC"), false);
assert.equal(inQuietHours(at("2026-11-27T13:00:00Z"), 12, 14, "UTC"), true);
assert.equal(inQuietHours(at("2026-11-27T13:00:00Z"), null, 14, "UTC"), false);
assert.equal(inQuietHours(at("2026-11-27T13:00:00Z"), 9, 9, "UTC"), false);
// 03:00 UTC is 22:00 in New York the evening before (EST, UTC-5).
assert.equal(inQuietHours(at("2026-11-27T03:00:00Z"), 22, 7, "America/New_York"), true);

// ---- 4. the draft and send gates ----
const now = at("2026-11-27T15:00:00Z");
const ctx = (patch: Partial<DmAiContext> = {}, t: Partial<DmAiContext["thread"]> = {}, s: Record<string, unknown> = {}): DmAiContext => ({
  now,
  settings: dmAiSettingsOf({ enabled: true, mode: "autopilot", ...s }),
  killed: false,
  platform: "instagram",
  native: true,
  friend: false,
  automationAnswered: false,
  sentToday: 0,
  timezone: "UTC",
  ...patch,
  thread: {
    status: "open",
    pausedAt: null,
    aiOff: false,
    aiHandoffAt: null,
    aiPausedUntil: null,
    lastDirection: "in",
    lastInboundAt: new Date(now.getTime() - 60_000),
    windowEndsAt: new Date(now.getTime() + 23 * 3600_000),
    ...t,
  },
});
assert.equal(dmAiNoDraft(ctx()), null, "an enabled account drafts a quiet chat");
assert.equal(dmAiNoSend(ctx()), null, "autopilot sends when everything allows it");
assert.match(dmAiNoDraft(ctx({ settings: dmAiSettingsOf(null) }))!, /off/, "the default (no row) never drafts");
assert.equal(dmAiNoSend(ctx({ settings: dmAiSettingsOf(null) }))?.keep, "skip", "the default never sends");
assert.equal(dmAiNoSend(ctx({}, {}, { mode: "drafts" }))?.keep, "draft", "drafts only never sends on its own");
assert.equal(dmAiNoSend(ctx({ killed: true }))?.keep, "draft", "the kill switch stops every send, keeping the draft");
assert.match(dmAiNoDraft(ctx({ platform: "facebook", native: false }))!, /Instagram/, "Messenger is never drafted on its own");
assert.equal(dmAiNoSend(ctx({ platform: "facebook", native: false }))?.keep, "draft", "Messenger is never sent by the AI");
assert.equal(dmAiNoSend(ctx({ native: false }))?.keep, "draft", "Instagram through Zernio is never sent by the AI");
assert.ok(dmAiNoDraft(ctx({}, { pausedAt: now })), "paused chats are left alone");
assert.equal(dmAiNoSend(ctx({}, { pausedAt: now }))?.keep, "skip");
assert.ok(dmAiNoDraft(ctx({}, { aiOff: true })), "AI off in this chat");
assert.ok(dmAiNoDraft(ctx({}, { aiHandoffAt: now })), "handed off");
assert.equal(dmAiNoSend(ctx({}, { aiHandoffAt: now }))?.keep, "skip");
assert.ok(dmAiNoDraft(ctx({}, { aiPausedUntil: new Date(now.getTime() + 3600_000) })), "paused after a team reply");
assert.equal(dmAiNoDraft(ctx({}, { aiPausedUntil: new Date(now.getTime() - 1) })), null, "and back once the pause ends");
assert.ok(dmAiNoDraft(ctx({ friend: true })), "friends are never answered");
assert.ok(dmAiNoDraft(ctx({}, { lastDirection: "out" })), "only when they spoke last (one reply per message)");
assert.equal(dmAiNoSend(ctx({}, { lastDirection: "out" }))?.keep, "skip", "someone replied in the meantime");
assert.ok(dmAiNoDraft(ctx({}, { lastInboundAt: new Date(now.getTime() - DM_AI_QUIET_MS + 1000) })), "waits until the chat goes quiet");
assert.ok(dmAiNoDraft(ctx({}, { windowEndsAt: new Date(now.getTime() - 1) })), "never outside the 24h window");
assert.equal(dmAiNoSend(ctx({}, { windowEndsAt: new Date(now.getTime() + 60_000) }))?.keep, "skip", "not when the window is about to close");
assert.ok(dmAiNoDraft(ctx({ automationAnswered: true })), "an automation already answered");
assert.ok(dmAiNoDraft(ctx({}, { status: "done" })));
assert.equal(dmAiNoSend(ctx({ sentToday: 50 }))?.keep, "draft", "the daily cap keeps it as a draft");
assert.equal(dmAiNoSend(ctx({}, {}, { quietStartHour: 14, quietEndHour: 16 }))?.keep, "draft", "quiet hours keep it as a draft");

// ---- 5. the model's answer ----
const links = [{ label: "Booking page", url: "https://sample.link/book" }];
const ok = readDmAiDecision(JSON.stringify({ action: "reply", bubbles: ["Hi! We are open 7 AM to 8 PM \u2014 see you", "Book here: https://sample.link/book", "Or here https://evil.example/x"], stage: "engaged", note: "Wants Sunday", reason: "hours" }), { links });
assert.equal(ok.action, "reply");
assert.ok(!ok.bubbles.join(" ").includes("\u2014"), "no em dashes");
assert.ok(ok.bubbles.some((b) => b.includes("https://sample.link/book")), "the account's own link stays");
assert.ok(!ok.bubbles.join(" ").includes("evil.example"), "any other link is removed");
assert.ok(ok.bubbles.length <= 3);
const many = readDmAiDecision(JSON.stringify({ action: "reply", bubbles: ["a", "b", "c", "d", "e"], stage: "new", note: "", reason: "" }), { links: [] });
assert.equal(many.bubbles.length, 3);
assert.equal(readDmAiDecision("not json", { links }).action, "handoff", "unreadable becomes a handoff");
assert.equal(readDmAiDecision(JSON.stringify({ action: "reply", bubbles: ["https://evil.example"], stage: "new", note: "", reason: "" }), { links }).action, "handoff", "a reply that is only a stray link becomes a handoff");
assert.equal(readDmAiDecision(JSON.stringify({ action: "handoff", bubbles: ["ignored"], stage: "nope", note: "", reason: "" }), { links }).bubbles.length, 0);
assert.equal(readDmAiDecision(JSON.stringify({ action: "stop", bubbles: [], stage: "won", note: "", reason: "thanks" }), { links }).action, "stop");

// ---- 6. the prompt ----
const sys = dmAiSystemPrompt("Sample Client", "sample.handle", dmAiSettingsOf({ instructions: "Open 7 AM to 8 PM.", links }), "Instagram");
assert.match(sys, /assistant for Sample Client/);
assert.match(sys, /Never claim or suggest you are a person/);
assert.match(sys, /Open 7 AM to 8 PM\./);
assert.match(sys, /https:\/\/sample\.link\/book/);
assert.doesNotMatch(sys, /\u2014/, "no em dashes in the prompt either");
const tr = dmAiTranscript("Alex", [
  { direction: "in", text: "Hi" },
  { direction: "out", text: "Hey!" },
  { direction: "in", text: null, kinds: ["story_reply"] },
]);
assert.match(tr, /THEM: Hi\nYOU: Hey!\nTHEM: \[story reply\]/);

console.log("dmAi.check: ok");
