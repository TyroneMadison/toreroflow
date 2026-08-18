/**
 * ToreIQ: scoring a long-form upload's packaging before it publishes.
 *
 * VidIQ has no public API, so this is not a wrapper; it is our own engine,
 * and that constraint became the design. Everything here is scored from two
 * sources an agency can actually defend to a client: search behavior YouTube
 * itself documents (what truncates, what the algorithm reads first, what a
 * custom thumbnail does to click-through), and the channel's own catalogue,
 * which is the only ground truth about what THIS audience clicks.
 *
 * The honesty rule that shapes the math: a signal that cannot be measured for
 * this channel is excluded from the score entirely rather than awarded or
 * docked. A channel with no history yet is scored out of what is knowable,
 * and the total is normalized so 100 always means "everything measurable is
 * right", never "we assumed the rest".
 */

export interface ToreIqInput {
  title: string;
  description: string;
  tags: string[];
  /** A picked frame or an uploaded image; auto-thumbnails score zero. */
  hasCustomThumbnail: boolean;
  categorySet: boolean;
  languageSet: boolean;
  playlistSet: boolean;
  /** Local hour (0-23) the upload is scheduled for, or null while unset. */
  scheduledHour: number | null;
  /** The channel's best posting hours, newest history first. Empty when unknown. */
  bestHours: number[];
  /** Vocabulary of the channel's top-performing titles. Empty when unknown. */
  channelTopWords: string[];
}

export interface ToreIqFinding {
  ok: boolean;
  text: string;
}

export interface ToreIqSection {
  key: "title" | "description" | "tags" | "thumbnail" | "packaging";
  label: string;
  /** Points earned and the measurable ceiling for this section. */
  score: number;
  max: number;
  findings: ToreIqFinding[];
}

export interface ToreIqReport {
  /** 0-100, normalized over what was measurable. */
  total: number;
  grade: "red" | "amber" | "green";
  sections: ToreIqSection[];
}

/** Words that carry no meaning for ranking a title's vocabulary. */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "in", "on", "at", "to", "for",
  "with", "this", "that", "these", "is", "are", "was", "be", "it", "its",
  "you", "your", "my", "our", "we", "i", "me", "how", "what", "why", "when",
  "vs", "not", "no", "do", "did", "does", "so", "as", "by", "from", "into",
]);

/** Meaningful lowercase words of a text, stopwords and short tokens dropped. */
export function keywords(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
}

/**
 * The vocabulary of a channel's best titles: what the top quarter of the
 * catalogue by views actually says. This is the part of the score no
 * competitor tool has, because it is built from this channel's own history
 * rather than a global model of everyone's.
 */
export function channelTopWords(
  posts: ReadonlyArray<{ title: string; views: number }>,
  limit = 8,
): string[] {
  if (posts.length < 8) return [];
  const sorted = [...posts].sort((a, b) => b.views - a.views);
  const top = sorted.slice(0, Math.max(4, Math.floor(sorted.length / 4)));
  const counts = new Map<string, number>();
  for (const p of top) {
    // A word counts once per title, or one video called "Corvette Corvette
    // Corvette" would own the list.
    for (const w of new Set(keywords(p.title))) {
      counts.set(w, (counts.get(w) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([w]) => w);
}

/**
 * The channel's strongest posting hours by average views, for the timing
 * finding. Minimum sample per hour so one lucky 4am video does not become
 * advice.
 */
export function bestHoursFor(
  posts: ReadonlyArray<{ publishedAt: string; views: number }>,
  take = 3,
): number[] {
  const byHour = new Map<number, { total: number; n: number }>();
  for (const p of posts) {
    if (p.views <= 0) continue;
    const h = new Date(p.publishedAt).getHours();
    const cur = byHour.get(h) ?? { total: 0, n: 0 };
    cur.total += p.views;
    cur.n += 1;
    byHour.set(h, cur);
  }
  return [...byHour.entries()]
    .filter(([, v]) => v.n >= 3)
    .sort((a, b) => b[1].total / b[1].n - a[1].total / a[1].n)
    .slice(0, take)
    .map(([h]) => h);
}

/** One scored candidate tag. */
export interface TagIdea {
  tag: string;
  /** 0-100, colored like the sections: what adding it is worth. */
  score: number;
}

/**
 * Candidate tags from the words already doing work: the title's own phrases
 * first (search matches titles against tags), then the channel's proven
 * vocabulary. Nothing generative; every suggestion is traceable to a source
 * the operator can see.
 */
export function suggestTags(
  title: string,
  description: string,
  topWords: readonly string[],
  existing: readonly string[],
  limit = 10,
): TagIdea[] {
  const have = new Set(existing.map((t) => t.toLowerCase()));
  const titleWords = keywords(title);
  const descWords = new Set(keywords(description));
  const ideas = new Map<string, number>();

  // Adjacent title words as phrases: "pen sale" beats "pen" and "sale".
  for (let i = 0; i < titleWords.length - 1; i++) {
    const phrase = `${titleWords[i]} ${titleWords[i + 1]}`;
    ideas.set(phrase, 78 + (descWords.has(titleWords[i]!) ? 6 : 0));
  }
  for (const w of titleWords) {
    if (!ideas.has(w)) ideas.set(w, 62 + (descWords.has(w) ? 8 : 0));
  }
  for (const w of topWords) {
    // Proven channel vocabulary scores highest of all single words.
    ideas.set(w, Math.max(ideas.get(w) ?? 0, 84));
  }
  return [...ideas.entries()]
    .filter(([tag]) => !have.has(tag))
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([tag, score]) => ({ tag, score: Math.min(100, score) }));
}

/** Grade thresholds, VidIQ's colors because operators already read them. */
function gradeOf(total: number): "red" | "amber" | "green" {
  return total >= 80 ? "green" : total >= 50 ? "amber" : "red";
}

/** A section's 0-100 form for the per-field badge. */
export function sectionBadge(section: ToreIqSection): number {
  return section.max === 0 ? 0 : Math.round((section.score / section.max) * 100);
}

export function scoreUpload(input: ToreIqInput): ToreIqReport {
  const sections: ToreIqSection[] = [];

  // ---- Title (30 measurable points) ----
  {
    const findings: ToreIqFinding[] = [];
    let score = 0;
    let max = 0;
    const title = input.title.trim();
    const len = title.length;

    max += 8;
    if (len >= 20 && len <= 60) {
      score += 8;
      findings.push({ ok: true, text: `Title length ${len} sits in the 20-60 band search shows in full.` });
    } else if (len > 60 && len <= 70) {
      score += 4;
      findings.push({ ok: false, text: `Title is ${len} characters; search truncates around 60.` });
    } else {
      findings.push({
        ok: false,
        text: len < 20 ? "The title is too short to carry a search phrase." : `At ${len} characters the title truncates everywhere.`,
      });
    }

    max += 5;
    /*
     * The first word that carries letters, digits skipped: "3 Corvette
     * Mistakes" front-loads Corvette, and the leading number is a hook this
     * scorer rewards separately, not a filler to punish here.
     */
    const firstWord = title
      .split(/\s+/)
      .find((w) => /[a-zA-Z]/.test(w))
      ?.toLowerCase()
      .replace(/[^a-z0-9']/g, "");
    const startsWithKeyword = firstWord !== undefined && !STOPWORDS.has(firstWord) && firstWord.length >= 3;
    if (startsWithKeyword) {
      score += 5;
      findings.push({ ok: true, text: "The title front-loads a real keyword." });
    } else {
      findings.push({ ok: false, text: "Open with the subject, not a filler word: search reads left to right." });
    }

    max += 5;
    if (/\d/.test(title) || /[[(].+[\])]/.test(title)) {
      score += 5;
      findings.push({ ok: true, text: "A number or bracketed hook; both lift click-through." });
    } else {
      findings.push({ ok: false, text: "No number or bracketed hook. \"3 mistakes\" outclicks \"mistakes\"." });
    }

    max += 4;
    const letters = title.replace(/[^a-zA-Z]/g, "");
    const capsRatio = letters.length ? letters.replace(/[^A-Z]/g, "").length / letters.length : 0;
    const bangs = (title.match(/!/g) ?? []).length;
    if (capsRatio <= 0.5 && bangs <= 1) {
      score += 4;
      findings.push({ ok: true, text: "Not shouting: mixed case, restrained punctuation." });
    } else {
      findings.push({ ok: false, text: "All-caps and stacked punctuation read as spam to viewers and filters." });
    }

    if (input.channelTopWords.length) {
      max += 8;
      const words = new Set(keywords(title));
      const hits = input.channelTopWords.filter((w) => words.has(w));
      if (hits.length) {
        score += 8;
        findings.push({ ok: true, text: `Uses this channel's proven words: ${hits.join(", ")}.` });
      } else {
        findings.push({
          ok: false,
          text: `None of the channel's top-video words appear. Its winners say: ${input.channelTopWords.slice(0, 5).join(", ")}.`,
        });
      }
    }

    sections.push({ key: "title", label: "Title", score, max, findings });
  }

  // ---- Description (25) ----
  {
    const findings: ToreIqFinding[] = [];
    let score = 0;
    let max = 0;
    const desc = input.description;

    max += 6;
    if (desc.trim().length >= 200) {
      score += 6;
      findings.push({ ok: true, text: "Long enough for search to read." });
    } else {
      findings.push({ ok: false, text: `${desc.trim().length} characters of description; give search at least 200 to work with.` });
    }

    max += 7;
    const fold = desc.slice(0, 150).toLowerCase();
    const titleKeys = keywords(input.title);
    const foldHits = titleKeys.filter((w) => fold.includes(w));
    if (titleKeys.length && foldHits.length >= Math.min(2, titleKeys.length)) {
      score += 7;
      findings.push({ ok: true, text: "The first two lines repeat the title's keywords, where search weighs them most." });
    } else {
      findings.push({ ok: false, text: "Put the title's keywords in the first 150 characters; that is what search and viewers see above the fold." });
    }

    max += 5;
    if (/(^|\n)\s*0?0:00/.test(desc)) {
      score += 5;
      findings.push({ ok: true, text: "Timestamps present, starting at 0:00; chapters will build from these." });
    } else {
      findings.push({ ok: false, text: "No timestamps. A chapter list starting at 0:00 adds chapters and search entries." });
    }

    max += 4;
    if (/https?:\/\//.test(desc)) {
      score += 4;
      findings.push({ ok: true, text: "Carries a link out." });
    } else {
      findings.push({ ok: false, text: "No link. The description is the one place every viewer can click out from." });
    }

    max += 3;
    const hashtags = (desc.match(/#[\w]+/g) ?? []).length;
    if (hashtags >= 1 && hashtags <= 3) {
      score += 3;
      findings.push({ ok: true, text: `${hashtags} hashtag${hashtags === 1 ? "" : "s"}; YouTube shows the first three.` });
    } else if (hashtags === 0) {
      findings.push({ ok: false, text: "No hashtags; up to three show above the title." });
    } else {
      findings.push({ ok: false, text: `${hashtags} hashtags; past three, YouTube ignores them all.` });
    }

    sections.push({ key: "description", label: "Description", score, max, findings });
  }

  // ---- Tags (20) ----
  {
    const findings: ToreIqFinding[] = [];
    let score = 0;
    let max = 0;
    const pool = input.tags.join(",").length;

    max += 4;
    if (input.tags.length > 0) {
      score += 4;
      findings.push({ ok: true, text: "Tags present. Light ranking weight, but they still catch misspellings and variants." });
    } else {
      findings.push({ ok: false, text: "No tags. Their weight is small; their cost is zero." });
    }

    max += 6;
    if (input.tags.length >= 5 && input.tags.length <= 15) {
      score += 6;
      findings.push({ ok: true, text: `${input.tags.length} tags, inside the 5-15 band.` });
    } else if (input.tags.length > 0) {
      findings.push({
        ok: false,
        text: input.tags.length < 5 ? "Fewer than 5 tags; add variants and phrases." : `${input.tags.length} tags dilute each other; trim toward 15.`,
      });
    } else {
      findings.push({ ok: false, text: "Tag count scores once tags exist." });
    }

    max += 4;
    if (pool >= 100 && pool <= 400) {
      score += 4;
      findings.push({ ok: true, text: `${pool} of 500 pool characters used, in the healthy band.` });
    } else if (pool > 0) {
      findings.push({ ok: false, text: pool < 100 ? "The tag pool is mostly unused." : `${pool} of 500 pool characters; the last few tags add noise, not reach.` });
    } else {
      findings.push({ ok: false, text: "Pool usage scores once tags exist." });
    }

    max += 6;
    const titleKeys = new Set(keywords(input.title));
    const tagWords = new Set(input.tags.flatMap((t) => keywords(t)));
    const overlap = [...titleKeys].filter((w) => tagWords.has(w));
    if (titleKeys.size && overlap.length >= Math.min(2, titleKeys.size)) {
      score += 6;
      findings.push({ ok: true, text: "The title's keywords appear in the tags, which is the pairing search matches." });
    } else {
      findings.push({ ok: false, text: "The tags and the title do not share keywords; they should tell one story." });
    }

    sections.push({ key: "tags", label: "Tags", score, max, findings });
  }

  // ---- Thumbnail (10) ----
  {
    const findings: ToreIqFinding[] = [];
    let score = 0;
    const max = 10;
    if (input.hasCustomThumbnail) {
      score = 10;
      findings.push({ ok: true, text: "Custom thumbnail chosen. The single biggest click-through lever there is." });
    } else {
      findings.push({ ok: false, text: "No thumbnail chosen: YouTube will pick a frame, and auto-frames underperform custom thumbnails badly." });
    }
    sections.push({ key: "thumbnail", label: "Thumbnail", score, max, findings });
  }

  // ---- Packaging and timing (15 measurable) ----
  {
    const findings: ToreIqFinding[] = [];
    let score = 0;
    let max = 0;

    max += 3;
    if (input.categorySet) {
      score += 3;
      findings.push({ ok: true, text: "Category set." });
    } else {
      findings.push({ ok: false, text: "No category; the default buries it in People & Blogs." });
    }

    max += 3;
    if (input.languageSet) {
      score += 3;
      findings.push({ ok: true, text: "Video language set; captions and translations key off it." });
    } else {
      findings.push({ ok: false, text: "No video language set." });
    }

    max += 3;
    if (input.playlistSet) {
      score += 3;
      findings.push({ ok: true, text: "Added to a playlist, which feeds session watch time." });
    } else {
      findings.push({ ok: false, text: "Not in a playlist; playlists keep viewers on the channel." });
    }

    if (input.bestHours.length && input.scheduledHour !== null) {
      max += 6;
      if (input.bestHours.includes(input.scheduledHour)) {
        score += 6;
        findings.push({ ok: true, text: "Scheduled inside the channel's proven hours." });
      } else {
        const hours = input.bestHours
          .map((h) => `${((h + 11) % 12) + 1}${h < 12 ? "am" : "pm"}`)
          .join(", ");
        findings.push({ ok: false, text: `Scheduled outside the channel's best hours (${hours}).` });
      }
    }

    sections.push({ key: "packaging", label: "Packaging & timing", score, max, findings });
  }

  const earned = sections.reduce((s, x) => s + x.score, 0);
  const measurable = sections.reduce((s, x) => s + x.max, 0);
  const total = measurable === 0 ? 0 : Math.round((earned / measurable) * 100);
  return { total, grade: gradeOf(total), sections };
}
