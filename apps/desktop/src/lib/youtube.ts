import type { MediaAssetInfo } from "./api";

/** YouTube's stable category ids; Autos first because that is the clientele. */
export const YT_CATEGORIES: Array<[string, string]> = [
  ["2", "Autos & Vehicles"],
  ["24", "Entertainment"],
  ["22", "People & Blogs"],
  ["26", "Howto & Style"],
  ["28", "Science & Technology"],
  ["27", "Education"],
  ["17", "Sports"],
  ["23", "Comedy"],
  ["10", "Music"],
  ["20", "Gaming"],
  ["19", "Travel & Events"],
  ["25", "News & Politics"],
  ["15", "Pets & Animals"],
  ["1", "Film & Animation"],
];

/**
 * The languages offered for a video's spoken language, BCP-47 tagged.
 *
 * A curated list rather than YouTube's full i18nLanguages call: that endpoint
 * needs a live request per open of the wizard for a list that never changes,
 * and this clientele speaks a handful of these. Add a line the day a client
 * needs one that is missing.
 */
export const YT_LANGUAGES: Array<[string, string]> = [
  ["en", "English"],
  ["es", "Spanish"],
  ["es-419", "Spanish (Latin America)"],
  ["pt", "Portuguese"],
  ["fr", "French"],
  ["de", "German"],
  ["it", "Italian"],
  ["nl", "Dutch"],
  ["pl", "Polish"],
  ["ru", "Russian"],
  ["uk", "Ukrainian"],
  ["ar", "Arabic"],
  ["hi", "Hindi"],
  ["id", "Indonesian"],
  ["fil", "Filipino"],
  ["vi", "Vietnamese"],
  ["th", "Thai"],
  ["ja", "Japanese"],
  ["ko", "Korean"],
  ["zh-Hans", "Chinese (Simplified)"],
  ["zh-Hant", "Chinese (Traditional)"],
  ["tr", "Turkish"],
  ["he", "Hebrew"],
  ["sv", "Swedish"],
];

/**
 * Whether this video is a horizontal, long-form YouTube upload.
 *
 * Judged by shape, not length: a two-minute 16:9 video belongs to the
 * long-form uploader while a four-minute vertical does not, whatever the
 * duration classifier says. Width strictly greater than height covers every
 * ratio on the wish list (16:9, 4:3, 1.85:1, 2:1, 2.35:1) without keeping a
 * list that a 21:9 export would fall through. Assets probed before dimensions
 * were recorded fall back to the duration-based format.
 */
export function isHorizontal(asset: Pick<MediaAssetInfo, "width" | "height" | "format" | "kind">): boolean {
  if (asset.kind === "carousel") return false;
  if (asset.width != null && asset.height != null && asset.width > 0 && asset.height > 0) {
    return asset.width > asset.height;
  }
  return asset.format === "long_form";
}

/**
 * The conventional name for a frame's shape, e.g. "16:9", or "1234x567" when
 * it is none of the named ones. Cosmetic: the Checks phase says what the file
 * is rather than making the operator do the division.
 */
export function ratioLabel(width: number, height: number): string {
  if (width <= 0 || height <= 0) return "unknown";
  const r = width / height;
  const named: Array<[number, string]> = [
    [16 / 9, "16:9"],
    [4 / 3, "4:3"],
    [1.85, "1.85:1"],
    [2, "2:1"],
    /*
     * No 21:9 entry on purpose: 21/9 is 2.333 and sits inside 2.35:1's
     * tolerance band, so the two can never both be reachable and the wish
     * list names 2.35:1. An ultrawide export reads as the scope ratio it is.
     */
    [2.35, "2.35:1"],
  ];
  for (const [value, label] of named) {
    if (Math.abs(r - value) < 0.03) return label;
  }
  return `${width}x${height}`;
}

/**
 * YouTube's ad-suitability self-certification questions, keyed for storage.
 *
 * The wording tracks Studio's questionnaire because the whole point is that
 * an operator can carry their answers across without re-reading anything.
 * There is no API to submit the rating; see buildStudioTasks below for where
 * the answers end up.
 */
export const AD_SUITABILITY: Array<{ key: string; title: string; detail: string }> = [
  { key: "language", title: "Inappropriate language", detail: "Profanity in the video, title or thumbnail" },
  { key: "adult", title: "Adult content", detail: "Sexual behavior, language or expressions, real or computer-generated" },
  { key: "violence", title: "Violence", detail: "Situations showing hurt, damage or injury" },
  { key: "shocking", title: "Shocking content", detail: "Situations that may upset, disgust or shock a viewer" },
  { key: "harmful", title: "Harmful or dangerous acts", detail: "Acts that may endanger participants or viewers" },
  { key: "claims", title: "Unreliable claims", detail: "Content contradicting well-established expert consensus" },
  { key: "drugs", title: "Recreational drugs and drug-related content", detail: "Use, handling or promotion of recreational drugs" },
  { key: "dishonesty", title: "Enabling dishonest behavior", detail: "Content glorifying or teaching deception" },
  { key: "hateful", title: "Hateful or derogatory content", detail: "Hate, discrimination, disparagement or harassment" },
  { key: "firearms", title: "Firearms-related content", detail: "Showing or discussing real or fake guns" },
  { key: "sensitive", title: "Sensitive events", detail: "War, death, tragedy or their immediate aftermath" },
  { key: "controversial", title: "Sensitive or controversial issues", detail: "Topics that could be traumatic to the viewer" },
];

/** The comment controls Studio offers, with YouTube's own defaults first. */
export interface CommentChoices {
  state: "on" | "off" | "paused";
  moderation: "basic" | "none" | "strict" | "holdAll";
  who: "anyone" | "subscribers";
  sort: "top" | "newest";
}
export const COMMENT_DEFAULTS: CommentChoices = {
  state: "on",
  moderation: "basic",
  who: "anyone",
  sort: "top",
};

export interface StudioChoiceInput {
  membersOnly: boolean;
  selfCert: { rating: "safe" | "limited"; flags: string[] } | null;
  comments: CommentChoices;
  autoChapters: boolean;
  featuredPlaces: boolean;
  autoConcepts: boolean;
  fundraiserUrl: string;
  collaborator: string;
}

/**
 * Compile the wizard's Studio-only choices into the finish-in-Studio list.
 *
 * One rule: only deviations from YouTube's own defaults become tasks. The
 * defaults happen on their own when nobody touches Studio, so listing them
 * would bury the three lines that need a human under ten that do not, and a
 * checklist nobody reads is a checklist that does not exist.
 */
export function buildStudioTasks(input: StudioChoiceInput): string[] {
  const tasks: string[] = [];
  if (input.membersOnly) {
    tasks.push(
      "Make this video members-only. The API can only publish public, unlisted or private, so it went up private.",
    );
  }
  if (input.selfCert) {
    const flagged = input.selfCert.flags
      .map((k) => AD_SUITABILITY.find((q) => q.key === k)?.title ?? k)
      .join(", ");
    tasks.push(
      input.selfCert.rating === "safe"
        ? "If the channel is monetized, submit the ad-suitability rating in Studio: none of the categories apply."
        : `If the channel is monetized, submit the ad-suitability rating in Studio and flag: ${flagged}.`,
    );
  }
  const c = input.comments;
  if (c.state !== "on") {
    tasks.push(c.state === "off" ? "Turn comments off." : "Pause comments.");
  }
  if (c.state !== "off") {
    if (c.moderation !== "basic") {
      const label =
        c.moderation === "none"
          ? "None (don't hold any)"
          : c.moderation === "strict"
            ? "Strict (hold a broader range)"
            : "Hold all";
      tasks.push(`Set comment moderation to ${label}.`);
    }
    if (c.who !== "anyone") tasks.push("Limit commenting to subscribers and members.");
    if (c.sort !== "top") tasks.push("Sort comments by newest first.");
  }
  if (!input.autoChapters) tasks.push("Turn off automatic chapters.");
  if (!input.featuredPlaces) tasks.push("Turn off featured places.");
  if (!input.autoConcepts) tasks.push("Turn off automatic concepts.");
  if (input.fundraiserUrl.trim()) {
    tasks.push(`Attach the fundraiser (YouTube Giving has no API): ${input.fundraiserUrl.trim()}`);
  }
  if (input.collaborator.trim()) {
    tasks.push(`Invite ${input.collaborator.trim()} as a collaborator.`);
  }
  return tasks;
}
