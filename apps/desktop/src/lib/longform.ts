import { hashtagCount, IG_CAPTION_MAX, IG_HASHTAG_MAX } from "@toreroflow/core";

/** Where a long-form upload goes. */
export const DESTS = [
  { id: "youtube", label: "YouTube" },
  { id: "instagram", label: "Instagram" },
  { id: "both", label: "Both" },
] as const;
export type Dest = (typeof DESTS)[number]["id"];

export function parseDest(v: string | null | undefined): Dest {
  return DESTS.some((d) => d.id === v) ? (v as Dest) : "youtube";
}

export const hasYouTube = (d: Dest): boolean => d !== "instagram";
export const hasInstagram = (d: Dest): boolean => d !== "youtube";

/**
 * The wizard's phases for a destination. YouTube keeps its five exactly as
 * before; Instagram alone is its own fields, the checks and the time; Both is
 * YouTube's five with Instagram's fields before the checks.
 */
export function phasesFor(dest: Dest): Array<{ id: string; label: string }> {
  const yt = hasYouTube(dest);
  return [
    ...(yt
      ? [
          { id: "details", label: "Details" },
          { id: "suitability", label: "Ad suitability" },
          { id: "elements", label: "Video elements" },
        ]
      : []),
    ...(hasInstagram(dest) ? [{ id: "instagram", label: "Instagram" }] : []),
    { id: "checks", label: "Checks" },
    { id: "visibility", label: yt ? "Visibility" : "Post time" },
  ];
}

/** "@a, b  c" -> ["a", "b", "c"]: usernames however they were typed. */
export function parseHandles(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((h) => h.trim().replace(/^@/, ""))
    .filter(Boolean);
}

export interface IgFitInfo {
  bytes: number | null;
  blocks: string[];
  warnings: string[];
  needsCopy: boolean;
  is916: boolean;
  limit: { used: number; total: number } | null;
}

export type CheckRow = { ok: boolean | null; text: string };

/** What the Checks phase says about the Instagram half. */
export function instagramRows(input: {
  handle: string | null;
  caption: string;
  collaborators: string[];
  locationId: string;
  fit: IgFitInfo | null;
  cover: "frame" | "image" | "igframe" | "auto";
}): CheckRow[] {
  const rows: CheckRow[] = [];
  rows.push(
    input.handle
      ? { ok: true, text: `Instagram: @${input.handle}, as a reel up to 15 minutes.` }
      : { ok: false, text: "No Instagram account is connected for this client. Connect one in Settings." },
  );
  const tags = hashtagCount(input.caption);
  rows.push(
    input.caption.length > IG_CAPTION_MAX
      ? { ok: false, text: `The caption is ${input.caption.length} characters; Instagram stops at 2,200.` }
      : tags > IG_HASHTAG_MAX
        ? { ok: false, text: `${tags} hashtags; Instagram allows 30.` }
        : { ok: true, text: `Caption: ${input.caption.length}/2,200 characters, ${tags}/30 hashtags.` },
  );
  if (input.collaborators.length > 3) {
    rows.push({ ok: false, text: `${input.collaborators.length} collaborators; Instagram allows 3.` });
  }
  if (input.locationId && !/^\d+$/.test(input.locationId)) {
    rows.push({ ok: false, text: "Location must be the numeric id of a Facebook place page." });
  }
  if (input.fit === null) {
    rows.push({ ok: null, text: "Checking the file against Instagram's limits…" });
  } else {
    for (const b of input.fit.blocks) rows.push({ ok: false, text: b });
    for (const w of input.fit.warnings) rows.push({ ok: null, text: w });
    if (!input.fit.blocks.length && !input.fit.warnings.length) {
      rows.push({ ok: true, text: "Fits Instagram: 3 s to 15 min, under 300 MB." });
    }
    const l = input.fit.limit;
    if (l && l.total > 0) {
      const left = l.total - l.used;
      rows.push(
        left <= 0
          ? { ok: false, text: `This account has used all ${l.total} of its Instagram API posts for the last 24 hours.` }
          : left <= 5
            ? { ok: null, text: `Only ${left} of ${l.total} Instagram API posts left in the last 24 hours. Tell Nova before posting more.` }
            : { ok: true, text: `${l.used} of ${l.total} Instagram API posts used in the last 24 hours.` },
      );
    }
  }
  rows.push({
    ok: true,
    text:
      input.cover === "igframe"
        ? "Instagram cover: its own frame of the video."
        : input.cover === "frame"
          ? "Instagram cover: the picked frame."
          : input.cover === "image"
            ? "Instagram cover: the uploaded image."
            : "Instagram cover: the first frame (none picked).",
  });
  return rows;
}

export function fmtBytes(n: number | null): string {
  if (n == null) return "";
  return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`;
}

/** m:ss for a duration chip. */
export function fmtClock(sec: number | null): string {
  if (sec == null) return "";
  const s = Math.round(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
