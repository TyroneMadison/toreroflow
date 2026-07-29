/**
 * Rules for researching the accounts a client says they want to be like.
 *
 * Pure on purpose. Everything here decides how someone's money gets spent or
 * which stranger's account gets researched, and both are worth pinning in a
 * check rather than discovering against a live wallet.
 */

export const RESEARCH_PLATFORMS = ["instagram", "tiktok"] as const;
export type ResearchPlatform = (typeof RESEARCH_PLATFORMS)[number];

export function isResearchPlatform(value: unknown): value is ResearchPlatform {
  return typeof value === "string" && (RESEARCH_PLATFORMS as readonly string[]).includes(value);
}

/**
 * The bare handle, however the client wrote it.
 *
 * People paste profile URLs, type an @, add a trailing slash, or copy with a
 * capital letter. All of those are the same account, and treating them as
 * different ones means paying to resolve the same person twice and storing
 * two half-populated rows.
 */
export function normalizeHandle(input: string): string {
  let s = input.trim();
  if (!s) return "";
  // A pasted profile link, from either platform, with or without a protocol.
  const url = s.match(
    /(?:instagram\.com|tiktok\.com)\/+(?:@)?([^/?#\s]+)/i,
  );
  if (url) s = url[1]!;
  s = s.replace(/^@+/, "").split(/[/?#]/)[0]!;
  // TikTok shows handles with a leading @ and Instagram without; neither
  // platform's handles are case sensitive.
  return s.trim().toLowerCase();
}

/**
 * Which platform rows a form answer should become.
 *
 * "both" is two accounts, not one with two ids: a snapshot has to belong to
 * one real account on one real app, or the numbers in it mean nothing.
 * Anything unrecognised yields both, because guessing wrong in the narrow
 * direction silently researches nobody.
 */
export function platformsFor(answer: string | null | undefined): ResearchPlatform[] {
  const a = (answer ?? "").trim().toLowerCase();
  if (a === "instagram") return ["instagram"];
  if (a === "tiktok") return ["tiktok"];
  return [...RESEARCH_PLATFORMS];
}

export interface PlannedFetch {
  platform: ResearchPlatform;
  handle: string;
  /** Skip the resolve call: this account's id is already known. */
  resolved: boolean;
}

/**
 * What a run would cost, in cents, before any of it happens.
 *
 * Resolving is a separate paid call because neither posts endpoint accepts a
 * handle, so an account being already resolved genuinely halves its cost.
 * Rounded up: a ceiling that under-counts is not a ceiling.
 */
export function estimateCents(
  planned: PlannedFetch[],
  centsPerCall: number,
): number {
  const calls = planned.reduce((n, p) => n + (p.resolved ? 1 : 2), 0);
  return Math.ceil(calls * centsPerCall);
}

/**
 * As many fetches as the ceiling affords, in the order given.
 *
 * Truncates rather than failing, so a ceiling that is too low still returns
 * something useful. The caller is expected to say what it dropped: silently
 * researching three of five accounts and calling it a report is the failure
 * this whole ceiling exists to make visible.
 */
export function withinBudget(
  planned: PlannedFetch[],
  centsPerCall: number,
  maxCents: number,
): { run: PlannedFetch[]; skipped: PlannedFetch[] } {
  const run: PlannedFetch[] = [];
  let spent = 0;
  for (let i = 0; i < planned.length; i++) {
    const next = estimateCents([planned[i]!], centsPerCall);
    if (spent + next > maxCents) {
      return { run, skipped: planned.slice(i) };
    }
    spent += next;
    run.push(planned[i]!);
  }
  return { run, skipped: [] };
}

/**
 * Whether a stored snapshot is old enough to be worth paying for again.
 *
 * Defaults to a week. Short-form accounts do not change enough in a day to
 * justify spending again, and the operator can always force a refresh.
 */
export function isStale(
  fetchedAt: Date | null | undefined,
  now: Date,
  maxAgeDays = 7,
): boolean {
  if (!fetchedAt) return true;
  const age = now.getTime() - fetchedAt.getTime();
  return age >= maxAgeDays * 24 * 60 * 60 * 1000;
}
