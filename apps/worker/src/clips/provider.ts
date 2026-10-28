import Anthropic from "@anthropic-ai/sdk";
import {
  curateWindows,
  heuristicCurate,
  heuristicJudge,
  linesToRanges,
  numberedLines,
  type CurateOptions,
  type DraftClip,
  type Judged,
  type LengthTarget,
  type Range,
  type ClipSentence,
} from "@toreroflow/core";
import { env } from "../env";

/**
 * Who curates and judges clips.
 *
 * - anthropic: the existing Anthropic path (ANTHROPIC_API_KEY, COPY_MODEL),
 *   used only when a key is already configured. No new account, no new spend
 *   beyond what that key already pays for.
 * - heuristic: free and local (core/clipCurate). The feature works with no key.
 * - sunra: not offered. Sunra's MCP (the plan-credit path, estimate_cost then
 *   confirm_execution) lists image, video, audio and 3D models only, no text
 *   model, and an OAuth MCP tool is an agent-side connection the worker
 *   cannot call. Sunra's REST API does list token-billed LLMs, but that bills
 *   the wallet per token, which is exactly the spend this switch avoids.
 *
 * ponytail: CLIPS_AI=auto picks anthropic when the key exists, else heuristic.
 */
export type ClipsProvider = "anthropic" | "heuristic";

export function resolveProvider(setting = env.CLIPS_AI, key = env.ANTHROPIC_API_KEY): {
  provider: ClipsProvider;
  note?: string;
} {
  const s = (setting || "auto").toLowerCase();
  if (s === "heuristic") return { provider: "heuristic" };
  if (s === "sunra") {
    return { provider: "heuristic", note: "Sunra has no text model on the MCP plan; using the local heuristic" };
  }
  if (s === "anthropic" && !key) {
    return { provider: "heuristic", note: "CLIPS_AI=anthropic but no ANTHROPIC_API_KEY; using the local heuristic" };
  }
  if (key && (s === "anthropic" || s === "auto")) return { provider: "anthropic" };
  return { provider: "heuristic" };
}

const CURATE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["clips"],
  properties: {
    clips: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["lines", "title", "why", "description", "hashtags"],
        properties: {
          lines: {
            type: "array",
            description: "1-5 inclusive [first,last] line spans in PLAY order; a hook line may come first",
            items: { type: "array", items: { type: "integer" } },
          },
          title: { type: "string" },
          why: { type: "string" },
          description: { type: "string" },
          hashtags: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
} as const;

const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["scores"],
  properties: {
    scores: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["n", "hook", "flow", "value", "trend", "relevance", "comments"],
        properties: {
          n: { type: "integer" },
          hook: { type: "integer" },
          flow: { type: "integer" },
          value: { type: "integer" },
          trend: { type: "integer" },
          relevance: { type: "integer" },
          comments: {
            type: "object",
            additionalProperties: false,
            required: ["hook", "flow", "value", "trend", "relevance"],
            properties: {
              hook: { type: "string" },
              flow: { type: "string" },
              value: { type: "string" },
              trend: { type: "string" },
              relevance: { type: "string" },
            },
          },
        },
      },
    },
  },
} as const;

async function askJson<T>(system: string, user: string, schema: object): Promise<T> {
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const response = await anthropic.messages.create({
    model: env.COPY_MODEL,
    max_tokens: 8192,
    output_config: { format: { type: "json_schema", schema } },
    system,
    messages: [{ role: "user", content: user }],
  } as Anthropic.MessageCreateParamsNonStreaming);
  if (response.stop_reason === "refusal") throw new Error("the model declined this transcript");
  if (response.stop_reason === "max_tokens") throw new Error("the model answer came back too long to read, run it again");
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("the model returned an empty response");
  return JSON.parse(text.text) as T;
}

const CURATOR =
  "You cut long talking videos into short social clips. You read numbered transcript lines and pick " +
  "self-contained moments. Each clip is 1-5 line spans in play order. Start every clip on a complete " +
  "thought, never on 'and', 'so' or a pronoun with no antecedent. You may put one strong later line " +
  "first as the hook, and you may skip a tangent by splitting a span. End on a complete line. Plain " +
  "titles under 8 words.";

export async function curate(
  provider: ClipsProvider,
  ss: ClipSentence[],
  durationSec: number,
  targets: LengthTarget[],
  opts: CurateOptions & { genre?: string },
  log: (line: string) => Promise<void>,
): Promise<DraftClip[]> {
  if (provider === "heuristic") return heuristicCurate(ss, durationSec, targets, opts);
  const from = opts.from ?? 0;
  const to = opts.to ?? ss.length - 1;
  const scope = ss.slice(from, to + 1);
  const windows = curateWindows(scope);
  const perWindow = Math.max(2, Math.ceil((opts.count ?? Math.max(5, Math.round(durationSec / 45))) / Math.max(1, windows.length * targets.length)));
  const out: DraftClip[] = [];
  for (const target of targets) {
    for (const [k, w] of windows.entries()) {
      await log(`curate ${target.key} window ${k + 1}/${windows.length}`);
      const lines = scope.slice(w.from, w.to + 1);
      const res = await askJson<{ clips: { lines: number[][]; title: string; why: string; description: string; hashtags: string[] }[] }>(
        CURATOR,
        `Genre: ${opts.genre ?? "auto"}.` +
          (opts.prompt ? ` Find moments about: ${opts.prompt}.` : "") +
          (opts.keywords?.length ? ` Topic keywords: ${opts.keywords.join(", ")}.` : "") +
          `\nPick up to ${perWindow} clips of ${target.min}-${target.max} seconds total.\n\n${numberedLines(lines)}`,
        CURATE_SCHEMA,
      );
      for (const c of res.clips ?? []) {
        const spans = (c.lines ?? [])
          .filter((l) => Array.isArray(l) && l.length >= 1)
          .slice(0, 5)
          .map((l) => [Number(l[0]), Number(l[l.length - 1])] as [number, number]);
        const ranges: Range[] = linesToRanges(ss, spans).filter(([s, e]) => e > s);
        if (!ranges.length) continue;
        out.push({
          ranges,
          lengthTarget: target.key,
          title: String(c.title ?? "").slice(0, 120) || "Untitled clip",
          why: String(c.why ?? "").slice(0, 300),
          description: String(c.description ?? "").slice(0, 500),
          hashtags: (c.hashtags ?? []).slice(0, 5).map((h) => (h.startsWith("#") ? h : `#${h}`)),
          hookPulled: ranges.length > 1 && ranges[0][0] > ranges[1][0],
        });
      }
    }
  }
  return out;
}

const JUDGE =
  "You judge short social clips cut from a longer talk. Score each 0-10 as integers: hook (does the " +
  "first line stop a scroll), flow (complete, coherent, ends cleanly), value (a takeaway or a payoff), " +
  "trend (topic fits what is popular in its niche now), relevance (fit to the job prompt, 5 when there " +
  "is none). Use the whole range; most clips are 4-8. One short comment per score.";

export async function judge(
  provider: ClipsProvider,
  clips: { ranges: Range[]; text: string; title: string }[],
  ss: ClipSentence[],
  prompt: string | undefined,
  log: (line: string) => Promise<void>,
): Promise<Judged[]> {
  if (provider === "heuristic") return heuristicJudge(clips, ss, prompt);
  const out: Judged[] = [];
  const batch = 8;
  const batches = Math.ceil(clips.length / batch);
  for (let b = 0; b < batches; b++) {
    await log(`judge batch ${b + 1}/${batches}`);
    const part = clips.slice(b * batch, (b + 1) * batch);
    const res = await askJson<{ scores: (Judged & { n: number })[] }>(
      JUDGE,
      (prompt ? `Job prompt: ${prompt}\n\n` : "") +
        part.map((c, i) => `Clip ${i}: ${c.title}\n${c.text.slice(0, 3000)}`).join("\n\n"),
      JUDGE_SCHEMA,
    );
    part.forEach((_, i) => {
      const s = res.scores?.find((x) => x.n === i);
      out.push({
        hook: s?.hook ?? 0,
        flow: s?.flow ?? 0,
        value: s?.value ?? 0,
        trend: s?.trend ?? 0,
        relevance: prompt ? (s?.relevance ?? 0) : null,
        comments: s?.comments ?? { hook: "", flow: "", value: "", trend: "" },
      });
    });
  }
  return out;
}
