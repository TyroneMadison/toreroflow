/**
 * What each platform actually receives.
 *
 * YouTube is the odd one out: it takes a title and a description, while
 * Instagram, TikTok, Facebook and Snapchat take a caption only. One
 * Description field serves as that caption, so the operator writes the
 * words once and YouTube's own two fields override them when filled.
 *
 * Every rule lives here. The schedule route asks this and never decides
 * for itself, so what posts can never drift from what is documented.
 */

export interface DraftCopy {
  /** The video's label in the app, and the fallback for everything else. */
  name?: string;
  /** The caption on Instagram, TikTok, Facebook and Snapchat. */
  description?: string;
  youtubeTitle?: string;
  youtubeDescription?: string;
  hashtags?: string[];
}

/** Trimmed value, or "" for missing and whitespace-only fields. */
function text(value: string | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The first field with something in it. */
function firstOf(...values: Array<string | undefined>): string {
  for (const v of values) {
    const t = text(v);
    if (t) return t;
  }
  return "";
}

/** The caption body this platform receives. */
export function captionFor(platform: string, draft: DraftCopy): string {
  if (platform === "youtube") {
    return firstOf(draft.youtubeDescription, draft.description, draft.name);
  }
  return firstOf(draft.description, draft.name);
}

/**
 * YouTube's title. An empty result means send no title at all: Zernio then
 * names the upload from the first line of the content, which beats posting
 * a title the operator never wrote.
 */
export function youtubeTitleFor(draft: DraftCopy): string {
  return firstOf(draft.youtubeTitle, draft.name);
}
