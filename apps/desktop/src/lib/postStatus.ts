import type { PostTargetInfo } from "./api";

export type PostStatus = PostTargetInfo["status"];

export interface StatusMeta {
  /** The word on a week or day card. */
  label: string;
  /** What the legend adds after the label. */
  hint: string;
  /** Pulses to pull the eye. Only what is live or broken earns motion. */
  pulses: boolean;
  /** Whether the operator can drag it. The server enforces the same rule. */
  movable: boolean;
  icon: "lock" | "unlock" | "alert";
}

/**
 * What each post status looks like and whether it can be moved.
 *
 * This is the only place either question is answered. The drag rule used to
 * be hand-written in four components and enforced independently by
 * `PATCH /posts/targets/:id/reschedule`, so a drift would have meant the app
 * inviting a drag the server answers with a 409.
 *
 * Insertion order is the lifecycle, which is the order the legend reads in.
 */
export const POST_STATUS: Record<PostStatus, StatusMeta> = {
  scheduled: {
    label: "Scheduled",
    hint: "drag to move",
    pulses: false,
    movable: true,
    icon: "unlock",
  },
  publishing: {
    label: "Publishing",
    hint: "going out now",
    pulses: true,
    movable: false,
    icon: "lock",
  },
  posted: {
    label: "Posted",
    hint: "locked",
    pulses: false,
    movable: false,
    icon: "lock",
  },
  failed: {
    label: "Failed",
    hint: "needs attention",
    pulses: true,
    movable: false,
    icon: "alert",
  },
  reminded: {
    label: "Sent to client",
    hint: "they post it by hand",
    pulses: false,
    movable: false,
    icon: "lock",
  },
};

/** The one drag rule. Every caller routes through this. */
export function canMove(status: PostStatus): boolean {
  return POST_STATUS[status].movable;
}
