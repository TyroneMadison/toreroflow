import type { PostTargetInfo } from "./api";
import { PF_ID } from "./platforms";
import { canMove, type PostStatus } from "./postStatus";

/**
 * One post on the calendar: one video or carousel, with every platform it is
 * scheduled to. The calendar draws one card per group, not one per target.
 */
export interface PostGroup {
  postId: string;
  /** Every target of the post, in platform order (TikTok, Instagram, YouTube, Facebook, Snapchat). */
  targets: PostTargetInfo[];
  /** The target that places the card: the earliest one inside the window. */
  lead: PostTargetInfo;
}

/** Icon order on a card and row order in the details panel. */
const PLATFORM_ORDER = ["tiktok", "instagram", "youtube", "facebook", "snapchat"];

const time = (t: PostTargetInfo) => (t.scheduledAt ? new Date(t.scheduledAt).getTime() : Infinity);

/**
 * The calendar's cards: one per post, placed at its earliest time.
 *
 * With a window, the card sits at the earliest target inside it. The API sends
 * every target of a post that has any target in the window, so a post whose
 * platforms straddle a week or month edge still shows all its icons, and it
 * shows once in each view that holds one of its platforms rather than
 * vanishing from the later one. A post with nothing inside the window is left
 * out. Cards come back earliest first.
 */
export function groupByPost(targets: PostTargetInfo[], window?: { from: Date; to: Date }): PostGroup[] {
  const byPost = new Map<string, PostTargetInfo[]>();
  for (const t of targets) byPost.set(t.postId, [...(byPost.get(t.postId) ?? []), t]);

  const inWindow = (t: PostTargetInfo) =>
    t.scheduledAt !== null &&
    (!window || (time(t) >= window.from.getTime() && time(t) <= window.to.getTime()));

  const groups: PostGroup[] = [];
  for (const [postId, list] of byPost) {
    const lead = list.filter(inWindow).sort((a, b) => time(a) - time(b))[0];
    if (!lead) continue;
    const ordered = [...list].sort(
      (a, b) => PLATFORM_ORDER.indexOf(a.platform) - PLATFORM_ORDER.indexOf(b.platform) || time(a) - time(b),
    );
    groups.push({ postId, targets: ordered, lead });
  }
  return groups.sort((a, b) => time(a.lead) - time(b.lead) || a.postId.localeCompare(b.postId));
}

/**
 * The one status a card's dot, accent bar and padlock show. The most urgent
 * wins, so a failure is never hidden behind a sibling that posted fine; each
 * platform's own status still shows on its icon.
 */
const URGENCY: PostStatus[] = ["failed", "publishing", "scheduled", "reminded", "posted"];
export function groupStatus(group: PostGroup): PostStatus {
  return URGENCY.find((s) => group.targets.some((t) => t.status === s)) ?? group.lead.status;
}

/** A card can be dragged while any of its platforms can still move. */
export function groupMovable(group: PostGroup): boolean {
  return group.targets.some((t) => canMove(t.status));
}

const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * Where a dropped card's platforms land. Every target that can still move
 * shifts by the same number of local calendar days, keeping its own clock
 * time (so 9:00 stays 9:00 across a daylight saving change). Posted, failed
 * and in-flight targets stay where they are. Empty when the day is the card's own.
 */
export function dragMoves(group: PostGroup, day: Date): Array<{ target: PostTargetInfo; when: Date }> {
  // Two local midnights are whole days apart, give or take a DST hour.
  const delta = Math.round((midnight(day) - midnight(new Date(group.lead.scheduledAt!))) / 86_400_000);
  if (delta === 0) return [];
  return group.targets
    .filter((t) => t.scheduledAt && canMove(t.status))
    .map((t) => {
      const when = new Date(t.scheduledAt!);
      when.setDate(when.getDate() + delta);
      return { target: t, when };
    });
}

const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
const clock = (d: Date) => d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/** A target's time as the card reads it: the clock on the card's own day, the date too on any other. */
export function targetTime(t: PostTargetInfo, lead: PostTargetInfo): string {
  if (!t.scheduledAt) return "not scheduled";
  const at = new Date(t.scheduledAt);
  if (lead.scheduledAt && sameDay(at, new Date(lead.scheduledAt))) return clock(at);
  return `${at.toLocaleDateString([], { month: "short", day: "numeric" })}, ${clock(at)}`;
}

/** The platforms that do not go out at the card's own time, e.g. ["IG 3:00 PM", "YT Nov 18, 9:00 AM"]. */
export function otherTimes(group: PostGroup): string[] {
  const labels = group.targets
    .filter((t) => time(t) !== time(group.lead))
    .map((t) => `${PF_ID[t.platform].toUpperCase()} ${targetTime(t, group.lead)}`);
  return [...new Set(labels)];
}
