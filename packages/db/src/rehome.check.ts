// Waiting posts move from a removed account to its replacement: a NEW account, never one the brand already had.
import assert from "node:assert/strict";
import { REPLACEMENT_WINDOW_MS, rehomeIds, replacementFor as pick, type RehomeAccount } from "./rehome";

const removedAt = new Date("2026-11-23T04:10:00Z");
const before = (ms: number) => new Date(removedAt.getTime() - ms);
const after = (ms: number) => new Date(removedAt.getTime() + ms);
const acct = (id: string, platform: string, extra: Partial<RehomeAccount> = {}): RehomeAccount => ({
  id,
  platform,
  status: "connected",
  deletedAt: null,
  createdAt: before(90 * 86_400_000),
  tokensEncrypted: "provider:zernio",
  providerAccountId: `p-${id}`,
  ...extra,
});
const gone = (id: string, platform: string, extra: Partial<RehomeAccount> = {}) =>
  acct(id, platform, { deletedAt: removedAt, status: "error", tokensEncrypted: null, ...extra });

const oldTt = gone("oldTt", "tiktok");
const king = acct("king", "tiktok", { createdAt: after(2 * 60_000) });
const on = (...ids: string[]) => new Set(ids);
/** The id it moves to, "=id" when the post already goes there, or null. */
const replacementFor = (...a: Parameters<typeof pick>) => {
  const r = pick(...a);
  return r === null ? null : r.kind === "move" ? r.id : `=${r.id}`;
};

// Dudley's TikTok: the old one removed, @king.dud_ connected after it.
assert.equal(replacementFor(oldTt, [oldTt, king], on("oldTt")), "king", "the newly connected TikTok takes over");
assert.equal(
  replacementFor(oldTt, [oldTt, acct("king", "tiktok", { createdAt: before(30 * 60_000) })], on("oldTt")),
  "king",
  "connected shortly before the old one was removed counts too",
);
assert.equal(
  replacementFor(oldTt, [oldTt, acct("king", "tiktok", { createdAt: after(7 * 86_400_000) })], on("oldTt")),
  "king",
  "connected a week later still takes over what waited",
);
assert.equal(replacementFor(oldTt, [oldTt], on("oldTt")), null, "no replacement yet: left for the operator");
assert.equal(
  replacementFor(oldTt, [oldTt, king, acct("k2", "tiktok", { createdAt: after(60_000) })], on("oldTt")),
  null,
  "two new TikToks: ambiguous, so nothing moves",
);
// An account the brand already had never takes over, however lonely.
assert.equal(
  replacementFor(oldTt, [oldTt, acct("had", "tiktok", { createdAt: before(REPLACEMENT_WINDOW_MS + 60_000) })], on("oldTt")),
  null,
  "an existing account is a separate destination, not a replacement",
);
// The removed account coming back through a sync is not a replacement.
assert.equal(
  replacementFor(oldTt, [oldTt, acct("back", "tiktok", { createdAt: after(60_000), providerAccountId: "p-oldTt" })], on("oldTt")),
  null,
  "the same provider account re-imported is the removed one, not its replacement",
);
assert.equal(
  replacementFor(oldTt, [oldTt, acct("rem", "tiktok", { createdAt: after(60_000), tokensEncrypted: "reminder" })], on("oldTt")),
  null,
  "a reminder account is posted by hand, never a replacement",
);
assert.equal(
  replacementFor(oldTt, [oldTt, acct("broken", "tiktok", { createdAt: after(60_000), status: "needs_reconnect" })], on("oldTt")),
  null,
  "an account that cannot post is not a replacement",
);
// A removed reminder account (no provider id) never sends its posts anywhere automatic.
const remGone = gone("remGone", "tiktok", { providerAccountId: null });
assert.equal(replacementFor(remGone, [remGone, king], on("remGone")), null, "hand-post reminders stay reminders");

// Three Instagrams, a post on two: removing one never lands on the third the operator left off.
const ig1 = acct("ig1", "instagram");
const ig3 = acct("ig3", "instagram");
const ig2 = gone("ig2", "instagram");
assert.equal(replacementFor(ig2, [ig1, ig2, ig3], on("ig1", "ig2")), null, "ig3 was already there: not the replacement");
const igNew = acct("igNew", "instagram", { createdAt: after(60_000) });
assert.equal(replacementFor(ig2, [ig1, ig2, ig3, igNew], on("ig1", "ig2")), "igNew", "the newly connected Instagram is");

// Two connected the same day, one removed: the other is older than it, so never its replacement.
const n1 = acct("n1", "tiktok", { createdAt: before(5 * 3_600_000) });
const n2 = gone("n2", "tiktok", { createdAt: before(4.9 * 3_600_000) });
assert.equal(replacementFor(n2, [n1, n2], on("n2")), null, "an account older than the removed one is not its replacement");
// The post already goes to the replacement: nothing left to send for the removed one.
assert.equal(replacementFor(oldTt, [oldTt, king], on("oldTt", "king")), "=king", "already going there: the copy is redundant");
// One candidate already on this post, a second new one connected: ambiguous for every post alike.
const m = acct("m", "tiktok", { createdAt: after(3_600_000) });
assert.equal(replacementFor(oldTt, [oldTt, king, m], on("oldTt", "king")), null, "two new TikToks: ambiguous here too");
// A re-imported copy of a different removed account is not new either.
const otherGone = gone("otherGone", "tiktok", { providerAccountId: "p-x" });
assert.equal(
  replacementFor(oldTt, [oldTt, otherGone, acct("x2", "tiktok", { createdAt: after(60_000), providerAccountId: "p-x" })], on("oldTt"), new Set(["p-oldTt", "p-x"])),
  null,
  "any removed account coming back is not a replacement",
);

assert.deepEqual(rehomeIds(["ig1", "ig2"], [ig1, ig2, ig3, igNew]), ["ig1", "igNew"], "Drive's ticked list swaps too");
assert.deepEqual(rehomeIds(["ig1", "ig2"], [ig1, ig2, ig3]), ["ig1", "ig2"], "no replacement yet: kept, so a later connect still swaps it");
assert.deepEqual(rehomeIds(["ig1", "ig3"], [ig1, ig3]), ["ig1", "ig3"], "nothing removed, nothing changes");

console.log("rehome.check: ok");
