/**
 * The context the Ideas Brainstorm button writes from: the niche typed in the
 * Ideas section and the creators that inspire it. Kept per brand in
 * localStorage, the same way the caption step keeps custom templates.
 */

export interface IdeaContext {
  niche: string;
  creators: string[];
}

export const CREATOR_CAP = 12;
export const NICHE_CAP = 200;

export function contextKey(clientId: string): string {
  return `tf.ideas.context.${clientId}`;
}

/** One creator entry, tidied: trimmed, a leading @ kept but doubled ones dropped. */
export function cleanCreator(raw: string): string {
  const t = raw.trim().replace(/^@+/, "@").replace(/\s+/g, " ");
  return t.slice(0, 60);
}

/** Adds typed text (commas split it into several) without duplicates, case-insensitively. */
export function addCreators(list: string[], typed: string): string[] {
  const out = [...list];
  for (const part of typed.split(",")) {
    const c = cleanCreator(part);
    if (!c || c === "@") continue;
    if (out.some((v) => v.toLowerCase() === c.toLowerCase())) continue;
    if (out.length >= CREATOR_CAP) break;
    out.push(c);
  }
  return out;
}

export function parseContext(raw: string | null): IdeaContext {
  try {
    const v = JSON.parse(raw ?? "") as Partial<IdeaContext>;
    return {
      niche: typeof v.niche === "string" ? v.niche.slice(0, NICHE_CAP) : "",
      creators: Array.isArray(v.creators)
        ? addCreators([], v.creators.filter((c) => typeof c === "string").join(","))
        : [],
    };
  } catch {
    return { niche: "", creators: [] };
  }
}

export function loadContext(clientId: string): IdeaContext {
  try {
    return parseContext(localStorage.getItem(contextKey(clientId)));
  } catch {
    return { niche: "", creators: [] };
  }
}

export function saveContext(clientId: string, ctx: IdeaContext): void {
  try {
    localStorage.setItem(contextKey(clientId), JSON.stringify(ctx));
  } catch {
    /* storage full or blocked: the inputs still work for this session */
  }
}

/** Index after a step through the saved list, clamped rather than wrapped. */
export function stepIndex(index: number, delta: number, length: number): number {
  if (length <= 0) return 0;
  return Math.min(length - 1, Math.max(0, index + delta));
}
