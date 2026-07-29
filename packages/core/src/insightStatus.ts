/**
 * The state of a client's "what to do next" run.
 *
 * Generation happens on the worker, so three places need to agree about what
 * a status means: the route deciding whether to enqueue, the modal deciding
 * whether to keep polling, and the overview row deciding what to show. They
 * read this file rather than each spelling the strings out.
 */

export const INSIGHT_STATUSES = ["running", "ready", "failed"] as const;

export type InsightStatus = (typeof INSIGHT_STATUSES)[number];

export function isInsightStatus(value: unknown): value is InsightStatus {
  return typeof value === "string" && (INSIGHT_STATUSES as readonly string[]).includes(value);
}

/**
 * Whether a run is still going.
 *
 * The route refuses to start a second run while this is true, and the modal
 * keeps polling for exactly as long. An unknown string counts as not running,
 * so a status this build has never heard of can never wedge the button or
 * spin a poll forever.
 */
export function isRunning(status: string | null | undefined): boolean {
  return status === "running";
}

/** Whether there is a finished result worth showing. */
export function isReady(status: string | null | undefined): boolean {
  return status === "ready";
}
