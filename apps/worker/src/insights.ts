import path from "node:path";
import fs from "node:fs/promises";
import Anthropic from "@anthropic-ai/sdk";
import { getPrisma, Prisma } from "@toreroflow/db";
import { renderReportPdf } from "@toreroflow/media";
import { env } from "./env";

/**
 * "What to do next" for one client: ask the model, print the answer.
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
    workflows: unknown[];
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
      "You are a short-form video growth strategist for a social media agency. " +
      "Give specific, actionable suggestions to improve a client's social analytics. " +
      "When there is no metrics history yet, focus on the highest-leverage setup and " +
      "early-growth moves for their connected platforms. 4 to 6 suggestions, each " +
      "concrete enough to act on this week. No fluff.",
    messages: [
      {
        role: "user",
        content:
          `Client: ${client.name} (plan: ${client.plan ?? "unknown"})\n` +
          `Connected accounts:\n${accountSummary}\n` +
          `Repost workflows configured: ${client.workflows.length}\n` +
          `Agency context: short-form video (Reels/TikTok/Shorts/Spotlight), operator manages posting and analytics via Toreroflow.`,
      },
    ],
  });

  if (response.stop_reason === "refusal") throw new Error("the model declined the request");
  const text = response.content.find((b) => b.type === "text");
  if (!text || text.type !== "text") throw new Error("the model returned an empty response");
  const parsed = JSON.parse(text.text) as { suggestions: InsightSuggestion[] };
  return parsed.suggestions;
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
        workflows: true,
      },
    });
    if (!client) {
      await fail("that brand no longer exists");
      return;
    }

    const suggestions = await askForSuggestions(anthropic, client);

    const now = new Date();
    const generatedLabel = now.toLocaleString("en-US", {
      dateStyle: "long",
      timeStyle: "short",
    });
    const templatePath = path.join(env.REPO_ROOT, "assets", "insights-template.html");
    const template = await fs.readFile(templatePath, "utf8");
    const pdf = await renderReportPdf(template, {
      clientName: client.name,
      generatedLabel,
      suggestions,
    });

    // Kept out of `reports/` on purpose: these are internal notes about a
    // client's weaknesses, and the report folder is the one that gets
    // published to the public web.
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    const storageKey = `${client.id}/insights/what-to-do-next-${stamp}.pdf`;
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
