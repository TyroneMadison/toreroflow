// DM automations (F4): the matcher, scope, the pick order, the send windows,
// variables and the publish rules. Runs with `tsx src/automations.check.ts`.
import assert from "node:assert/strict";
import {
  canStillSend,
  configOf,
  dmAutomationConfigSchema,
  dmAutomationPatchSchema,
  fillText,
  keywordHit,
  matchEvent,
  overlapKeywords,
  pickAutomation,
  pickVariant,
  publishProblems,
  templateConfig,
  type DmAutomationConfig,
  type DmTriggerEvent,
} from "./automations";

const base = templateConfig("comment_link");
const cfg = (patch: Partial<DmAutomationConfig>): DmAutomationConfig => ({ ...base, steps: [{ type: "message", text: "Here you go", button: null }], ...patch });
const now = new Date("2026-11-27T12:00:00Z");
const comment = (text: string, mediaId: string | null = "17900000000000001", at = now): DmTriggerEvent => ({ kind: "comment", text, mediaId, at });
const dm = (text: string | null, o: Partial<Extract<DmTriggerEvent, { kind: "message" }>> = {}): DmTriggerEvent => ({
  kind: "message",
  text,
  storyReply: false,
  storyMention: false,
  firstMessage: false,
  at: now,
  ...o,
});

// ---- match modes ----
const kw = { keywords: ["GUIDE", "free"], excludeKeywords: [] as string[] };
assert.equal(keywordHit({ ...kw, matchMode: "contains" }, "can I get the guide pls"), "GUIDE", "contains, any case");
assert.equal(keywordHit({ ...kw, matchMode: "contains" }, "guides please"), "GUIDE", "contains matches inside a word");
assert.equal(keywordHit({ ...kw, matchMode: "word" }, "guides please"), null, "whole word does not");
assert.equal(keywordHit({ ...kw, matchMode: "word" }, "the GUIDE!!"), "GUIDE", "whole word ignores punctuation");
assert.equal(keywordHit({ ...kw, matchMode: "exact" }, "Guide."), "GUIDE", "exact ignores case and punctuation");
assert.equal(keywordHit({ ...kw, matchMode: "exact" }, "guide please"), null, "exact is the whole comment");
assert.equal(keywordHit({ ...kw, matchMode: "any" }, "love this"), "", "any matches everything");
assert.equal(keywordHit({ ...kw, matchMode: "contains" }, "love this"), null);
assert.equal(keywordHit({ ...kw, matchMode: "contains", excludeKeywords: ["stop"] }, "guide? no stop"), null, "never match wins");
assert.equal(keywordHit({ ...kw, matchMode: "any", excludeKeywords: ["unsubscribe"] }, "please unsubscribe me"), null, "never match beats any");

// ---- scope ----
const one = cfg({ keywords: ["GUIDE"], scope: "posts", postIds: ["17900000000000001"] });
assert.equal(matchEvent(one, comment("GUIDE")).ok, true, "the picked post");
assert.equal(matchEvent(one, comment("GUIDE", "17900000000000002")).ok, false, "another post");
assert.equal(matchEvent(one, comment("GUIDE", null)).ok, false, "unknown post");
const next = cfg({ keywords: ["GUIDE"], scope: "next", postIds: [] });
assert.equal(matchEvent(next, comment("GUIDE")).ok, false, "next post not locked yet: nothing");
assert.equal(matchEvent({ ...next, postIds: ["17900000000000001"] }, comment("GUIDE")).ok, true, "locked onto it");
assert.equal(matchEvent(cfg({ keywords: ["GUIDE"] }), comment("guide", "17999999999999999")).ok, true, "any post");

// ---- triggers ----
const story = cfg({ trigger: "story_reply", matchMode: "any", keywords: [] });
assert.equal(matchEvent(story, dm("fire", { storyReply: true })).ok, true);
assert.equal(matchEvent(story, dm("fire")).ok, false, "a plain DM is not a story reply");
assert.equal(matchEvent(cfg({ trigger: "story_mention" }), dm(null, { storyMention: true })).ok, true);
const dmk = cfg({ trigger: "dm_keyword", keywords: ["BOOK"] });
assert.equal(matchEvent(dmk, dm("can I book?")).ok, true);
assert.equal(matchEvent(dmk, comment("BOOK")).ok, false, "a DM keyword automation ignores comments");
assert.equal(matchEvent(cfg({ keywords: ["GUIDE"], alsoDmKeyword: true }), dm("guide please")).ok, true, "also answer DMs with the keyword");
assert.equal(matchEvent(cfg({ keywords: ["GUIDE"] }), dm("guide please")).ok, false, "unless that is off");
const welcome = cfg({ trigger: "welcome", matchMode: "any" });
assert.equal(matchEvent(welcome, dm("hi", { firstMessage: true })).ok, true);
assert.equal(matchEvent(welcome, dm("hi again")).ok, false, "only the first message");

// ---- pick order: one event, one reply ----
const at = (s: number) => new Date(now.getTime() + s * 1000);
const list = [
  { id: "wide", config: cfg({ keywords: ["GUIDE"] }), createdAt: at(0) },
  { id: "post", config: one, createdAt: at(5) },
  { id: "welcome", config: welcome, createdAt: at(1) },
  { id: "book", config: dmk, createdAt: at(9) },
];
assert.equal(pickAutomation(list, comment("GUIDE"))?.automation.id, "post", "a post-specific automation beats an account-wide one");
assert.equal(pickAutomation(list, comment("GUIDE", "17900000000000009"))?.automation.id, "wide");
assert.equal(pickAutomation(list, dm("book me", { firstMessage: true }))?.automation.id, "book", "a keyword beats the welcome");
assert.equal(pickAutomation(list, dm("hello", { firstMessage: true }))?.automation.id, "welcome", "the welcome when nothing else matched");
assert.equal(pickAutomation(list, comment("love it")), null);

// ---- windows: 7 days for a comment, 24h for a DM; never HUMAN_AGENT ----
const day = 24 * 3600_000;
assert.equal(canStillSend({ kind: "comment", at: new Date(now.getTime() - 6 * day) }, now), true);
assert.equal(canStillSend({ kind: "comment", at: new Date(now.getTime() - 8 * day) }, now), false, "a private reply is 7 days at most");
assert.equal(canStillSend({ kind: "message", at: new Date(now.getTime() - 23 * 3600_000) }, now), true);
assert.equal(canStillSend({ kind: "message", at: new Date(now.getTime() - 25 * 3600_000) }, now), false, "a DM answer needs the 24h window");

// ---- variables and variants ----
assert.equal(fillText("Hi {first_name}, here {username}", { name: "Maya Rivera", username: "maya.r" }), "Hi Maya, here @maya.r");
assert.equal(fillText("Hi {first_name}!", { name: null, username: null }), "Hi there!");
assert.equal(pickVariant(["a", "b", "c"], 0.99), "c");
assert.equal(pickVariant(["", " "]), null);

// ---- scope ids: Instagram only ----
assert.equal(dmAutomationPatchSchema.safeParse({ postIds: ["dQw4w9WgXcQ"] }).success, false, "a YouTube id never reaches the scope");
assert.equal(dmAutomationPatchSchema.safeParse({ postIds: ["17895695668004550"] }).success, true);
assert.equal(dmAutomationConfigSchema.safeParse({ ...base, postIds: ["UCxyz"] }).success, false);
assert.equal(dmAutomationPatchSchema.safeParse({ steps: [{ type: "message", text: "x", button: { title: "Go", url: "http://x.test" } }] }).success, false, "button links are https");

// ---- publish rules ----
assert.deepEqual(publishProblems(cfg({ keywords: ["GUIDE"] })), []);
assert.ok(publishProblems(cfg({ keywords: [] })).length, "a comment automation needs a keyword or Any");
assert.deepEqual(publishProblems(cfg({ keywords: [], matchMode: "any" })), []);
assert.ok(publishProblems(cfg({ trigger: "dm_keyword", matchMode: "any" })).length, "Any would answer every DM");
assert.ok(publishProblems(cfg({ keywords: ["x"], steps: [{ type: "message", text: " ", button: null }] })).length, "the DM is required");
assert.ok(publishProblems(cfg({ keywords: ["x"], scope: "posts", postIds: [] })).length);
assert.ok(publishProblems(cfg({ keywords: ["x"], publicReplyOn: true, publicReplies: [] })).length);

// ---- a DB row or snapshot back into a config ----
assert.deepEqual(configOf({ trigger: "welcome", keywords: null, steps: [{ type: "message", text: "hey" }] }).trigger, "welcome");
assert.equal(configOf({ trigger: "nonsense" }).trigger, "comment", "a bad value falls back");

// ---- overlap with a Zernio campaign ----
const native = { socialAccountId: "sa1", config: cfg({ keywords: ["GUIDE", "FREE"] }) };
assert.deepEqual(overlapKeywords(native, { socialAccountId: "sa1", keywords: ["guide"], postId: null }), ["GUIDE"]);
assert.equal(overlapKeywords(native, { socialAccountId: "sa2", keywords: ["guide"], postId: null }), null, "another account");
assert.equal(overlapKeywords(native, { socialAccountId: "sa1", keywords: ["price"], postId: null }), null);
assert.equal(overlapKeywords({ socialAccountId: "sa1", config: one }, { socialAccountId: "sa1", keywords: ["GUIDE"], postId: "17900000000000005" }), null, "different posts");
assert.deepEqual(overlapKeywords({ socialAccountId: "sa1", config: cfg({ matchMode: "any" }) }, { socialAccountId: "sa1", keywords: ["x"], postId: null }), []);

console.log("automations.check: ok");
