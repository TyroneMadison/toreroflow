import { createHash } from "node:crypto";
import Anthropic from "@anthropic-ai/sdk";
import {
  cleanCreatorLinks,
  parseCreatorLink,
  normalizeCompetitorPosts,
  cleanHookClassification,
  keepNicheFit,
  unseenVideos,
  topPerformers,
  hookFromCaption,
  normalizeHookText,
  inspirationPrompt,
  sampleInspiration,
  toPlainText,
  DEFAULT_HOOK_NICHE,
  FUNNEL_STAGES,
  VIDEO_FORMATS,
  type HookStats,
  type HookSourceType,
  type OwnPost,
} from "@toreroflow/core";
import { getPrisma, Prisma } from "@toreroflow/db";
import { env } from "../env";

/**
 * The hook miner (v0.3.34). Runs only when the operator presses Brainstorm,
 * Generate or Super generate: never on a timer, never on adding a creator.
 * Three sources, each failing on its own without stopping the others:
 *
 * OWN: our posts that beat their account's median by OWN_LIFT_MIN.
 * WEB: Anthropic's server-side web search, at most once a day per brand.
 * CREATOR: unseen videos from the brand's creator links and inspiration
 * accounts, kept only when they fit the niche, reworded into it.
 *
 * Every video looked at is marked seen whether it was kept or not, so nothing
 * is classified (paid for) twice.
 */

const prisma = getPrisma();

/** How long a generate press waits for mining before it goes ahead without it. */
export const MINE_BUDGET_MS = 20_000;
/** Most creator videos classified per press. */
const CREATOR_VIDEOS_PER_RUN = 24;
const BATCH = 12;
const YT_PER_CHANNEL = 15;

type Log = { warn: (obj: object, msg: string) => void; info?: (obj: object, msg: string) => void };

export interface MineResult {
  own: number;
  web: number;
  creator: number;
  /** ok | skipped (already ran today) | off (no key) | failed: reason */
  webStatus: string;
}

interface Candidate {
  text: string;
  context?: string;
  videoId: string;
  platform: string;
  url?: string | null;
  account?: string | null;
  stats?: HookStats;
}

const hash = (text: string) => createHash("sha1").update(normalizeHookText(text)).digest("hex");

const CLASSIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["items"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["i", "hook", "format", "funnelStage", "nicheScore", "reworded"],
        properties: {
          i: { type: "integer" },
          hook: { type: "string" },
          format: { type: "string", enum: [...VIDEO_FORMATS] },
          funnelStage: { type: "string", enum: [...FUNNEL_STAGES] },
          nicheScore: { type: "number" },
          reworded: { type: "string" },
        },
      },
    },
  },
} as const;

function textOf(response: { content: Array<{ type: string }> }): string {
  return response.content
    .filter((c) => c.type === "text")
    .map((c) => ("text" in c ? String(c.text) : ""))
    .join("\n");
}

/**
 * One batched model call: for each item, the hook as spoken, its format, stage,
 * niche score and a reword into the niche that keeps the sentence structure.
 */
async function classify(anthropic: Anthropic, niche: string, items: Candidate[], reword: boolean) {
  const response = await anthropic.messages.create({
    model: env.SUGGESTIONS_MODEL,
    max_tokens: 400 + items.length * 160,
    output_config: { effort: "low", format: { type: "json_schema", schema: CLASSIFY_SCHEMA } },
    system:
      "You sort short form video hooks for a hook library. For each numbered item return: i (its number); " +
      "hook, the opening line as it would be said in the first seconds, six to fifteen words, taken from the " +
      "item (do not invent a new one); format, the one listed video format it is filmed in; funnelStage, top, " +
      `middle or bottom; nicheScore, 0 to 1, how relevant the hook is to this niche: "${niche}"; ` +
      (reword
        ? "reworded, the hook rewritten for that niche keeping the original sentence structure and rhythm. "
        : "reworded, an empty string. ") +
      "Plain words, no hashtags, no emoji, never an em dash, en dash or arrow.",
    messages: [{
      role: "user",
      content: items.map((c, i) => `${i}. ${c.text}${c.context ? `\n   (${c.context})` : ""}`).join("\n"),
    }],
  } as Anthropic.MessageCreateParamsNonStreaming);
  const raw = JSON.parse(textOf(response) || "{}") as { items?: Array<Record<string, unknown>> };
  return (raw.items ?? []).flatMap((r) => {
    const c = items[Number(r.i)];
    if (!c) return [];
    const hook = toPlainText(String(r.hook ?? "")).replace(/\s+/g, " ").trim().slice(0, 300) || toPlainText(c.text);
    const cls = cleanHookClassification(r, hook);
    return [{ c, hook, ...cls, reworded: cls.reworded ? toPlainText(cls.reworded) : null }];
  });
}

async function save(clientId: string, source: HookSourceType, rows: Awaited<ReturnType<typeof classify>>) {
  if (!rows.length) return 0;
  const { count } = await prisma.hook.createMany({
    data: rows.map((r) => ({
      clientId,
      text: r.hook,
      reworded: source === "OWN" ? null : r.reworded,
      sourceType: source,
      sourceUrl: r.c.url ?? null,
      sourceAccount: r.c.account ?? null,
      sourceVideoId: source === "WEB" ? null : r.c.videoId,
      format: r.format,
      funnelStage: r.funnelStage,
      nicheScore: r.nicheScore,
      stats: (r.c.stats as Prisma.InputJsonValue | undefined) ?? Prisma.DbNull,
      textHash: hash(r.hook),
    })),
    skipDuplicates: true,
  });
  return count;
}

async function markSeen(clientId: string, items: Array<{ platform: string; videoId: string }>) {
  if (!items.length) return;
  await prisma.hookSeenVideo.createMany({
    data: items.map((v) => ({ clientId, platform: v.platform, videoId: v.videoId.slice(0, 300) })),
    skipDuplicates: true,
  });
}

async function seenIds(clientId: string, platforms: string[]) {
  const rows = await prisma.hookSeenVideo.findMany({
    where: { clientId, platform: { in: platforms } },
    select: { platform: true, videoId: true },
  });
  return rows.map((r) => `${r.platform}:${r.videoId}`);
}

/** Candidates not seen before, keyed by platform and video id, at most `cap`. */
function freshOf(cands: Candidate[], seen: string[], cap: number): Candidate[] {
  return unseenVideos(cands.map((c) => ({ c, videoId: `${c.platform}:${c.videoId.slice(0, 300)}` })), seen, cap).map((x) => x.c);
}

/* ---- OWN ---- */

async function ownCandidates(clientId: string): Promise<Candidate[]> {
  const targets = await prisma.postTarget.findMany({
    where: { post: { clientId, deletedAt: null }, status: "posted" },
    select: {
      id: true, remotePostId: true, remoteUrl: true, caption: true, socialAccountId: true,
      post: { select: { idea: { select: { hook: true } } } },
      postMetrics: { orderBy: { capturedAt: "desc" }, take: 1 },
    },
    take: 300,
    orderBy: { publishedAt: "desc" },
  });
  const ideaHook = new Map<string, string>();
  for (const t of targets) if (t.remotePostId && t.post.idea?.hook) ideaHook.set(t.remotePostId, t.post.idea.hook);

  const videos = await prisma.externalVideo.findMany({
    where: { socialAccount: { clientId, deletedAt: null }, mediaType: "video" },
    select: { id: true, platformVideoId: true, socialAccountId: true, title: true, url: true, views: true, likes: true, comments: true, shares: true, saves: true },
    orderBy: { publishedAt: "desc" },
    take: 300,
  });
  const posts: Array<OwnPost & { platformKey: string }> = videos.map((v) => ({
    videoId: v.platformVideoId, platformKey: v.platformVideoId, account: v.socialAccountId,
    hook: ideaHook.get(v.platformVideoId) ?? hookFromCaption(v.title),
    views: v.views, likes: v.likes, comments: v.comments, shares: v.shares, saves: v.saves, url: v.url,
  }));
  const have = new Set(posts.map((p) => p.videoId));
  for (const t of targets) {
    const m = t.postMetrics[0];
    const key = t.remotePostId ?? t.id;
    if (!m || have.has(key)) continue;
    posts.push({
      videoId: key, platformKey: key, account: t.socialAccountId,
      hook: t.post.idea?.hook || hookFromCaption(t.caption),
      views: m.views ?? 0, likes: m.likes ?? 0, comments: m.comments ?? 0, shares: m.shares ?? 0, saves: m.saves ?? 0, url: t.remoteUrl,
    });
  }
  return topPerformers(posts, 10).map((p) => ({
    text: p.hook, videoId: p.videoId, platform: "own", url: p.url ?? null, stats: p.stats,
  }));
}

/* ---- CREATOR ---- */

async function yt<T>(pathAndQuery: string): Promise<T> {
  const res = await fetch(`https://www.googleapis.com/youtube/v3/${pathAndQuery}&key=${encodeURIComponent(env.YOUTUBE_API_KEY)}`);
  if (!res.ok) throw new Error(`YouTube API ${res.status}`);
  return (await res.json()) as T;
}

async function youtubeVideos(url: string): Promise<Candidate[]> {
  const link = parseCreatorLink(url);
  if (!link || link.platform !== "youtube") return [];
  const tail = link.url.split("/").slice(1);
  const q = tail[0]?.startsWith("@") ? `forHandle=${encodeURIComponent(link.handle)}`
    : tail[0] === "channel" ? `id=${encodeURIComponent(link.handle)}`
      : tail[0] === "user" ? `forUsername=${encodeURIComponent(link.handle)}` : null;
  if (!q) return [];
  const ch = await yt<{ items?: Array<{ contentDetails?: { relatedPlaylists?: { uploads?: string } } }> }>(`channels?part=contentDetails&${q}`);
  const playlist = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!playlist) return [];
  const list = await yt<{ items?: Array<{ contentDetails?: { videoId?: string } }> }>(
    `playlistItems?part=contentDetails&maxResults=${YT_PER_CHANNEL}&playlistId=${playlist}`,
  );
  const ids = (list.items ?? []).map((i) => i.contentDetails?.videoId).filter(Boolean).join(",");
  if (!ids) return [];
  const got = await yt<{ items?: Array<{ id: string; snippet?: { title?: string; description?: string }; statistics?: { viewCount?: string; likeCount?: string; commentCount?: string } }> }>(
    `videos?part=snippet,statistics&id=${ids}`,
  );
  const handle = `@${link.handle.replace(/^@/, "")}`;
  return (got.items ?? []).map((v) => ({
    text: v.snippet?.title ?? "",
    context: (v.snippet?.description ?? "").split(/\r?\n/)[0]?.slice(0, 200),
    videoId: v.id,
    platform: "youtube",
    url: `https://www.youtube.com/watch?v=${v.id}`,
    account: handle,
    stats: {
      views: Number(v.statistics?.viewCount ?? 0) || undefined,
      likes: Number(v.statistics?.likeCount ?? 0) || undefined,
      comments: Number(v.statistics?.commentCount ?? 0) || undefined,
    },
  })).filter((c) => c.text);
}

/** Posts already fetched for the brand's inspiration accounts. Reads the stored snapshot; never pays for a fetch. */
async function inspirationVideos(clientId: string): Promise<Candidate[]> {
  const accounts = await prisma.inspirationAccount.findMany({
    where: { clientId },
    select: { platform: true, handle: true, snapshots: { orderBy: { fetchedAt: "desc" }, take: 1, select: { raw: true } } },
  });
  return accounts.flatMap((a) => {
    const raw = a.snapshots[0]?.raw;
    if (!raw) return [];
    const profile = a.platform === "tiktok" ? `https://www.tiktok.com/@${a.handle}` : `https://www.instagram.com/${a.handle}/`;
    return normalizeCompetitorPosts(raw)
      .filter((p) => !p.pinned && p.caption)
      .map((p) => ({
        text: hookFromCaption(p.caption),
        videoId: `cap-${createHash("sha1").update(p.caption).digest("hex").slice(0, 20)}`,
        platform: a.platform,
        url: profile,
        account: `@${a.handle}`,
        stats: { views: p.views ?? undefined, likes: p.likes ?? undefined, comments: p.comments ?? undefined },
      }));
  });
}

/* ---- WEB ---- */

async function webCandidates(anthropic: Anthropic, niche: string): Promise<Candidate[]> {
  const response = await anthropic.messages.create({
    model: env.SUGGESTIONS_MODEL,
    max_tokens: 3000,
    tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 3 }],
    system:
      "You find short form video hooks (the spoken or on-screen opening line) that are going viral right now " +
      "on TikTok, Instagram Reels and YouTube Shorts. Search the web, then answer with only a JSON array of up " +
      'to 10 objects: [{"hook": "...", "url": "..."}], where url is the page you found it on. The hook field is ' +
      "only the line itself, quoted as found, with no commentary. Real hooks only, nothing invented.",
    messages: [{ role: "user", content: `Find viral hooks from the last month that would work for: ${niche}.` }],
  } as Anthropic.MessageCreateParamsNonStreaming);

  const urls = new Set<string>();
  for (const block of response.content as unknown as Array<Record<string, unknown>>) {
    if (block.type === "web_search_tool_result" && Array.isArray(block.content)) {
      for (const r of block.content as Array<{ url?: string }>) if (r.url) urls.add(r.url);
    }
    if (block.type === "web_search_tool_result" && !Array.isArray(block.content)) {
      const code = (block.content as { error_code?: string } | null)?.error_code;
      throw new Error(`web search error: ${code ?? "unknown"}`);
    }
    for (const c of (block.citations as Array<{ url?: string }> | undefined) ?? []) if (c.url) urls.add(c.url);
  }
  const text = textOf(response);
  const start = text.indexOf("[{");
  const json = start >= 0 ? text.slice(start, text.lastIndexOf("]") + 1) : "";
  const list = (json ? JSON.parse(json) : []) as Array<{ hook?: string; url?: string }>;
  const fallback = [...urls][0] ?? null;
  return list
    .filter((h) => typeof h.hook === "string" && h.hook.trim())
    .slice(0, 10)
    .map((h) => {
      const url = h.url && urls.has(h.url) ? h.url : fallback;
      return { text: h.hook!.trim(), videoId: url ?? h.hook!, platform: "web", url };
    });
}

/* ---- the one entry point ---- */

/**
 * Mines all three sources for one brand. Never throws: each source logs and
 * contributes zero on failure. `deadline` stops further batches once passed.
 */
export async function mineHooks(clientId: string, log: Log, deadline = Date.now() + MINE_BUDGET_MS): Promise<MineResult> {
  const out: MineResult = { own: 0, web: 0, creator: 0, webStatus: "off" };
  if (!env.ANTHROPIC_API_KEY) return out;
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { ideaCreators: true, nicheProfile: true },
  });
  if (!client) return out;
  const niche = String((client.nicheProfile as { niche?: string } | null)?.niche ?? "").trim() || DEFAULT_HOOK_NICHE;
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  const own = (async () => {
    const fresh = freshOf(await ownCandidates(clientId), await seenIds(clientId, ["own"]), 10);
    if (!fresh.length) return;
    const rows = await classify(anthropic, niche, fresh, false);
    out.own = await save(clientId, "OWN", rows);
    await markSeen(clientId, fresh);
  })().catch((err) => log.warn({ err }, "hook mining: own posts failed"));

  const web = (async () => {
    const day = new Date().toISOString().slice(0, 10);
    const done = await prisma.hookSeenVideo.findUnique({
      where: { clientId_platform_videoId: { clientId, platform: "web", videoId: `day-${day}` } },
    });
    if (done) {
      out.webStatus = "skipped (already searched today)";
      return;
    }
    try {
      const found = await webCandidates(anthropic, niche);
      await markSeen(clientId, [{ platform: "web", videoId: `day-${day}` }]);
      const rows = keepNicheFit(found.length ? await classify(anthropic, niche, found, true) : []);
      out.web = await save(clientId, "WEB", rows);
      out.webStatus = "ok";
    } catch (err) {
      out.webStatus = `failed: ${err instanceof Error ? err.message.slice(0, 200) : String(err)}`;
      log.warn({ err }, "hook mining: web search failed, continuing without web hooks");
    }
  })();

  const creator = (async () => {
    const lists = await Promise.all([
      ...cleanCreatorLinks(client.ideaCreators).map((u) => youtubeVideos(u).catch((err) => {
        log.warn({ err, url: u }, "hook mining: creator channel failed");
        return [] as Candidate[];
      })),
      inspirationVideos(clientId),
    ]);
    const all = lists.flat();
    const fresh = freshOf(all, await seenIds(clientId, [...new Set(all.map((c) => c.platform))]), CREATOR_VIDEOS_PER_RUN);
    for (let i = 0; i < fresh.length && Date.now() < deadline; i += BATCH) {
      const batch = fresh.slice(i, i + BATCH);
      const rows = keepNicheFit(await classify(anthropic, niche, batch, true));
      out.creator += await save(clientId, "CREATOR", rows);
      // Seen whether it passed the niche bar or not: it has been paid for.
      await markSeen(clientId, batch);
    }
  })().catch((err) => log.warn({ err }, "hook mining: creators failed"));

  await Promise.all([own, web, creator]);
  log.info?.({ clientId, ...out }, "hook mining done");
  return out;
}

/**
 * Mines within the time budget, then lets the press go ahead. Mining that
 * runs over keeps going in the background and lands for the next press.
 */
export async function mineHooksBounded(clientId: string, log: Log, budgetMs = MINE_BUDGET_MS): Promise<MineResult | null> {
  const run = mineHooks(clientId, log, Date.now() + budgetMs).catch((err) => {
    log.warn({ err }, "hook mining failed");
    return null;
  });
  return Promise.race([run, new Promise<null>((r) => setTimeout(() => r(null), budgetMs))]);
}

/** Up to 8 library hooks as a prompt block for a generate call. Empty when the library is. */
export async function inspirationFor(clientId: string): Promise<string> {
  const hooks = await prisma.hook.findMany({
    where: { clientId },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { text: true, reworded: true, sourceType: true, format: true, funnelStage: true, nicheScore: true, stats: true },
  });
  return inspirationPrompt(sampleInspiration(hooks.map((h) => ({ ...h, stats: h.stats as HookStats | null })), 8));
}
