/**
 * Turning a publish failure into something an operator can act on.
 *
 * PostTarget.error holds whatever the platform said, truncated to 500
 * characters. Some of those sentences are genuinely useful and some are
 * "Publishing failed due to max retries reached", which tells you a retry
 * happened and nothing about why. Either way the operator's real question is
 * not what went wrong, it is what to do now, and the raw string never answers
 * it: retrying a quota failure five minutes later fails five minutes later,
 * and retrying a video the platform rejected on its length fails forever.
 *
 * So every failure is classified into whether trying again can possibly work.
 * Anything unrecognised is treated as retryable, because an unknown failure is
 * more often a hiccup than a permanent refusal, and the cost of being wrong is
 * one wasted press rather than a video nobody ever posts.
 */

/** What pressing the button again can achieve. */
export type RetryOutlook =
  /** A transient failure. Trying again now is the right move. */
  | "now"
  /** A cap or a queue. The same attempt works later, and not before. */
  | "later"
  /** The platform refused the content itself. Retrying changes nothing. */
  | "never";

export interface PublishFailure {
  /** One line naming what happened, in the operator's words rather than the API's. */
  summary: string;
  /** What to do about it. Empty when the raw message already says everything. */
  advice: string;
  outlook: RetryOutlook;
  /**
   * True when this is TikTok's app-level daily cap rather than anything about
   * the video, which is the one failure with a same-day route around it.
   */
  tiktokDailyCap: boolean;
}

/** Case-insensitive contains, so provider copy edits do not change the answer. */
function has(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/**
 * Classify one PostTarget.error.
 *
 * Ordered most specific first: several of these overlap in wording, and the
 * quota cases have to be recognised before the generic "failed" catch.
 */
export function explainPublishFailure(raw: string | null | undefined): PublishFailure {
  const error = (raw ?? "").trim();
  if (!error) {
    return {
      summary: "The platform refused this post without saying why.",
      advice: "Try again. If it fails a second time the same way, the video itself is suspect.",
      outlook: "now",
      tiktokDailyCap: false,
    };
  }

  /*
   * TikTok's app-level cap, and the single most confusing failure in the app,
   * because nothing about it is the client's account or the video.
   *
   * TikTok caps how many separate creators may post through one API client in
   * 24 hours, sized from the usage estimate that client gave in its audit. The
   * client here is the publish provider, shared with every other agency using
   * it, so this can be reached on a day this agency posted nothing at all.
   * Nobody on our side can raise it and no plan buys past it; it resets at
   * midnight UTC.
   */
  if (has(error, "daily active user quota") || has(error, "active user cap")) {
    return {
      summary: "TikTok's daily cap for the publishing tool was reached, not yours.",
      advice:
        "TikTok limits how many creators can post through one tool per day, shared across " +
        "every agency using it, so this can happen on a day you posted nothing. It resets at " +
        "midnight UTC. Send it to the client's TikTok inbox to get it out today, or retry " +
        "after the reset.",
      outlook: "later",
      tiktokDailyCap: true,
    };
  }

  // The per-creator cap, which IS about this account: roughly 15 posts a day,
  // counted across every tool touching it, the TikTok app included.
  if (has(error, "too many posts in the last 24 hours") || has(error, "post limit")) {
    return {
      summary: "This TikTok account hit its own daily posting limit.",
      advice:
        "TikTok allows roughly 15 posts a day per account, counted across every tool including " +
        "the TikTok app itself. Retry tomorrow.",
      outlook: "later",
      tiktokDailyCap: false,
    };
  }

  if (has(error, "rate limit") || has(error, "too many requests") || has(error, "429")) {
    return {
      summary: "The platform asked us to slow down.",
      advice: "Wait a few minutes and retry. Nothing is wrong with the video.",
      outlook: "later",
      tiktokDailyCap: false,
    };
  }

  /*
   * The stall confirmPublishing catches. Instagram accepts a container and
   * then abandons it, which is not a refusal and has no error of its own, so
   * this sentence is ours rather than the platform's.
   */
  if (has(error, "never confirmed this post")) {
    return {
      summary: "The platform took the video and then never published it.",
      advice:
        "Usually the video was too long or the wrong shape for the format it was sent as. " +
        "Retrying sends it again; if it stalls twice, check the length against the format.",
      outlook: "now",
      tiktokDailyCap: false,
    };
  }

  // Content the platform will not take. Retrying is guaranteed to fail again.
  if (
    has(error, "too long") ||
    has(error, "duration") ||
    has(error, "aspect ratio") ||
    has(error, "unsupported") ||
    has(error, "invalid media") ||
    has(error, "file size")
  ) {
    return {
      summary: "The platform rejected the video itself.",
      advice: "Re-edit it to fit the format, then schedule the new file. Retrying this one cannot work.",
      outlook: "never",
      tiktokDailyCap: false,
    };
  }

  // A dead or downgraded connection. The fix is in Settings, not here.
  if (
    has(error, "token") ||
    has(error, "unauthorized") ||
    has(error, "permission") ||
    has(error, "reconnect") ||
    has(error, "expired")
  ) {
    return {
      summary: "The account's connection is no longer good enough to post.",
      advice: "Reconnect the account in Settings, then retry.",
      outlook: "never",
      tiktokDailyCap: false,
    };
  }

  if (has(error, "no contact email")) {
    return {
      summary: "This is a reminder account and the client has no email on file.",
      advice: "Add a contact email to the client, then retry.",
      outlook: "never",
      tiktokDailyCap: false,
    };
  }

  /*
   * The provider's own give-up message. It means several attempts already
   * failed and says nothing about the cause, so the honest reading is that
   * whatever the real error was is gone. Retryable, because the alternative is
   * telling an operator a post is unrecoverable on the strength of a sentence
   * that contains no information.
   */
  if (has(error, "max retries")) {
    return {
      summary: "The platform refused this repeatedly and stopped explaining why.",
      advice: "Retry once. If it fails the same way again, the video or the account is the problem.",
      outlook: "now",
      tiktokDailyCap: false,
    };
  }

  return {
    summary: "The platform refused this post.",
    advice: "Try again. If it fails a second time the same way, the video itself is suspect.",
    outlook: "now",
    tiktokDailyCap: false,
  };
}

/**
 * How many nights a quota-blocked post will wait before it gives up.
 *
 * Three. The cap belongs to the publishing tool and is shared with every other
 * agency using it, so it can stay exhausted for days; but a video that has
 * missed three nights is stale news on a client's channel, and at that point
 * silently trying a fourth time is worse than saying so.
 */
export const QUOTA_DEFERRALS_MAX = 3;

/**
 * When to try a quota-blocked TikTok post again.
 *
 * TikTok's daily cap resets at midnight UTC, so the next attempt goes just
 * after that boundary rather than at the time that failed. Two things fall out
 * of that, and the second one is luck worth keeping: it is the front of the
 * fresh pool, and for a US audience midnight UTC is about 8pm Eastern, which
 * is prime time rather than a graveyard slot.
 *
 * The offset is a few minutes past the boundary and jittered per target, for
 * two different reasons. Landing exactly on 00:00 races every other tool that
 * also knows when the reset is; and without the per-target spread, a night
 * with three deferred posts would fire all three into the same minute and
 * spend the agency's own share of the pool in one burst.
 */
export function quotaDeferralAt(now: Date, seed: string): Date {
  const next = new Date(now);
  next.setUTCHours(24, 0, 0, 0);
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  next.setUTCMinutes(4 + (hash % 22));
  return next;
}
