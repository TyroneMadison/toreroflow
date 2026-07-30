import path from "node:path";
import fs from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { toPlainText } from "@toreroflow/core";
import { getPrisma, Prisma } from "@toreroflow/db";
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
  },
  required: ["suggestions"],
  additionalProperties: false,
} as const;

export interface InsightSuggestion {
  title: string;
  detail: string;
  category: string;
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
): Promise<InsightSuggestion[]> {
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

  const response = await anthropic.messages.create({
    model: env.COPY_MODEL,
    max_tokens: 2048,
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
      "Give 4 to 6 steps, in the order they should be done.",
    messages: [
      {
        role: "user",
        content:
          `Write the game plan for ${client.name}.\n\n` +
          `Here is what their accounts look like right now. This is background ` +
          `for you, do not quote it back at them or mention where it came from:\n` +
          `${accountSummary}\n\n` +
          `They make short vertical videos for Instagram, TikTok, YouTube, ` +
          `Facebook and Snapchat.`,
      },
    ],
  });

  if (response.stop_reason === "refusal") throw new Error("the model declined the request");
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("the model returned an empty response");
  const parsed = JSON.parse(text.text) as { suggestions: InsightSuggestion[] };
  // The prompt asks for plain punctuation, but asking is not enforcing, and
  // this document goes to a paying client. See packages/core/src/plainText.ts.
  return parsed.suggestions.map((s) => ({
    title: toPlainText(s.title),
    detail: toPlainText(s.detail),
    category: toPlainText(s.category),
  }));
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

    const suggestions = await askForSuggestions(anthropic, client);

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
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, pdf);

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
