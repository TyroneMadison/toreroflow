import path from "node:path";
import fs from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import {
  captionLead,
  competitorBrief,
  digestCompetitor,
  isDuplicateIdea,
  toPlainText,
  type CompetitorDigest,
} from "@toreroflow/core";
import { getPrisma, groundingFor, Prisma } from "@toreroflow/db";
import { renderReportPdf } from "@toreroflow/media";
import { env } from "./env";

/**
 * The client's game plan: ask the model, print it as something sendable.
 *
 * This used to run inside `POST /clients/:id/suggestions`, holding the
 * request open for the whole model call and losing the result the moment the
 * modal closed. It lives here now so pressing Generate returns immediately
 * and the answer survives in `ClientInsight` plus a PDF on disk.
 *
 * The prompt, the schema, the model and the categories are unchanged from
 * the route: this moved when the work happens, not what it produces.
 */

const prisma = getPrisma();

const SUGGESTIONS_SCHEMA = {
  type: "object",
  properties: {
    suggestions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          detail: { type: "string" },
          category: {
            type: "string",
            enum: ["content", "timing", "platform", "growth", "setup"],
          },
        },
        required: ["title", "detail", "category"],
        additionalProperties: false,
      },
    },
    /**
     * What the researched accounts are doing that works.
     *
     * Empty when nothing has been researched. No length bounds: the model's
     * structured output rejects minItems above 1 and maxItems entirely, so
     * the count is asked for in the prompt instead.
     */
    competitorNotes: { type: "array", items: { type: "string" } },
    /**
     * Videos the plan implies, in the shape the Ideas list stores.
     *
     * The plan and the ideas list used to be strangers: the plan said make
     * more of what works, and the operator then went to a different screen and
     * asked a different model for ideas that knew nothing about it. These come
     * out of the same run, so what the plan advises is what lands in the list.
     */
    contentIdeas: {
      type: "array",
      items: {
        type: "object",
        properties: {
          text: { type: "string" },
          hook: { type: "string" },
        },
        required: ["text", "hook"],
        additionalProperties: false,
      },
    },
  },
  required: ["suggestions", "competitorNotes", "contentIdeas"],
  additionalProperties: false,
} as const;

export interface InsightSuggestion {
  title: string;
  detail: string;
  category: string;
}

/** One researched account as the PDF shows it. Numbers, never model prose. */
export interface CompetitorCard {
  handle: string;
  platform: string;
  typicalViews: number | null;
  bestViews: number | null;
  typicalSeconds: number | null;
  postsPerWeek: number | null;
  /** The single best post, so the page shows one concrete example. */
  bestOpening: string | null;
}

function competitorCards(digests: CompetitorDigest[]): CompetitorCard[] {
  return digests.map((d) => ({
    handle: d.handle,
    platform: d.platform,
    typicalViews: d.medianViews,
    bestViews: d.bestViews,
    typicalSeconds: d.typicalSeconds,
    postsPerWeek: d.postsPerWeek,
    bestOpening: d.top[0]?.caption ? toPlainText(captionLead(d.top[0].caption, 110)) : null,
  }));
}

/** Model call, unchanged from the route it came from. */
async function askForSuggestions(
  anthropic: Anthropic,
  client: {
    name: string;
    plan: string | null;
    socialAccounts: Array<{
      platform: string;
      handle: string;
      status: string;
      metricSnapshots: Array<{
        views: number | null;
        reach: number | null;
        followers: number | null;
        engagementRate: number | null;
        avgWatchSec: number | null;
        capturedAt: Date;
      }>;
    }>;
  },
  /** What the accounts this client wants to be like are actually posting. */
  competitors: CompetitorDigest[],
  /** The brand's own material, the same block every other AI feature reads. */
  grounding: string,
): Promise<{
  suggestions: InsightSuggestion[];
  competitorNotes: string[];
  contentIdeas: { text: string; hook: string }[];
}> {
  const accountSummary = client.socialAccounts.length
    ? client.socialAccounts
        .map((a) => {
          const latest = a.metricSnapshots[0];
          const metrics = latest
            ? `views=${latest.views ?? "?"} reach=${latest.reach ?? "?"} followers=${latest.followers ?? "?"} engagement=${latest.engagementRate ?? "?"}% avgWatch=${latest.avgWatchSec ?? "?"}s (captured ${latest.capturedAt.toISOString()})`
            : "no metrics captured yet";
          return `- ${a.platform} @${a.handle} [${a.status}]: ${metrics}`;
        })
        .join("\n")
    : "- no platforms connected yet";

  const brief = competitorBrief(competitors);

  const response = await anthropic.messages.create({
    model: env.COPY_MODEL,
    // Room for the steps and the competitor notes together. A truncated answer
    // is not partial output here, it is unparseable JSON and a failed run.
    max_tokens: 3072,
    thinking: { type: "adaptive" },
    output_config: {
      effort: "low",
      format: { type: "json_schema", schema: SUGGESTIONS_SCHEMA },
    },
    system:
      "You write a short game plan that is handed straight to the client. " +
      "Write to them, as 'you'. Never mention the agency, its tools, its " +
      "software, dashboards, analytics platforms, or how any of this was put " +
      "together. The client only ever sees the steps.\n\n" +
      "Rules for the writing:\n" +
      "- A sixth grader must understand every sentence. Short words, short " +
      "sentences, no marketing or industry jargon.\n" +
      "- Use as few words as possible. Two or three sentences per step, and " +
      "cut any word that is not doing work.\n" +
      "- Never use an em dash, an en dash, or an arrow of any kind. Use " +
      "commas, full stops and the word 'to'.\n" +
      "- No metric names the client would not recognise. Say 'how long people " +
      "watch' rather than 'average watch time', 'people who follow you' " +
      "rather than 'follower count'.\n" +
      "- Every step is something they can actually do themselves this week. " +
      "Say what to do, then why it helps, in plain terms.\n\n" +
      "Give 4 to 6 steps, in the order they should be done.\n\n" +
      "You may also be given what the accounts this person said they want to " +
      "be like are posting right now. When you are:\n" +
      "- Build the steps on it. A step that copies something already working " +
      "for those accounts beats a general tip every time.\n" +
      "- Name the account when it helps, the way they would: 'that account " +
      "posts about 20 times a week' becomes better as '@their_handle posts " +
      "about 20 times a week'. They chose these accounts, so they know who " +
      "they are.\n" +
      "- Use only numbers you were given. Never invent one, and never round a " +
      "number up to sound better.\n" +
      "- Also fill competitorNotes with 2 to 4 short observations about what " +
      "those accounts do that works: how long their videos are, how often " +
      "they post, how they open, what their best post did. One or two " +
      "sentences each, same plain language as the steps, written to the " +
      "client as 'you' or about the account by name.\n" +
      "When you are given nothing about those accounts, return an empty " +
      "competitorNotes list and do not mention them at all.\n\n" +
      "Last, fill contentIdeas with 3 to 5 videos this plan is asking them to " +
      "make. These are saved to their ideas list, so each one has to stand on " +
      "its own away from this page:\n" +
      "- text is one plain sentence saying what the video is.\n" +
      "- hook is its first line, said out loud, six to fifteen words. It has " +
      "to be specific to this brand. A hook that would fit any account is a " +
      "wasted hook.\n" +
      "- Every idea has to come from a step above or from what those accounts " +
      "are doing. Do not invent a direction the plan does not support.\n" +
      "- Use the brand's own material below. Do not invent facts, numbers, " +
      "prices or claims that are not in it.\n" +
      "- That material lists the ideas this brand already has under 'Open " +
      "ideas'. Do not write any of those again, and do not write one of them " +
      "again in different words. Every idea you return has to be new to that " +
      "list.\n" +
      "- No hashtags, no emoji, no all caps.",
    messages: [
      {
        role: "user",
        content:
          `Write the game plan for ${client.name}.\n\n` +
          `Here is what their accounts look like right now. This is background ` +
          `for you, do not quote it back at them or mention where it came from:\n` +
          `${accountSummary}\n\n` +
          `They make short vertical videos for Instagram, TikTok, YouTube, ` +
          `Facebook and Snapchat.` +
          (brief
            ? `\n\nThese are the accounts they said they want their content to ` +
              `be like, and what those accounts have been posting. Every number ` +
              `here is measured, so use them as they are:\n${brief}`
            : "") +
          (grounding
            ? `\n\nWhat we know about this brand and its niche. Use it to write ` +
              `the steps and the ideas, do not quote it back:\n${grounding}`
            : ""),
      },
    ],
  });

  if (response.stop_reason === "refusal") throw new Error("the model declined the request");
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("the model returned an empty response");
  const parsed = JSON.parse(text.text) as {
    suggestions: InsightSuggestion[];
    competitorNotes?: string[];
    contentIdeas?: { text: string; hook: string }[];
  };
  // The prompt asks for plain punctuation, but asking is not enforcing, and
  // this document goes to a paying client. See packages/core/src/plainText.ts.
  return {
    suggestions: parsed.suggestions.map((s) => ({
      title: toPlainText(s.title),
      detail: toPlainText(s.detail),
      category: toPlainText(s.category),
    })),
    competitorNotes: (parsed.competitorNotes ?? [])
      .map((n) => toPlainText(n).trim())
      .filter(Boolean),
    contentIdeas: (parsed.contentIdeas ?? [])
      .slice(0, 5)
      .map((i) => ({ text: toPlainText(i.text).trim(), hook: toPlainText(i.hook).trim() }))
      .filter((i) => i.text),
  };
}

/**
 * Runs one client's insight job and writes the outcome to its row.
 *
 * Never throws for a reason the operator should read. A failure is stored on
 * the row so reopening the modal says what went wrong, rather than leaving a
 * `running` row spinning forever with the reason buried in worker logs.
 */
export async function generateInsight(clientId: string): Promise<void> {
  const anthropic = env.ANTHROPIC_API_KEY
    ? new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })
    : null;

  const fail = async (message: string): Promise<void> => {
    await prisma.clientInsight.updateMany({
      where: { clientId },
      data: { status: "failed", error: message, completedAt: new Date() },
    });
    console.error(`[worker] insight failed for ${clientId}: ${message}`);
  };

  try {
    if (!anthropic) {
      await fail(
        "AI suggestions need an Anthropic API key. Add ANTHROPIC_API_KEY to the repo .env and restart the worker.",
      );
      return;
    }

    const client = await prisma.client.findFirst({
      where: { id: clientId, deletedAt: null },
      include: {
        socialAccounts: {
          where: { deletedAt: null },
          include: { metricSnapshots: { orderBy: { capturedAt: "desc" }, take: 14 } },
        },
      },
    });
    if (!client) {
      await fail("that brand no longer exists");
      return;
    }

    // The registered company signs the page where there is one. This is a
    // document handed to a paying client, so it names the entity, not just
    // the brand.
    const agency = await prisma.agency.findUnique({
      where: { id: client.agencyId },
      select: { name: true, legalName: true },
    });
    const businessName = agency?.legalName ?? agency?.name ?? "Torerone";

    /*
     * The accounts this client wants to be like, as of right now.
     *
     * Read fresh on every run rather than stored with the plan, so adding an
     * account and researching it is enough to make the next Generate reflect
     * it. Only the newest snapshot per account is used: research costs money
     * and older pulls of the same account describe the same person less well.
     *
     * An account with nothing pulled yet contributes nothing rather than a row
     * of blanks. Researching is a separate press with a price on it, and the
     * document should never imply a fetch happened when it did not.
     */
    const inspirations = await prisma.inspirationAccount.findMany({
      where: { clientId: client.id },
      orderBy: { handle: "asc" },
      include: { snapshots: { orderBy: { fetchedAt: "desc" }, take: 1 } },
    });
    const competitors = inspirations
      .map((a) =>
        a.snapshots[0]
          ? digestCompetitor({ platform: a.platform, handle: a.handle, raw: a.snapshots[0].raw })
          : null,
      )
      .filter((d): d is CompetitorDigest => d !== null);

    const { suggestions, competitorNotes, contentIdeas } = await askForSuggestions(
      anthropic,
      client,
      competitors,
      await groundingFor(prisma, clientId),
    );

    // The plan's ideas land in the same list the Ideas screen reads, tagged
    // with where they came from. Deduped against what is already there, since
    // this job re-runs whenever the operator presses Generate again and the
    // model has no memory of the last plan it wrote.
    if (contentIdeas.length) {
      const existing = await prisma.contentIdea.findMany({
        where: { clientId },
        select: { text: true },
      });
      // Comparing the text exactly is not enough: a re-run reliably returns
      // the same idea a word or two different, which an exact match lets
      // straight through. See packages/core/src/ideaDedup.ts for what this
      // does and does not catch.
      const seen = existing.map((i) => i.text);
      const fresh: typeof contentIdeas = [];
      for (const idea of contentIdeas) {
        if (isDuplicateIdea(idea.text, seen)) continue;
        // Against this batch too, so one run cannot add two of its own.
        seen.push(idea.text);
        fresh.push(idea);
      }
      if (fresh.length) {
        await prisma.contentIdea.createMany({
          data: fresh.map((i) => ({
            clientId,
            text: i.text,
            hook: i.hook || null,
            source: "overview",
            niche: "",
          })),
        });
      }
      console.log(
        `[worker] insight ideas for ${client.name}: ${fresh.length} added, ${contentIdeas.length - fresh.length} already there`,
      );
    }

    const now = new Date();
    // Date only. A timestamp reading "2:25 AM" on a client's document says
    // a machine made it at 2am, which is exactly the impression to avoid.
    const generatedLabel = now.toLocaleDateString("en-US", {
      month: "long",
      day: "numeric",
      year: "numeric",
    });
    const templatePath = path.join(env.REPO_ROOT, "assets", "insights-template.html");
    const template = await fs.readFile(templatePath, "utf8");
    const pdf = await renderReportPdf(template, {
      clientName: client.name,
      businessName,
      generatedLabel,
      suggestions,
      competitorNotes,
      competitors: competitorCards(competitors),
    });

    // Its own folder, not `reports/`: this is a document Tyrone hands over
    // directly, while `reports/` is what the Netlify publisher sweeps onto
    // the public web. Two different ways of reaching a client, kept apart.
    //
    // One fixed name, overwritten per run, because only the latest plan is
    // ever referenced. A dated name left every superseded plan on disk
    // forever with nothing pointing at it. The date the client cares about
    // is printed on the page itself.
    const storageKey = `${client.id}/insights/what-to-do-next.pdf`;
    const absPath = path.join(env.STORAGE_DIR, storageKey);
    const dir = path.dirname(absPath);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(absPath, pdf);

    // Writing the same name replaces the previous plan, but an earlier build
    // dated the file, so a machine that ran that version still has plans
    // nothing points at. Only this function writes here, and only ever one
    // PDF, so anything else in the folder is superseded by what was just
    // written. Scoped to .pdf so a stray file is never swept up with them.
    for (const name of await fs.readdir(dir)) {
      if (name !== path.basename(absPath) && name.toLowerCase().endsWith(".pdf")) {
        await fs.rm(path.join(dir, name), { force: true });
      }
    }

    await prisma.clientInsight.updateMany({
      where: { clientId },
      data: {
        status: "ready",
        suggestions: suggestions as unknown as Prisma.InputJsonValue,
        storageKey,
        error: null,
        completedAt: now,
      },
    });
    console.log(`[worker] insight ready for ${client.name}: ${suggestions.length} suggestions`);
  } catch (err) {
    await fail(err instanceof Error ? err.message : String(err));
  }
}
