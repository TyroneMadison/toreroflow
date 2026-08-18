// Guards the grouping in dmTotalsByPost. The first version of this summed
// nothing: it grouped one campaign at a time, so two campaigns on one video
// each wrote the row and the second silently replaced the first. A client
// running a keyword campaign and a link campaign on the same post would have
// been shown whichever one synced last, as though the other never ran.
import assert from "node:assert/strict";
import { dmTotalsByPost } from "./dmStats";
import type { CommentAutomation } from "@toreroflow/publishers";

const base = {
  name: "c",
  platform: "instagram" as const,
  trigger: "comment" as const,
  postTitle: null,
  keywords: ["link"],
  matchMode: "contains" as const,
  excludeKeywords: [],
  dmMessage: "here you go",
  buttons: [],
  commentReply: null,
  alsoMatchInDms: false,
  isActive: true,
  createdAt: null,
};
const stats = (dmsSent: number, linkClicks = 0) => ({
  triggered: dmsSent,
  dmsSent,
  dmsFailed: 0,
  uniqueContacts: dmsSent,
  trackedSends: dmsSent,
  linkClicks,
  uniqueClicks: linkClicks,
  delivered: 0,
  read: 0,
});
const campaign = (over: Partial<CommentAutomation>): CommentAutomation =>
  ({
    ...base,
    id: "1",
    accountId: "acc1",
    platformPostId: "post1",
    linkTracking: true,
    stats: stats(0),
    ...over,
  }) as CommentAutomation;

// Two campaigns on one video add up rather than overwrite.
{
  const totals = dmTotalsByPost([
    campaign({ id: "a", stats: stats(12, 5) }),
    campaign({ id: "b", stats: stats(8, 3) }),
  ]);
  assert.equal(totals.length, 1, "one row per video");
  assert.equal(totals[0].dms, 20, "sends add");
  assert.equal(totals[0].clicks, 8, "clicks add");
}

// The same post id under a different account is a different video.
{
  const totals = dmTotalsByPost([
    campaign({ id: "a", accountId: "acc1", stats: stats(4) }),
    campaign({ id: "b", accountId: "acc2", stats: stats(7) }),
  ]);
  assert.equal(totals.length, 2, "post ids are only unique within an account");
  assert.deepEqual(
    totals.map((t) => t.dms).sort((x, y) => x - y),
    [4, 7],
  );
}

// Tracking off contributes sends but no denominator.
{
  const [only] = dmTotalsByPost([campaign({ linkTracking: false, stats: stats(9, 0) })]);
  assert.equal(only.dms, 9, "sends still count");
  assert.equal(only.clicks, null, "no tracked link means no click figure, not zero");
}

// A campaign with tracking on next to one with it off keeps a real denominator.
{
  const [both] = dmTotalsByPost([
    campaign({ id: "a", linkTracking: false, stats: stats(5, 0) }),
    campaign({ id: "b", linkTracking: true, stats: stats(5, 4) }),
  ]);
  assert.equal(both.dms, 10);
  assert.equal(both.clicks, 4, "only the tracking campaign contributes clicks");
}

// A genuinely measured zero survives: the campaign ran and nobody bit.
{
  const [zero] = dmTotalsByPost([campaign({ stats: stats(0, 0) })]);
  assert.equal(zero.dms, 0, "a campaign that reached nobody still reports");
  assert.equal(zero.clicks, 0, "tracking was on, so zero clicks is a result");
}

// Account-wide campaigns belong to no video and are left out entirely.
assert.deepEqual(
  dmTotalsByPost([campaign({ platformPostId: null, stats: stats(99) })]),
  [],
  "an account-wide campaign is never spread across videos",
);

console.log("dmStats.check: all checks passed");
