// The publish claim holds a paused brand's posts: the conditional update the
// worker runs right before publishing, against a stub that applies the same
// where clause Postgres would.
import assert from "node:assert/strict";
import fs from "node:fs";
import { claimForPublish } from "./pauseGuard";

const clients: Record<string, { pausedAt: Date | null }> = { live: { pausedAt: null }, held: { pausedAt: new Date() } };
const targets = [
  { id: "t1", status: "scheduled", clientId: "live" },
  { id: "t2", status: "scheduled", clientId: "held" },
  { id: "t3", status: "posted", clientId: "live" },
];
const prisma = {
  postTarget: {
    updateMany: async ({ where, data }: any) => {
      const hits = targets.filter(
        (t) =>
          t.id === where.id &&
          t.status === where.status &&
          clients[t.clientId]!.pausedAt === where.post.client.pausedAt,
      );
      for (const t of hits) t.status = data.status;
      return { count: hits.length };
    },
  },
} as any;

assert.equal(await claimForPublish(prisma, "t1"), true, "live brand publishes");
assert.equal(targets[0]!.status, "publishing");
assert.equal(await claimForPublish(prisma, "t2"), false, "paused brand is held");
assert.equal(targets[1]!.status, "scheduled", "held post keeps its status");
assert.equal(await claimForPublish(prisma, "t3"), false, "already posted");
clients.held!.pausedAt = null;
assert.equal(await claimForPublish(prisma, "t2"), true, "publishes once resumed");

// The worker routes every publish through this claim and skips paused brands up front.
const worker = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
assert.match(worker, /if \(target\.post\.client\.pausedAt\) \{/);
assert.match(worker, /if \(!\(await claimForPublish\(prisma, target\.id\)\)\) return;/);
assert.match(worker, /scheduledAt: \{ gt: new Date\(\) \}, post: \{ client: \{ pausedAt: null \} \}/, "boot re-queue skips paused brands");
console.log("pauseGuard.check: ok");
