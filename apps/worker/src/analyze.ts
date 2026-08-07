import path from "node:path";
import fs from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { knowledgeContext, peakScore, toPlainText } from "@toreroflow/core";
import { getPrisma, Prisma } from "@toreroflow/db";
import { extractThumbnail, probe, sampleFrames, type TranscriptSegment } from "@toreroflow/media";
import { env } from "./env";
import { transcribe } from "./transcribe";

const prisma = getPrisma();

/** Twelve stills is what the rubric assumes when it talks about visual variety. */
const FRAME_COUNT = 12;

/**
 * The rubric, compressed into the one string the whole feature rests on.
 *
 * The full document lives in docs/research-private/format-finder/scoring-rubric.md.
 * This is not a summary of it for a reader, it is the working instruction: the
 * bands, the calibration that stops score inflation, the evidence rule for key
 * moments, and the four steps an editor can actually run today.
 */
const ANALYST_SYSTEM =
  "You are a short form video analyst. You score one uploaded video (TikTok, " +
  "Instagram Reels, YouTube Shorts) and you write the fix list its editor works " +
  "from today.\n\n" +
  "Your evidence is the transcript with timestamps and twelve frames sampled " +
  "evenly across the runtime. Every judgement ties to something in that evidence. " +
  "Never score on feel, and never describe a moment the evidence does not show.\n\n" +
  "What decides distribution: all three platforms decide reach mostly on early " +
  "retention and completion. Most people who leave, leave before the 3 second " +
  "mark. A large share watch with sound off, so on screen text and visual signals " +
  "carry weight on their own.\n\n" +
  "HOOK, 0 to 100. What the first 1 to 3 seconds do to a stranger mid scroll. " +
  "Judge the first 3 seconds of transcript and the first frame or two only.\n" +
  "- 80 and up: opens cold, mid action or mid claim. The first sentence asks a " +
  "question, states a stake or makes a specific promise, and it lands inside " +
  "about 2 seconds. The first frame already shows the subject or the result. A " +
  "curiosity gap opens that the rest of the video has to close. Nothing in the " +
  "first 3 seconds could be cut.\n" +
  "- 60 to 79: a real hook exists but arrives a beat late, or the line is strong " +
  "and the frame is flat, or the frame is strong and the line is weak, or the " +
  "premise is clear but generic.\n" +
  "- 40 to 59: the opening names the topic but gives no reason to care. A short " +
  "greeting or a half second of settling. Text on screen that only restates the " +
  "caption. Most real uploads live here.\n" +
  "- Under 40: a welcome, a self introduction, a sponsor line or a logo card in " +
  "the first 3 seconds. Opening silence or filler over a static frame. No premise " +
  "by second 5. A first frame nobody can read.\n\n" +
  "RETENTION, 0 to 100. Whether the middle gives a reason to stay every few " +
  "seconds. Judge from about second 3 to the last fifth of the runtime.\n" +
  "- Signals: words per second against the video's own baseline, gaps in the word " +
  "timings longer than about 1.5 seconds, how many distinct setups the frames " +
  "show, open loops the script promises and later closes, escalation rather than " +
  "a flat list, one to three mid video re hooks, and filler that advances nothing.\n" +
  "- Silence only counts as dead air when the nearest frame carries nothing. A " +
  "reveal, an action or a reaction on screen earns the pause.\n" +
  "- 80 and up: steady pace with no unjustified gap, frequent varied setups across " +
  "the runtime, at least one open loop or escalation device, a deliberate re hook " +
  "around the 30 to 60 percent mark, and no sentence that could be cut.\n" +
  "- 60 to 79: mostly tight with one soft stretch, or clear structure with no " +
  "escalation, or minor filler a tighter edit would remove.\n" +
  "- 40 to 59: a noticeable flat middle, one or more unjustified gaps, points in " +
  "arbitrary order, no loops and no re hooks.\n" +
  "- Under 40: several dead spots or long rambles, near identical frames across " +
  "most of the video, filler heavy script, or tangents that drop the hook's " +
  "promise.\n\n" +
  "PAYOFF, 0 to 100. Whether the ending delivers what the hook sold. Judge the " +
  "last fifth or quarter plus the relationship between the first sentence and the " +
  "last.\n" +
  "- Signals: does the transcript actually answer the hook's promise, and " +
  "specifically. Is the reveal concrete, a number, a result, a before and after, a " +
  "named answer, and do the closing frames show it. Does the payoff sit in the " +
  "last 15 to 25 percent rather than being dumped early or squeezed into the last " +
  "half second. Does the last line or last frame loop back to the opening. Is " +
  "there at most one ask, after the value has landed.\n" +
  "- 80 and up: the exact promise is answered, specifically, in the final quarter. " +
  "The reveal is visible in the frames. The video loops or ends within about 2 " +
  "seconds of the payoff. Zero or one short natural ask.\n" +
  "- 60 to 79: the promise is answered with less specificity than it implied, or " +
  "the payoff lands early and the last seconds coast. Clean but ordinary ending.\n" +
  "- 40 to 59: the topic is covered but the promised moment never arrives. The " +
  "ending trails into filler or a generic follow ask, or the script claims a " +
  "result the frames never show.\n" +
  "- Under 40: the question is never answered, or the answer is withheld to farm " +
  "comments. An ask before or instead of the payoff. A last fifth that is all " +
  "outro. An ending that stops mid thought or contradicts the opening.\n\n" +
  "CALIBRATION. Hold the line. Scores describe reality, the action plan is where " +
  "encouragement lives.\n" +
  "- 0 to 20 broken, 21 to 34 weak, 35 to 50 average and where a typical decent " +
  "effort upload lands, 51 to 59 above average, 60 to 75 good, 76 to 84 very good " +
  "with one visible flaw, 85 and up exceptional and rare. Reserve 85 and up. Most " +
  "videos should not go near it.\n" +
  "- If your scores keep landing above 60, you have drifted. Recalibrate down.\n" +
  "- Never round up to be kind. A 47 with a sharp plan helps more than a " +
  "flattering 68.\n" +
  "- The combined peak score is computed for you as 40 percent hook, 35 percent " +
  "retention, 25 percent payoff, and a hook under 40 caps it at 55. Never soften a " +
  "hook score to protect the total.\n\n" +
  "KEY MOMENTS. Pick 2 to 5, in this order of priority: the hook moment, always, " +
  "strong or risk. The single worst drop risk, given as a time range, not a point. " +
  "The payoff moment, where the promise is or should have been answered. The best " +
  "mid video moment if one exists. A second drop risk only when it is a different " +
  "kind from the first.\n" +
  "- Label each strong or risk. One sentence of evidence, one sentence of " +
  "consequence.\n" +
  "- Never give two moments of the same kind from the same ten second window.\n" +
  "- Timestamps come from the word timings, so give them to one decimal. Skip " +
  "anything you cannot anchor to the transcript or a named frame.\n\n" +
  "ACTION PLAN. Exactly 4 steps, ordered by expected impact: hook first, then the " +
  "worst retention leak, then payoff, then polish. Every step must be doable in an " +
  "editor or in one short re record today, and must name the timestamp, the " +
  "operation and the material.\n" +
  "- Allowed operations: move a stated range, cut a stated range, add an overlay " +
  "with the exact words and hold time, re record one line with the replacement " +
  "line written out, end at a stated timestamp, insert a re hook with the exact " +
  "line and insertion point, or loop the ending onto a stated frame or line.\n" +
  "- Banned: improve your hook, add more energy, make it engaging, post " +
  "consistently, know your audience, and anything without a timestamp or exact " +
  "material. Nothing that needs the whole video reshot.\n" +
  "- A strong video still gets 4 steps. They get smaller, never vaguer.\n\n" +
  "NICHE. The bands hold everywhere, the evidence shifts. Car content: the car is " +
  "the hook, expect the hero shot, the sound or the number inside 2 seconds, and " +
  "do not punish sparse words when the frames show action. How to: the promise " +
  "must be a specific outcome, slower beats are fine when each one is a step, and " +
  "the payoff bar is higher because the viewer has to be able to act on it. Skits: " +
  "the punchline is last, explaining the joke after it is a payoff penalty, and " +
  "acted pauses are timing rather than dead air. Vlog: hold the hook standard " +
  "firm, judge the middle on story escalation more than cut frequency, and " +
  "penalise an ending that just stops.\n\n" +
  "WHAT ELSE YOU WRITE.\n" +
  "- category: two or three words for what this video is, for example " +
  "Relatability, Car build, How to, Story time.\n" +
  "- overview: one short paragraph on what the video is doing and how well, " +
  "written to the creator as you.\n" +
  "- viewerValue: one or two sentences on what a viewer actually walks away with.\n" +
  "- whatWorked: 3 short lines, each naming a timestamp, for example showing the " +
  "car itself at 0:17 gave the claim something to land on.\n" +
  "- spinOffs: 3 follow up videos this one earns, each with a hook line the " +
  "creator can say out loud as written.\n\n" +
  "HOW YOU WRITE. Plain English a twelve year old reads without stopping. No " +
  "jargon, no hype, no marketing words. Never use an em dash, an en dash or an " +
  "arrow, use commas and full stops. Speak to the creator as you.";

/**
 * The stored shape minus the transcript, which the worker attaches itself, and
 * minus the peak score, which is arithmetic rather than judgement. No array
 * bounds: the model's structured output rejects minItems above 1 and maxItems
 * entirely, so counts are asked for in the prompt and enforced below.
 */
const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    scores: {
      type: "object",
      properties: {
        hook: { type: "number" },
        retention: { type: "number" },
        payoff: { type: "number" },
      },
      required: ["hook", "retention", "payoff"],
      additionalProperties: false,
    },
    category: { type: "string" },
    overview: { type: "string" },
    viewerValue: { type: "string" },
    whatWorked: { type: "array", items: { type: "string" } },
    moments: {
      type: "array",
      items: {
        type: "object",
        properties: {
          at: { type: "number" },
          kind: { type: "string", enum: ["strong", "risk"] },
          label: { type: "string" },
          detail: { type: "string" },
        },
        required: ["at", "kind", "label", "detail"],
        additionalProperties: false,
      },
    },
    actionPlan: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          why: { type: "string" },
          fix: { type: "string" },
        },
        required: ["title", "why", "fix"],
        additionalProperties: false,
      },
    },
    spinOffs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          idea: { type: "string" },
          hook: { type: "string" },
        },
        required: ["idea", "hook"],
        additionalProperties: false,
      },
    },
  },
  required: [
    "scores",
    "category",
    "overview",
    "viewerValue",
    "whatWorked",
    "moments",
    "actionPlan",
    "spinOffs",
  ],
  additionalProperties: false,
} as const;

interface ModelAnalysis {
  scores: { hook: number; retention: number; payoff: number };
  category: string;
  overview: string;
  viewerValue: string;
  whatWorked: string[];
  moments: Array<{ at: number; kind: string; label: string; detail: string }>;
  actionPlan: Array<{ title: string; why: string; fix: string }>;
  spinOffs: Array<{ idea: string; hook: string }>;
}

const clampScore = (n: unknown): number =>
  Math.min(100, Math.max(0, Math.round(Number(n) || 0)));

/**
 * The transcript as the analyst reads it: one line per segment with its range,
 * and the word timings under it so dead air and hook timing can be measured
 * rather than guessed. Long videos drop the word lines, because a wall of them
 * buys precision nobody uses and crowds out the frames.
 */
function transcriptForPrompt(segments: TranscriptSegment[]): string {
  if (!segments.length) {
    return "No speech was detected. Judge this one on the frames, and say so in the overview.";
  }
  const wordCount = segments.reduce((n, s) => n + (s.words?.length ?? 0), 0);
  const withWords = wordCount > 0 && wordCount <= 1500;
  return segments
    .map((s) => {
      const line = `[${s.start.toFixed(1)} to ${s.end.toFixed(1)}] ${s.text.trim()}`;
      if (!withWords || !s.words?.length) return line;
      const words = s.words.map((w) => `${w.word.trim()}@${w.start.toFixed(1)}`).join(" ");
      return `${line}\n    ${words}`;
    })
    .join("\n");
}

/**
 * One analyzer run: resolve the source, probe it, thumbnail it, transcribe it,
 * sample twelve frames, and put all of it in front of the model once. Failures
 * land on the row as a short sentence, because a spinning card with the reason
 * buried in worker logs helps nobody.
 */
export async function runAnalysis(analysisId: string): Promise<void> {
  const analysis = await prisma.videoAnalysis.findUnique({ where: { id: analysisId } });
  if (!analysis) return;

  const dir = path.join(env.STORAGE_DIR, analysis.clientId, "analysis", analysis.id);
  const framesDir = path.join(dir, "frames");

  try {
    if (!env.ANTHROPIC_API_KEY) {
      throw new Error(
        "scoring a video needs an Anthropic API key. Add ANTHROPIC_API_KEY to the repo .env and restart the worker.",
      );
    }

    let sourceKey = analysis.storageKey;
    if (!sourceKey && analysis.mediaAssetId) {
      const asset = await prisma.mediaAsset.findUnique({
        where: { id: analysis.mediaAssetId },
        select: { storageKey: true, sourceDeletedAt: true },
      });
      if (asset?.sourceDeletedAt) {
        throw new Error("that upload's file has already been cleared off the disk");
      }
      sourceKey = asset?.storageKey ?? null;
    }
    if (!sourceKey) throw new Error("analysis has no source file");

    const sourcePath = path.join(env.STORAGE_DIR, sourceKey);
    const meta = await probe(sourcePath);
    // Everything downstream is built off the runtime: where the frames come
    // from, what second each one is labelled, what the prompt says the video
    // runs, and the ceiling every moment is clamped to. A container with no
    // duration in its header (a browser recording, a fragmented MP4) probes as
    // 0 and would score twelve copies of the first fifth of a second as if
    // they were the whole video. Written as !(x > 0) so NaN fails it too.
    if (!(meta.durationSec > 0)) {
      throw new Error("that file's length could not be read, so it cannot be scored");
    }

    // Always the analysis's own directory, never beside the source: a
    // from-media source lives in the MediaAsset's directory, where thumb.jpg
    // is the pipeline's own thumbnail and the retention sweep deletes it.
    const thumbKey = `${analysis.clientId}/analysis/${analysis.id}/thumb.jpg`;
    await fs.mkdir(dir, { recursive: true });
    await extractThumbnail(
      sourcePath,
      path.join(env.STORAGE_DIR, thumbKey),
      Math.min(1, (meta.durationSec || 1) * 0.25),
    );

    const transcript = await transcribe(sourcePath);
    if (!transcript) {
      throw new Error("the transcription service did not answer, so there is nothing to read");
    }

    const frames = await sampleFrames(sourcePath, framesDir, FRAME_COUNT, meta.durationSec);
    if (!frames.length) throw new Error("no frames could be read out of that file");
    // Same spacing sampleFrames uses, so a frame's label is the second it came
    // from even when ffmpeg returns one fewer than asked.
    const frameTime = (i: number): number =>
      meta.durationSec * 0.02 + (i * (meta.durationSec * 0.96)) / Math.max(FRAME_COUNT - 1, 1);

    // What this brand is about, so the plan speaks their niche rather than
    // generic short form advice. Same grounding block every AI feature reads.
    const [client, notes, files] = await Promise.all([
      prisma.client.findUnique({
        where: { id: analysis.clientId },
        select: { name: true, nicheProfile: true },
      }),
      prisma.knowledgeNote.findMany({
        where: { clientId: analysis.clientId },
        orderBy: { createdAt: "desc" },
        take: 40,
        select: { title: true, body: true },
      }),
      prisma.knowledgeFile.findMany({
        where: { clientId: analysis.clientId, status: "ready" },
        orderBy: { createdAt: "desc" },
        take: 20,
        select: { name: true, extractedText: true },
      }),
    ]);
    const grounding = knowledgeContext({
      notes,
      files,
      nicheProfile: client?.nicheProfile ?? undefined,
    });

    const frameBlocks = await Promise.all(
      frames.map(async (file, i) => {
        const data = await fs.readFile(file);
        return [
          { type: "text" as const, text: `Frame ${i + 1}, at ${frameTime(i).toFixed(1)}s` },
          {
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: "image/jpeg" as const,
              data: data.toString("base64"),
            },
          },
        ];
      }),
    );

    const anthropic = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const response = await anthropic.messages.create({
      model: env.COPY_MODEL,
      // Room for the whole document plus the thinking that gets there. A
      // truncated answer is not partial output here, it is unparseable JSON.
      max_tokens: 8192,
      thinking: { type: "adaptive" },
      output_config: {
        effort: "medium",
        format: { type: "json_schema", schema: ANALYSIS_SCHEMA },
      },
      system: ANALYST_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text" as const,
              text:
                `Score this video for ${client?.name ?? "this brand"}. It runs ` +
                `${meta.durationSec.toFixed(1)} seconds.\n\n` +
                (grounding
                  ? `What we know about this brand and its niche. Use it to judge fit ` +
                    `and to write the plan, do not quote it back:\n${grounding}\n\n`
                  : "") +
                `Transcript, with word timings where they exist:\n${transcriptForPrompt(transcript.segments)}\n\n` +
                `Now ${frames.length} frames, evenly spaced across the runtime, each ` +
                `labelled with the second it came from.`,
            },
            ...frameBlocks.flat(),
          ],
        },
      ],
    });

    if (response.stop_reason === "refusal") throw new Error("the model declined this video");
    // Thinking and the document share max_tokens, so a long enough run of
    // thinking cuts the JSON off mid string. Saying so beats letting JSON.parse
    // put its own error on the card, which reads like a crash rather than
    // something a second run would fix.
    if (response.stop_reason === "max_tokens") {
      throw new Error("the analysis came back too long to read, run it again");
    }
    const text = response.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") throw new Error("the model returned an empty response");
    const parsed = JSON.parse(text.text) as ModelAnalysis;

    const hook = clampScore(parsed.scores?.hook);
    const retention = clampScore(parsed.scores?.retention);
    const payoff = clampScore(parsed.scores?.payoff);

    const moments = (parsed.moments ?? []).slice(0, 5).map((m) => ({
      at: Math.min(Math.max(Number(m.at) || 0, 0), meta.durationSec),
      kind: m.kind === "strong" ? ("strong" as const) : ("risk" as const),
      label: toPlainText(m.label),
      detail: toPlainText(m.detail),
    }));
    const actionPlan = (parsed.actionPlan ?? []).slice(0, 4).map((s) => ({
      title: toPlainText(s.title),
      why: toPlainText(s.why),
      fix: toPlainText(s.fix),
    }));
    // The screen draws four cards and a strip of two to five markers. Short of
    // that the answer is incomplete, and saying so beats rendering the gap.
    if (actionPlan.length < 4 || moments.length < 2) {
      throw new Error("the analysis came back incomplete, run it again");
    }

    const result = {
      // Recomputed rather than trusted: the weighting and the hook cap are the
      // rubric's arithmetic, and one place owns them. See packages/core.
      scores: { hook, retention, payoff, peak: peakScore(hook, retention, payoff) },
      category: toPlainText(parsed.category),
      overview: toPlainText(parsed.overview),
      viewerValue: toPlainText(parsed.viewerValue),
      whatWorked: (parsed.whatWorked ?? [])
        .slice(0, 3)
        .map((w) => toPlainText(w).trim())
        .filter(Boolean),
      moments,
      actionPlan,
      spinOffs: (parsed.spinOffs ?? []).slice(0, 3).map((s) => ({
        idea: toPlainText(s.idea),
        hook: toPlainText(s.hook),
      })),
      transcript: transcript.segments.map((s) => ({
        start: s.start,
        end: s.end,
        text: s.text.trim(),
      })),
    };

    await prisma.videoAnalysis.update({
      where: { id: analysis.id },
      data: {
        durationSec: meta.durationSec,
        thumbKey,
        status: "ready",
        result: result as unknown as Prisma.InputJsonValue,
        error: null,
        completedAt: new Date(),
      },
    });
    console.log(`[worker] analysis ${analysis.id} ready (peak ${result.scores.peak})`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[worker] analysis ${analysisId} failed:`, error);
    await prisma.videoAnalysis.update({
      where: { id: analysisId },
      data: { status: "failed", error: message.slice(0, 500), completedAt: new Date() },
    });
  } finally {
    // Cheap to regenerate, and the disk sweep does not know they exist.
    await fs.rm(framesDir, { recursive: true, force: true }).catch(() => {});
  }
}
