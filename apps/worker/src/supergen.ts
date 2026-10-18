import Anthropic from "@anthropic-ai/sdk";
import { cleanNeeds, needsLoad, NEEDS_RULES, checkDifficulty, DIFFICULTIES, DIFFICULTY_RUBRIC, batchCaps, enforceMix, preferencePrompt, preferenceProfile, FUNNEL_STAGES, funnelPromptGuide, reconcileFunnel, costCents, parseCreatorLink, VIDEO_FORMATS, VIDEO_FORMAT_GUIDE, type CreatorLink } from "@toreroflow/core";
import { getPrisma, groundingFor, Prisma } from "@toreroflow/db";
import { env } from "./env";
import { SHOT_SCHEMA, SHOT_RULES } from "./ideagifsJob";
import { cleanShot } from "./ideagifs";

/**
 * Super generate: for each creator link, read their last ~100 YouTube videos
 * (titles, numbers, and captions where YouTube has them), write a playbook of
 * what works (hook, framing, structure, script), then write ideas for this
 * brand's niche from all of the playbooks together.
 *
 * Progress is written to the run row after every step so the screen can draw
 * one row per creator. Playbooks are cached per channel for a week. The run
 * stops before any model call that would take it past its spending cap.
 */

const prisma = getPrisma();
const CACHE_MS = 7 * 24 * 60 * 60 * 1000;
const VIDEO_LIMIT = 100;
const TRANSCRIPT_VIDEOS = 20;
const TRANSCRIPT_CHARS = 1800;

export interface CreatorRow {
  url: string;
  handle: string;
  platform: string;
  status: "queued" | "reading" | "analyzing" | "done" | "skipped" | "failed";
  videos: number;
  note: string;
  playbook?: Playbook;
}

export interface Playbook {
  summary: string;
  hook: string;
  framing: string;
  structure: string;
  script: string;
}

const PLAYBOOK_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "hook", "framing", "structure", "script"],
  properties: {
    summary: { type: "string" },
    hook: { type: "string" },
    framing: { type: "string" },
    structure: { type: "string" },
    script: { type: "string" },
  },
} as const;

const IDEAS_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["ideas"],
  properties: {
    ideas: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["text", "label", "format", "funnelStage", "whyItWorks", "difficulty", "actors", "locations", "needs", "script", "creator", "shots"],
        properties: {
          text: { type: "string" },
          label: { type: "string" },
          format: { type: "string", enum: [...VIDEO_FORMATS] },
          funnelStage: { type: "string", enum: [...FUNNEL_STAGES] },
          whyItWorks: { type: "string" },
          difficulty: { type: "string", enum: [...DIFFICULTIES] },
          actors: { type: "integer" },
          locations: { type: "integer" },
          needs: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["type", "label"],
              properties: { type: { type: "string", enum: ["prop", "location", "people"] }, label: { type: "string" } },
            },
          },
          script: { type: "string" },
          creator: { type: "string" },
          shots: { type: "array", items: SHOT_SCHEMA },
        },
      },
    },
  },
} as const;

class CapReached extends Error {}
class Cancelled extends Error {}

interface Video {
  id: string;
  title: string;
  views: number;
  duration: string;
  published: string;
  description: string;
}

async function yt<T>(pathAndQuery: string): Promise<T> {
  const sep = pathAndQuery.includes("?") ? "&" : "?";
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/${pathAndQuery}${sep}key=${encodeURIComponent(env.YOUTUBE_API_KEY)}`,
  );
  if (!res.ok) {
    // Never echo the URL: it carries the key.
    const body = (await res.text()).slice(0, 200).replace(env.YOUTUBE_API_KEY, "***");
    throw new Error(`YouTube API ${res.status}: ${body}`);
  }
  return (await res.json()) as T;
}

async function uploadsPlaylist(link: CreatorLink): Promise<{ playlist: string; title: string } | null> {
  type Ch = { items?: Array<{ id: string; snippet?: { title?: string }; contentDetails?: { relatedPlaylists?: { uploads?: string } } }> };
  const part = "part=snippet,contentDetails";
  const tail = link.url.split("/").slice(1);
  let got: Ch;
  if (tail[0]?.startsWith("@")) got = await yt<Ch>(`channels?${part}&forHandle=${encodeURIComponent(link.handle)}`);
  else if (tail[0] === "channel") got = await yt<Ch>(`channels?${part}&id=${encodeURIComponent(link.handle)}`);
  else if (tail[0] === "user") got = await yt<Ch>(`channels?${part}&forUsername=${encodeURIComponent(link.handle)}`);
  else {
    const s = await yt<{ items?: Array<{ id?: { channelId?: string } }> }>(
      `search?part=snippet&type=channel&maxResults=1&q=${encodeURIComponent(link.handle)}`,
    );
    const id = s.items?.[0]?.id?.channelId;
    if (!id) return null;
    got = await yt<Ch>(`channels?${part}&id=${id}`);
  }
  const ch = got.items?.[0];
  const playlist = ch?.contentDetails?.relatedPlaylists?.uploads;
  return playlist ? { playlist, title: ch?.snippet?.title ?? link.handle } : null;
}

async function recentVideos(playlist: string): Promise<Video[]> {
  const ids: string[] = [];
  let page = "";
  while (ids.length < VIDEO_LIMIT) {
    const got = await yt<{ items?: Array<{ contentDetails?: { videoId?: string } }>; nextPageToken?: string }>(
      `playlistItems?part=contentDetails&maxResults=50&playlistId=${playlist}${page ? `&pageToken=${page}` : ""}`,
    );
    for (const it of got.items ?? []) if (it.contentDetails?.videoId) ids.push(it.contentDetails.videoId);
    if (!got.nextPageToken) break;
    page = got.nextPageToken;
  }
  const out: Video[] = [];
  for (let i = 0; i < Math.min(ids.length, VIDEO_LIMIT); i += 50) {
    const batch = ids.slice(i, i + 50).join(",");
    const got = await yt<{
      items?: Array<{
        id: string;
        snippet?: { title?: string; publishedAt?: string; description?: string };
        statistics?: { viewCount?: string };
        contentDetails?: { duration?: string };
      }>;
    }>(`videos?part=snippet,statistics,contentDetails&id=${batch}`);
    for (const v of got.items ?? []) {
      out.push({
        id: v.id,
        title: v.snippet?.title ?? "",
        views: Number(v.statistics?.viewCount ?? 0),
        duration: v.contentDetails?.duration ?? "",
        published: (v.snippet?.publishedAt ?? "").slice(0, 10),
        description: (v.snippet?.description ?? "").slice(0, 200),
      });
    }
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/** Captions from the public watch page, when the video has them. Null otherwise. */
async function transcript(videoId: string): Promise<string | null> {
  try {
    const page = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
      headers: { "accept-language": "en-US,en;q=0.9", "user-agent": "Mozilla/5.0" },
    });
    if (!page.ok) return null;
    const html = await page.text();
    const m = html.match(/"captionTracks":(\[.*?\])/);
    if (!m) return null;
    const tracks = JSON.parse(m[1]!) as Array<{ baseUrl: string; languageCode?: string }>;
    const track = tracks.find((t) => t.languageCode?.startsWith("en")) ?? tracks[0];
    if (!track) return null;
    const res = await fetch(track.baseUrl);
    if (!res.ok) return null;
    const xml = await res.text();
    const text = decodeEntities(xml.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
    return text ? text.slice(0, TRANSCRIPT_CHARS) : null;
  } catch {
    return null;
  }
}

export async function runSuperGenerate(runId: string): Promise<void> {
  const run = await prisma.superGenerateRun.findUnique({
    where: { id: runId },
    include: { client: { select: { id: true, name: true, nicheProfile: true } } },
  });
  if (!run || run.status !== "running") return;
  const rows = (run.creators as unknown as CreatorRow[]) ?? [];
  let spent = run.spentCents;

  const save = async (extra: Prisma.SuperGenerateRunUpdateInput = {}) => {
    const cur = await prisma.superGenerateRun.findUnique({ where: { id: runId }, select: { status: true } });
    await prisma.superGenerateRun.update({
      where: { id: runId },
      data: { creators: rows as unknown as Prisma.InputJsonValue, spentCents: spent, ...extra },
    });
    if (cur?.status === "cancelled") throw new Cancelled();
  };

  const fail = async (message: string) => {
    await prisma.superGenerateRun.update({
      where: { id: runId },
      data: { status: "failed", error: message, completedAt: new Date(), creators: rows as unknown as Prisma.InputJsonValue, spentCents: spent },
    });
  };

  if (!env.YOUTUBE_API_KEY) return fail("Super generate needs a YouTube API key (YOUTUBE_API_KEY).");
  if (!env.ANTHROPIC_API_KEY) return fail("Super generate needs an Anthropic API key (ANTHROPIC_API_KEY).");
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

  /** One model call, refused up front when its rough worst case would pass the cap. */
  const ask = async <T>(system: string, content: string, schema: object, maxTokens: number): Promise<T> => {
    const worst = costCents(Math.ceil(content.length / 3.5) + 800, maxTokens);
    if (spent + worst > run.capCents) throw new CapReached();
    const response = await anthropic.messages.create({
      model: env.COPY_MODEL,
      max_tokens: maxTokens,
      output_config: { effort: "low", format: { type: "json_schema", schema } },
      system,
      messages: [{ role: "user", content }],
    } as Anthropic.MessageCreateParamsNonStreaming);
    spent += costCents(response.usage.input_tokens, response.usage.output_tokens);
    const block = response.content.find((c) => c.type === "text");
    return JSON.parse(block && "text" in block ? block.text : "{}") as T;
  };

  try {
    for (const row of rows) {
      const link = parseCreatorLink(row.url);
      if (!link || link.platform !== "youtube") {
        row.status = "skipped";
        row.note = "YouTube only for now";
        await save();
        continue;
      }
      const cached = await prisma.creatorPlaybook.findUnique({ where: { url: link.url } });
      if (cached && Date.now() - cached.updatedAt.getTime() < CACHE_MS) {
        row.status = "done";
        row.videos = cached.videos;
        row.note = "cached";
        row.playbook = cached.playbook as unknown as Playbook;
        await save();
        continue;
      }
      try {
        row.status = "reading";
        row.note = "reading videos...";
        await save();
        const ch = await uploadsPlaylist(link);
        if (!ch) throw new Error("channel not found");
        const videos = await recentVideos(ch.playlist);
        if (videos.length === 0) throw new Error("no videos");
        row.videos = videos.length;
        row.note = "reading scripts...";
        await save();
        const top = [...videos].sort((a, b) => b.views - a.views).slice(0, TRANSCRIPT_VIDEOS);
        const scripts: string[] = [];
        for (const v of top) {
          const t = await transcript(v.id);
          if (t) scripts.push(`"${v.title}" (${v.views} views):\n${t}`);
        }
        row.status = "analyzing";
        row.note = scripts.length ? `${scripts.length} scripts read` : "titles only, no captions";
        await save();
        const list = videos
          .map((v) => `- ${v.published} | ${v.views} views | ${v.duration} | ${v.title}`)
          .join("\n");
        const playbook = await ask<Playbook>(
          "You study one video creator and write down what works for them, so another " +
            "brand can borrow the shape (never the words). Plain language, no jargon, " +
            "never an em dash or arrow. Each field is one short sentence, under 20 words. " +
            "summary: what they are known for, five to eight words. hook: how the first " +
            "line opens. framing: how it is filmed. structure: the order of a typical video. " +
            "script: how the words are written and how long. Base everything on the data; " +
            "the best performing videos count most.",
          `Creator: ${ch.title} (${link.handle})\nLast ${videos.length} videos:\n${list}\n\n` +
            (scripts.length ? `Transcripts of their most watched videos:\n\n${scripts.join("\n\n")}` : "No transcripts available."),
          PLAYBOOK_SCHEMA,
          1200,
        );
        await prisma.creatorPlaybook.upsert({
          where: { url: link.url },
          create: { url: link.url, platform: "youtube", handle: link.handle, videos: videos.length, playbook: playbook as unknown as Prisma.InputJsonValue },
          update: { handle: link.handle, videos: videos.length, playbook: playbook as unknown as Prisma.InputJsonValue },
        });
        row.status = "done";
        row.note = "";
        row.playbook = playbook;
        await save();
      } catch (err) {
        if (err instanceof CapReached || err instanceof Cancelled) throw err;
        row.status = "failed";
        row.note = (err as Error).message.slice(0, 160);
        await save();
      }
    }

    const books = rows.filter((r) => r.playbook);
    if (books.length === 0) return fail("None of the creators could be read. Check the links are YouTube channels.");
    const niche = String((run.client.nicheProfile as { niche?: string } | null)?.niche ?? "");
    // 20 ideas split across the creators (10 when generating for one creator).
    const total = rows.length === 1 ? 10 : 20;
    const quota = books.map((b, i) => ({
      handle: b.handle,
      n: Math.floor(total / books.length) + (i < total % books.length ? 1 : 0),
    })).filter((q) => q.n > 0);
    const caps = batchCaps(total);
    const recent = await prisma.ideaFeedback.findMany({
      where: { clientId: run.clientId }, orderBy: { createdAt: "desc" }, take: 400,
      select: { format: true, funnelStage: true, hookStyle: true, creator: true, saved: true },
    });
    const prefs = preferencePrompt(preferenceProfile(recent));
    const savedTexts = (await prisma.contentIdea.findMany({
      where: { clientId: run.clientId }, orderBy: { createdAt: "desc" }, take: 300, select: { text: true },
    })).map((r) => r.text);
    const got = await ask<{ ideas: Array<{ text: string; label: string; format?: string; funnelStage?: string; whyItWorks?: string; difficulty?: string; actors?: number; locations?: number; needs?: unknown; script: string; creator: string; shots: Array<Record<string, string>> }> }>(
      "You write short form video ideas for one brand, borrowing what works for the " +
        "creators studied below. Each idea is the opening line of the video, spoken out " +
        "loud, six to fifteen words, specific to this brand's niche. label is the " +
        "creator move it borrows, two to four words (e.g. Number-first hook). No hashtags, " +
        "no emoji, never an em dash, en dash or arrow. Do not invent prices or facts that " +
        "are not in the brand material. text is the topic: the opening line, spoken. " +
        "script is the short video script for it, 40 to 90 words, as four lines starting " +
        "HOOK:, SETUP:, PAYOFF:, CTA: separated by newlines. creator is the exact handle of " +
        "the creator whose playbook the idea borrows from. format is the video format the idea " +
        "is filmed in, exactly one of: " + VIDEO_FORMATS.map((f) => `${f} (${VIDEO_FORMAT_GUIDE[f]})`).join("; ") +
        ". Pick the format that best fits each idea and the creator's playbook, and spread the " +
        "ideas across several formats, including the newer ones like Comparison and Ranking, " +
        "instead of repeating one. funnelStage is the funnel stage the idea serves: top, middle " +
        "or bottom. Decide the stage first, then pick a format that suits it:\n" + funnelPromptGuide() +
        "\nMix the stages: about half top, a third middle, the rest bottom. Keep the batch distinct: " +
        `at most ${caps.perFormat} ideas per format, at most ${caps.perStage} per stage, at most ${caps.perHook} ` +
        "per hook style (label), every label different where you can, and no two ideas on the same " +
        "topic or angle. whyItWorks is one specific sentence, under 25 words, naming the psychology " +
        "or trend that makes this idea stop the scroll (e.g. curiosity gap, social proof, loss " +
        "aversion, a verdict people want to argue with). No fluff, no em dash. " +
        (prefs ? prefs + " " : "") + DIFFICULTY_RUBRIC + " " + NEEDS_RULES + " " + SHOT_RULES + "  Write exactly this many ideas per " +
        "creator: " + quota.map((q) => `${q.handle} ${q.n}`).join(", ") + ".",
      `Brand: ${run.client.name}\nNiche: ${niche || "(see brand material)"}\n\n` +
        books
          .map((b) => `${b.handle}: ${b.playbook!.summary}\nHook: ${b.playbook!.hook}\nFraming: ${b.playbook!.framing}\nStructure: ${b.playbook!.structure}\nScript: ${b.playbook!.script}`)
          .join("\n\n") +
        `\n\n${await groundingFor(prisma, run.clientId)}`,
      IDEAS_SCHEMA,
      Math.min(14000, 400 + total * 420),
    );
    await save({
      status: "ready",
      ideas: enforceMix(tagIdeas((got.ideas ?? []).map((i) => { const shots = (i.shots ?? []).slice(0, 5).map((s, n) => cleanShot(s, n)); const fit = reconcileFunnel(i.format, i.funnelStage); const needs = cleanNeeds(i.needs, shots.map((s) => String((s as { title?: string }).title ?? ""))); const load = needsLoad(needs); const { actors, locations, ...rest } = i; return { ...rest, ...fit, needs, difficulty: checkDifficulty(i.difficulty, fit.format, shots.length, Math.max(Number(actors) || 1, load.actors), Math.max(Number(locations) || 1, load.locations), load.props), shots }; }), quota.map((q) => q.handle)), total, savedTexts).slice(0, total) as unknown as Prisma.InputJsonValue,
      completedAt: new Date(),
    });
  } catch (err) {
    if (err instanceof Cancelled) return;
    if (err instanceof CapReached) {
      for (const r of rows) if (r.status === "queued" || r.status === "reading" || r.status === "analyzing") {
        r.status = "skipped";
        r.note = "spending cap reached";
      }
      return fail(`Stopped at the spending cap ($${(run.capCents / 100).toFixed(2)}). Raise it in Super generate settings to read more.`);
    }
    return fail((err as Error).message.slice(0, 300));
  }
}

/** Keeps each idea's creator to one of the studied handles (case-insensitive), so the screen can group them. */
export function tagIdeas<T extends { creator: string }>(ideas: T[], handles: string[]): T[] {
  const by = new Map(handles.map((h) => [h.toLowerCase().replace(/^@/, ""), h]));
  return ideas.map((i, n) => ({
    ...i,
    creator: by.get(String(i.creator ?? "").toLowerCase().replace(/^@/, "")) ?? handles[n % Math.max(1, handles.length)] ?? "",
  }));
}
