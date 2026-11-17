import type { PostTargetInfo } from "./api";
import type { Platform } from "./platforms";
import type { PostStatus } from "./postStatus";
import { dragMoves, groupByPost, groupMovable, groupStatus, otherTimes, targetTime } from "./postGroups";

/** Local so the file stays part of the app's typecheck without pulling in node types. */
const assert = {
  equal(actual: unknown, expected: unknown, message: string) {
    if (actual !== expected) {
      throw new Error(`${message}\n  expected: ${String(expected)}\n  actual:   ${String(actual)}`);
    }
  },
};

/**
 * Runnable check for the calendar's one-card-per-post grouping:
 * `pnpm --filter @toreroflow/desktop test`.
 *
 * What it guards: one video scheduled to three platforms is one card with
 * three icons, placed at its earliest time; a failure on one platform is never
 * hidden by a sibling that posted; dragging moves only what can still move,
 * all by the same number of days at their own clock times.
 */

const at = (m: number, d: number, h: number, mi = 0) => new Date(2027, m - 1, d, h, mi).toISOString();
let n = 0;
const target = (postId: string, platform: Platform, scheduledAt: string | null, status: PostStatus = "scheduled"): PostTargetInfo => ({
  id: `t${++n}`,
  postId,
  platform,
  status,
  scheduledAt,
  publishedAt: null,
  error: null,
  remotePostId: null,
  remoteUrl: null,
  caption: null,
  hashtags: [],
  youtubeTitle: null,
  mediaAssetId: `m-${postId}`,
  queueDismissed: false,
  assetName: postId,
  thumbUrl: null,
  assetKind: "video",
  slideCount: 0,
});
const platforms = (g: { targets: PostTargetInfo[] }) => g.targets.map((t) => t.platform).join(",");
const clock = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

// One video to three platforms at one time is one card, icons in platform order.
{
  const groups = groupByPost([
    target("a", "youtube", at(3, 1, 9)),
    target("a", "instagram", at(3, 1, 9)),
    target("a", "tiktok", at(3, 1, 9)),
  ]);
  assert.equal(groups.length, 1, "three platforms of one post are one card");
  assert.equal(platforms(groups[0]!), "tiktok,instagram,youtube", "icons read TikTok, Instagram, YouTube");
  assert.equal(otherTimes(groups[0]!).length, 0, "nothing else to say when all go out together");
}

// Two posts are two cards, earliest first; Facebook and Snapchat follow the big three.
{
  const groups = groupByPost([
    target("late", "tiktok", at(3, 2, 18)),
    target("early", "snapchat", at(3, 2, 8)),
    target("early", "facebook", at(3, 2, 8)),
    target("early", "tiktok", at(3, 2, 8)),
  ]);
  assert.equal(groups.map((g) => g.postId).join(","), "early,late", "cards come back earliest first");
  assert.equal(platforms(groups[0]!), "tiktok,facebook,snapchat", "facebook and snapchat sit after the big three");
}

// Staggered times: the card sits at the earliest, the others are spelled out.
{
  const ig = at(3, 3, 15);
  const yt = at(3, 4, 9);
  const [g] = groupByPost([target("s", "instagram", ig), target("s", "tiktok", at(3, 3, 9)), target("s", "youtube", yt)]);
  assert.equal(g!.lead.platform, "tiktok", "the earliest target places the card");
  const day = new Date(yt).toLocaleDateString([], { month: "short", day: "numeric" });
  assert.equal(otherTimes(g!).join(" | "), `IG ${clock(ig)} | YT ${day}, ${clock(yt)}`, "same day shows the clock, another day the date too");
}

// Two accounts on one platform at one time read once, not twice.
{
  const [g] = groupByPost([target("d", "tiktok", at(3, 5, 9)), target("d", "instagram", at(3, 5, 15)), target("d", "instagram", at(3, 5, 15))]);
  assert.equal(g!.targets.length, 3, "both Instagram accounts keep their own row");
  assert.equal(otherTimes(g!).length, 1, "their shared time is listed once");
}

// A window: a post straddling its edge still shows once, at its earliest time inside it, with every platform.
{
  const list = [target("w", "tiktok", at(3, 7, 22)), target("w", "instagram", at(3, 8, 9)), target("x", "tiktok", at(3, 6, 12))];
  const week = { from: new Date(2027, 2, 8), to: new Date(2027, 2, 14, 23, 59, 59, 999) };
  const groups = groupByPost(list, week);
  assert.equal(groups.length, 1, "a post with nothing in the window is left out");
  assert.equal(groups[0]!.lead.platform, "instagram", "placed at its earliest time inside the window");
  assert.equal(platforms(groups[0]!), "tiktok,instagram", "the platform outside the window is still on the card");
  assert.equal(groupByPost(list)[1]!.lead.platform, "tiktok", "without a window the true earliest places it");
}

// An unscheduled sibling never places the card, and stays in the panel.
{
  const [g] = groupByPost([target("u", "tiktok", null), target("u", "youtube", at(3, 9, 10))]);
  assert.equal(g!.lead.platform, "youtube", "an unscheduled target never leads");
  assert.equal(g!.targets.length, 2, "it still has a row");
  assert.equal(targetTime(g!.targets[0]!, g!.lead), "not scheduled", "and says so");
}

// The card's status: the most urgent platform wins; each icon keeps its own.
{
  const status = (...s: PostStatus[]) =>
    groupStatus(groupByPost(s.map((x, i) => target(`g${s.join()}`, (["tiktok", "instagram", "youtube"] as const)[i]!, at(3, 10, 9), x)))[0]!);
  assert.equal(status("posted", "failed", "scheduled"), "failed", "a failure is never hidden by a sibling that posted");
  assert.equal(status("posted", "scheduled"), "scheduled", "pending work outranks finished work");
  assert.equal(status("publishing", "scheduled"), "publishing", "in flight outranks waiting");
  assert.equal(status("reminded", "posted"), "reminded", "sent to the client outranks posted");
  assert.equal(status("posted", "posted"), "posted", "all done reads done");
}

// Dragging: every platform that can move shifts by the same days at its own clock time; locked ones stay.
{
  const tt = target("m", "tiktok", at(3, 11, 9));
  const ig = target("m", "instagram", at(3, 11, 15, 30));
  const yt = target("m", "youtube", at(3, 11, 9), "posted");
  const fb = target("m", "facebook", at(3, 12, 9), "failed");
  const [g] = groupByPost([tt, ig, yt, fb]);
  assert.equal(groupMovable(g!), true, "a card with a scheduled platform can be dragged");
  const moves = dragMoves(g!, new Date(2027, 2, 15));
  assert.equal(moves.map((m) => m.target.platform).join(","), "tiktok,instagram", "posted and failed platforms stay put");
  const igMove = moves.find((m) => m.target.id === ig.id)!.when;
  assert.equal(igMove.getDate(), 15, "four days later");
  assert.equal(`${igMove.getHours()}:${igMove.getMinutes()}`, "15:30", "at its own clock time");
  assert.equal(dragMoves(g!, new Date(2027, 2, 11, 18)).length, 0, "dropping on its own day moves nothing");
  assert.equal(dragMoves(g!, new Date(2027, 2, 10))[0]!.when.getDate(), 10, "a day earlier works too");
  const locked = groupByPost([target("l", "tiktok", at(3, 11, 9), "posted"), target("l", "instagram", at(3, 11, 9), "publishing")])[0]!;
  assert.equal(groupMovable(locked), false, "nothing to move means no drag");
  assert.equal(dragMoves(locked, new Date(2027, 2, 13)).length, 0, "and a drop moves nothing");
}

// Across a daylight saving change (March 14 2027 in the US) 9:00 stays 9:00 wherever this runs.
{
  const [g] = groupByPost([target("dst", "tiktok", at(3, 13, 9))]);
  const when = dragMoves(g!, new Date(2027, 2, 15))[0]!.when;
  assert.equal(`${when.getDate()} ${when.getHours()}:${when.getMinutes()}`, "15 9:0", "same wall-clock time after the change");
}

console.log("postGroups.check.ts: all checks passed");
