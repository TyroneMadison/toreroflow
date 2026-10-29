import fs from "node:fs/promises";
import { Prisma, enqueue, getPrisma } from "@toreroflow/db";
import {
  clipText,
  dedupeClips,
  lengthTargets,
  rangesDuration,
  rankClips,
  sentences,
  sentenceSpan,
  snapRanges,
  targetClipCount,
  type Range,
  type ClipSentence,
  type Word,
  transcriptSuspect,
  tuningPrompt,
  visualFeatures,
  applyVisual,
  trendScore,
  blendTrend,
  type ScoreWeights,
} from "@toreroflow/core";
import { assetWords, clientLanguageHint, processEditAsset, reframeAsset, reframeStatusPath } from "../edit";
import { curate, judge, resolveProvider } from "./provider";
import { clientTrends, refreshJudgeTuning, sourceFrames } from "./smart";

const prisma = getPrisma();

export interface ClipJobOptions {
  length?: string;
  genre?: string;
  prompt?: string;
  keywords?: string[];
  aspect?: string;
  range?: [number, number];
  language?: string;
  reframe?: boolean;
  provider?: string;
  log?: { at: string; line: string }[];
}

export type ClipStage = "analyze" | "curate" | "score" | "refine" | "rescore";
export interface ClipQueueData {
  clipJobId: string;
  stage: ClipStage;
  start?: number;
  end?: number;
  prompt?: string;
  candidateId?: string;
}

async function loadJob(id: string) {
  return prisma.clipJob.findUnique({ where: { id }, include: { source: true } });
}

/** Appends one stage-log line and optionally moves status/pct. */
async function step(jobId: string, line: string, data: { status?: string; pct?: number } = {}): Promise<void> {
  const job = await prisma.clipJob.findUnique({ where: { id: jobId }, select: { options: true } });
  const opts = ((job?.options ?? {}) as ClipJobOptions) || {};
  const log = [...(opts.log ?? []), { at: new Date().toISOString(), line }].slice(-60);
  await prisma.clipJob.update({
    where: { id: jobId },
    data: { stage: line, options: { ...opts, log } as unknown as Prisma.InputJsonValue, ...data },
  });
  console.log(`[worker] clip job ${jobId}: ${line}`);
}

async function sourceSentences(job: NonNullable<Awaited<ReturnType<typeof loadJob>>>): Promise<{ words: Word[]; ss: ClipSentence[] }> {
  const all = await assetWords(job.source);
  const opts = (job.options ?? {}) as ClipJobOptions;
  const [lo, hi] = opts.range ?? [0, Infinity];
  const words = all.filter((w) => w.start >= lo && w.end <= hi);
  return { words, ss: sentences(words) };
}

/** Transcribe (editor pipeline), then scenes + faces (auto reframe). */
async function analyze(jobId: string): Promise<void> {
  let job = await loadJob(jobId);
  if (!job) return;
  const opts = (job.options ?? {}) as ClipJobOptions;
  // A source that came back "ready" with no words (the captions service was
  // down) is processed again on retry rather than failing on the empty words.
  const noWords = job.source.status === "ready" && !(await assetWords(job.source)).length;
  // Phase 9: a retry never reuses a transcript in the wrong language. The
  // job's own language option wins; a weak (or, before Phase 9, unscored)
  // guess that disagrees with the client's usual language is redone with
  // that language set.
  let relang: string | null = null;
  if (job.source.status === "ready" && !noWords) {
    if (opts.language && opts.language !== job.source.language) relang = opts.language;
    else if (!opts.language) {
      const hint = await clientLanguageHint(job.clientId, job.sourceAssetId);
      if (transcriptSuspect(job.source, hint)) relang = hint;
    }
    if (relang) {
      await step(jobId, `language ${job.source.language ?? "?"} looks wrong, transcribing again as ${relang}`);
      await prisma.editAsset.update({ where: { id: job.sourceAssetId }, data: { language: relang, languageSource: "set", languageProb: null } });
    }
  }
  if (job.source.status !== "ready" || !job.source.stripKey || noWords || relang) {
    await step(jobId, "transcribe", { status: "transcribing", pct: 10 });
    await processEditAsset(job.sourceAssetId);
    job = (await loadJob(jobId))!;
  }
  if (job.source.status !== "ready") throw new Error("the source could not be processed");
  const words = await assetWords(job.source);
  if (!words.length) throw new Error(job.source.error ?? "no speech found in the source");
  const ls = job.source.languageSource;
  const lp = job.source.languageProb;
  const how = ls === "fallback" ? ` (fallback, detection ${lp != null ? Math.round(lp * 100) + "%" : "weak"})` : ls === "set" ? " (set)" : lp != null ? ` (${Math.round(lp * 100)}%)` : "";
  await step(jobId, `${job.source.language ?? "?"}${how} · ${words.length} words`, { status: "analyzing", pct: 35 });
  if (opts.reframe !== false && (job.source.durationSec ?? 0) > 1800) {
    // Same ceiling the editor's Auto reframe button has: /faces samples the
    // whole file inside one request.
    await step(jobId, "reframe skipped: sources over 30 min open center-framed", { pct: 50 });
  } else if (opts.reframe !== false) {
    // A failed reframe costs the framing, never the job: clips still seed.
    try {
      await reframeAsset(job.sourceAssetId);
      const st = JSON.parse(await fs.readFile(reframeStatusPath(job.source.storageKey, job.source.id), "utf8"));
      await step(jobId, `scenes + faces: ${st.shots?.length ?? 0} shots`, { pct: 50 });
    } catch (err) {
      await step(jobId, `reframe skipped: ${(err as Error).message.slice(0, 160)}`, { pct: 50 });
    }
  }
  await enqueue("clips", { clipJobId: jobId, stage: "curate" }, { key: `clips-curate-${jobId}-${Date.now()}` });
}

/** Curate the whole source (or a refine span). Replaces prior curate rows. */
async function runCurate(jobId: string, refine?: { start: number; end: number; prompt?: string }): Promise<void> {
  const job = await loadJob(jobId);
  if (!job) return;
  const opts = (job.options ?? {}) as ClipJobOptions;
  const { provider, note } = resolveProvider();
  if (note) await step(jobId, note);
  await step(jobId, refine ? `refine ${Math.round(refine.start)}-${Math.round(refine.end)}s (${provider})` : `curate (${provider})`, {
    status: "curating",
    pct: refine ? undefined : 60,
  });
  const { words, ss } = await sourceSentences(job);
  const duration = job.source.durationSec ?? (words.length ? words[words.length - 1].end : 0);
  const span = refine ? sentenceSpan(ss, refine.start, refine.end) : null;
  if (refine && !span) throw new Error("no speech in that range");
  const targets = lengthTargets(opts.length);
  const prompt = refine?.prompt ?? opts.prompt;
  const scopeSec = refine ? refine.end - refine.start : opts.range ? opts.range[1] - opts.range[0] : duration;
  const drafts = await curate(
    provider,
    ss,
    duration,
    targets,
    {
      prompt,
      keywords: opts.keywords,
      genre: opts.genre,
      ...(span ?? {}),
      count: refine ? Math.max(2, Math.round(scopeSec / 45)) : targetClipCount(scopeSec),
    },
    (l) => step(jobId, l),
  );
  const snapped = drafts
    .map((d) => ({ ...d, ranges: snapRanges(d.ranges, words, duration) as Range[] }))
    .filter((d) => d.ranges.length > 0);
  const existing = refine
    ? (await prisma.clipCandidate.findMany({ where: { jobId }, select: { ranges: true, lengthTarget: true } })).map((c) => ({
        ranges: c.ranges as unknown as Range[],
        lengthTarget: c.lengthTarget,
        old: true,
      }))
    : [];
  type Row = { ranges: Range[]; lengthTarget: string; draft?: (typeof snapped)[number] };
  const rows: Row[] = [...existing.map((e) => ({ ranges: e.ranges, lengthTarget: e.lengthTarget })), ...snapped.map((d) => ({ ranges: d.ranges, lengthTarget: d.lengthTarget, draft: d }))];
  const kept = dedupeClips(rows).flatMap((r) => (r.draft ? [r.draft] : []));
  const dropped = snapped.length - kept.length;
  await prisma.$transaction([
    ...(refine ? [] : [prisma.clipCandidate.deleteMany({ where: { jobId, origin: "curate" } })]),
    prisma.clipCandidate.createMany({
      data: kept.map((d) => ({
        jobId,
        ranges: d.ranges as unknown as Prisma.InputJsonValue,
        duration: Math.round(rangesDuration(d.ranges) * 100) / 100,
        lengthTarget: d.lengthTarget,
        title: d.title,
        why: d.why,
        description: d.description,
        hashtags: d.hashtags,
        text: clipText(d.ranges, words),
        origin: refine ? "refine" : "curate",
      })),
    }),
  ]);
  const byTarget = targets.map((t) => kept.filter((k) => k.lengthTarget === t.key).length).join(" + ");
  await step(jobId, `curated ${byTarget}${dropped ? ` · dropped ${dropped} near-duplicates` : ""}`);
  await enqueue("clips", { clipJobId: jobId, stage: "score" }, { key: `clips-score-${jobId}-${Date.now()}` });
}

/** Judge unscored candidates (or one), then re-rank the whole job. */
async function runScore(jobId: string, only?: string): Promise<void> {
  const job = await loadJob(jobId);
  if (!job) return;
  const opts = (job.options ?? {}) as ClipJobOptions;
  const { provider } = resolveProvider();
  await step(jobId, only ? "rescore" : `score (${provider})`, { status: "scoring", pct: only ? undefined : 80 });
  const { ss } = await sourceSentences(job);
  const all = await prisma.clipCandidate.findMany({ where: { jobId }, orderBy: { createdAt: "asc" } });
  // The heuristic judge spreads scores across the batch, so it always sees
  // every candidate; a model judges only what it has to.
  const toJudge =
    provider === "heuristic" ? all : all.filter((c) => (only ? c.id === only : c.raw === 0 && c.hook === 0));
  const target = only ? all.filter((c) => c.id === only) : toJudge;
  // Phase 9: the client's taste, trend terms and the source's frames.
  const tuning = await refreshJudgeTuning(job.clientId);
  const trends = await clientTrends(job.clientId);
  const frames = await sourceFrames(job.source);
  if (!only) {
    await step(
      jobId,
      `smart: ${trends?.terms.length ?? 0} trend terms · ${frames.cuts.length} cuts, ${frames.track ? "faces sampled" : "no face samples"} · rubric ${tuning.n >= 3 ? `tuned on ${tuning.n}` : "even"}`,
    );
  }
  if (toJudge.length) {
    const raw = await judge(
      provider,
      toJudge.map((c) => ({ ranges: c.ranges as unknown as Range[], text: c.text ?? "", title: c.title })),
      ss,
      opts.prompt,
      (l) => step(jobId, l),
      tuningPrompt(tuning),
    );
    const haveTerms = !!trends?.terms.length;
    const judged = raw.map((j, i) => {
      const c = toJudge[i];
      const ranges = c.ranges as unknown as Range[];
      const v = visualFeatures(ranges, frames.cuts, frames.track);
      const t = trendScore(`${c.title} ${c.text ?? ""}`, trends?.terms ?? []);
      const withV = applyVisual({ ...j, comments: (j.comments ?? {}) as Record<string, string> }, v);
      return {
        ...withV,
        visual: v.visual,
        trend: blendTrend(withV.trend, t, haveTerms),
        comments: {
          ...withV.comments,
          ...(haveTerms ? { trend: t.hits.length ? `Rides ${t.hits.join(", ")}.` : `${withV.comments.trend ?? ""} No client trend terms.`.trim() } : {}),
        },
      };
    });
    const ids = new Set(target.map((t) => t.id));
    await prisma.$transaction(
      toJudge
        .map((c, i) => ({ c, j: judged[i] }))
        .filter(({ c }) => provider !== "heuristic" || ids.has(c.id) || !only)
        .map(({ c, j }) =>
          prisma.clipCandidate.update({
            where: { id: c.id },
            data: {
              hook: j.hook,
              flow: j.flow,
              value: j.value,
              trend: j.trend,
              visual: j.visual,
              relevance: j.relevance,
              comments: j.comments as unknown as Prisma.InputJsonValue,
            },
          }),
        ),
    );
  }
  await rerank(jobId, !!opts.prompt, tuning.n >= 3 ? tuning.weights : null);
  const n = await prisma.clipCandidate.count({ where: { jobId } });
  await step(jobId, `ready · ${n} clips`, { status: "ready", pct: 100 });
}

export async function rerank(jobId: string, hasPrompt: boolean, weights?: ScoreWeights | null): Promise<void> {
  const rows = await prisma.clipCandidate.findMany({ where: { jobId }, orderBy: { createdAt: "asc" } });
  const ranked = rankClips(rows, hasPrompt, weights);
  await prisma.$transaction(
    ranked.map((r) =>
      prisma.clipCandidate.update({ where: { id: r.item.id }, data: { raw: r.raw, rank: r.rank, score: r.score } }),
    ),
  );
}

/**
 * One queue, one stage per job. Every stage is safe to rerun: analyze reuses
 * a processed source, curate replaces its own rows, score re-ranks the lot.
 */
export async function runClipStage(data: ClipQueueData): Promise<void> {
  try {
    if (data.stage === "analyze") await analyze(data.clipJobId);
    else if (data.stage === "curate") await runCurate(data.clipJobId);
    else if (data.stage === "refine" && data.start !== undefined && data.end !== undefined)
      await runCurate(data.clipJobId, { start: data.start, end: data.end, prompt: data.prompt });
    else if (data.stage === "score") await runScore(data.clipJobId);
    else if (data.stage === "rescore") await runScore(data.clipJobId, data.candidateId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[worker] clip job ${data.clipJobId} ${data.stage} failed:`, err);
    await prisma.clipJob
      .update({ where: { id: data.clipJobId }, data: { status: "failed", error: `${data.stage}: ${msg}`.slice(0, 500) } })
      .catch(() => {});
    throw err;
  }
}
