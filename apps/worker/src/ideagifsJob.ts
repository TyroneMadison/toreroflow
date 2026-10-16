import Anthropic from "@anthropic-ai/sdk";
import { getPrisma, Prisma } from "@toreroflow/db";
import { env } from "./env";
import {
  ANGLES, FRAMINGS, MOVES, POSES, cleanShot, gifKey, hookFromScript, renderHookGif, renderShotGif, type Shot,
} from "./ideagifs";

/**
 * Draws (or reuses from cache) the hook GIF and one GIF per shot for a saved
 * idea, then stores the list on the idea. Ideas saved without a shot list get
 * one written from their script first.
 */

const prisma = getPrisma();

export const SHOT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "framing", "angle", "move", "pose", "time", "sign"],
  properties: {
    title: { type: "string" },
    framing: { type: "string", enum: [...FRAMINGS] },
    angle: { type: "string", enum: [...ANGLES] },
    move: { type: "string", enum: [...MOVES] },
    pose: { type: "string", enum: [...POSES] },
    time: { type: "string" },
    sign: { type: "string" },
  },
} as const;

export const SHOT_RULES =
  "shots is the shot list, exactly 3 shots: title is what happens on screen (under 8 words); " +
  "framing, angle, move and pose pick the closest option; time is a range like 0:00-0:03; " +
  "sign is short on-screen text (under 5 words) when the shot shows a sign or text overlay, else empty.";

async function writeShots(text: string, script: string): Promise<Shot[]> {
  if (!env.ANTHROPIC_API_KEY) return [];
  const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
  const response = await anthropic.messages.create({
    model: env.COPY_MODEL,
    max_tokens: 800,
    output_config: {
      effort: "low",
      format: {
        type: "json_schema",
        schema: { type: "object", additionalProperties: false, required: ["shots"], properties: { shots: { type: "array", items: SHOT_SCHEMA } } },
      },
    },
    system: `You plan how a short form video is filmed. Plain words, never an em dash. ${SHOT_RULES}`,
    messages: [{ role: "user", content: `Topic: ${text}\nScript:\n${script}` }],
  } as Anthropic.MessageCreateParamsNonStreaming);
  const block = response.content.find((c) => c.type === "text");
  const got = JSON.parse(block && "text" in block ? block.text : "{}") as { shots?: Partial<Shot>[] };
  return (got.shots ?? []).slice(0, 5).map(cleanShot);
}

async function ensure(key: string, draw: () => Buffer) {
  const have = await prisma.ideaGif.findUnique({ where: { key }, select: { key: true } });
  if (have) return;
  await prisma.ideaGif.upsert({ where: { key }, create: { key, bytes: new Uint8Array(draw()) }, update: {} });
}

export async function runIdeaGifs(ideaId: string): Promise<void> {
  const idea = await prisma.contentIdea.findUnique({ where: { id: ideaId } });
  if (!idea) return;
  let shots = Array.isArray(idea.shots) ? (idea.shots as Partial<Shot>[]).slice(0, 5).map(cleanShot) : [];
  if (shots.length === 0 && idea.scriptText) {
    try {
      shots = await writeShots(idea.hook || idea.text, idea.scriptText);
    } catch (err) {
      console.warn("idea gifs: shot list failed", (err as Error).message);
    }
  }
  const hook = hookFromScript(idea.scriptText, idea.hook || idea.text);
  const seed = idea.id;
  const gifs: Array<{ kind: "hook" | "shot"; key: string; caption: string }> = [];
  const hk = gifKey("hook", { hook, seed });
  await ensure(hk, () => renderHookGif(hook, seed));
  gifs.push({ kind: "hook", key: hk, caption: "Say this \u00b7 Hook: medium close-up, captions on" });
  for (const [i, s] of shots.entries()) {
    const key = gifKey("shot", { s, i, seed });
    await ensure(key, () => renderShotGif(s, i, seed));
    gifs.push({ kind: "shot", key, caption: `Shot ${i + 1} \u00b7 ${s.title}${s.time ? ` \u00b7 ${s.time}` : ""}` });
  }
  await prisma.contentIdea.update({
    where: { id: idea.id },
    data: { shots: shots as unknown as Prisma.InputJsonValue, gifs: gifs as unknown as Prisma.InputJsonValue },
  });
}