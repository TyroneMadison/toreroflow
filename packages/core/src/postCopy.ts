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

/**
 * The caption body this platform receives.
 *
 * YouTube's chain ends at the title on purpose. An empty description is not
 * neutral there: handing the provider nothing means the provider decides what
 * appears, and one real upload came back reading "Video uploaded via social
 * media scheduler" on a client's channel. Repeating the title is plain and
 * ours; anything the provider writes is neither.
 */
export function captionFor(platform: string, draft: DraftCopy): string {
  if (platform === "youtube") {
    return firstOf(draft.youtubeDescription, draft.description, draft.name, draft.youtubeTitle);
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

// ---------- AI caption writer ----------
// One copy for the upload card's "Write with AI" (POST /media/:id/caption)
// and the Drive trial reels, so both write the same way.

/**
 * The shape a generated caption comes back in. Structured output rather than
 * parsing prose, so a stray sentence of preamble cannot end up in a client's
 * caption. Note the model's structured output rejects maxItems and any
 * minItems above 1, so the hashtag count is asked for in the prompt and
 * trimmed on the way out instead.
 */
export const CAPTION_SCHEMA = {
  type: "object",
  properties: {
    description: { type: "string" },
    title: { type: "string" },
    hashtags: { type: "array", items: { type: "string" } },
  },
  required: ["description", "title", "hashtags"],
  additionalProperties: false,
} as const;

export const CAPTION_SYSTEM_PROMPT =
  "You write short-form video captions for a social media agency whose clients are car " +
  "dealerships and automotive personalities. Given what is said in the video, write a " +
  "description that makes someone stop and watch, and that can be found by search.\n\n" +
  "The description is 2 to 4 sentences, posted as the caption on Instagram, TikTok, " +
  "Facebook and Snapchat and as the YouTube description. Open on the most interesting " +
  "thing in the video, not a summary of it. Name the specific cars, models, years, " +
  "prices and places that are actually mentioned, because those are the words people " +
  "search for. End with a question or a reason to comment. No hashtags inside the " +
  "description, no emoji spam, and never invent a fact that is not in the transcript.\n\n" +
  "Also give a title under 100 characters for YouTube, and 5 to 8 hashtags without the " +
  "# sign, ordered from most specific to broadest.";

export function buildCaptionUserMessage(brand: string, transcript: string): string {
  return `Brand: ${brand}\nWhat is said in the video:\n${transcript.slice(0, 6000)}`;
}

export interface WrittenCaption {
  description: string;
  title: string;
  /** Without the # sign, at most 8. */
  hashtags: string[];
}

/** The model's JSON reply as fields. Throws when the reply is not JSON. */
export function readCaptionReply(text: string): WrittenCaption {
  const parsed = JSON.parse(text) as { description?: unknown; title?: unknown; hashtags?: unknown };
  return {
    description: typeof parsed.description === "string" ? parsed.description : "",
    title: typeof parsed.title === "string" ? parsed.title : "",
    hashtags: Array.isArray(parsed.hashtags)
      ? parsed.hashtags.filter((h): h is string => typeof h === "string").slice(0, 8)
      : [],
  };
}
