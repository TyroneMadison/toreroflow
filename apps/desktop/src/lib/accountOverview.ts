import { isReady, isRunning } from "@toreroflow/core";
import type { OverviewClient } from "./api";

export type Tone = "bad" | "warn" | "ok";
export type Step = { label: string; tone: Tone; detail: string };

/** The five steps every brand moves through each month, each red, amber or green. */
export function pipeline(c: OverviewClient): Step[] {
  const connected = c.platforms.filter((p) => p.status === "connected").length;
  const plan = c.insight?.status;
  return [
    {
      label: "Connected",
      tone: c.needsReconnect ? "bad" : connected === 0 ? "warn" : "ok",
      detail: c.needsReconnect ? "a platform dropped its authorisation" : `${connected} platform${connected === 1 ? "" : "s"}`,
    },
    {
      label: "Plan",
      tone: plan === "failed" ? "bad" : isReady(plan) ? "ok" : "warn",
      detail: plan === "failed" ? "did not finish" : isRunning(plan) ? "being written" : isReady(plan) ? "ready" : "none yet",
    },
    {
      label: "Posting",
      tone: c.lastPostAt === null ? "warn" : (c.daysQuiet ?? 0) >= 14 ? "bad" : (c.daysQuiet ?? 0) >= 7 ? "warn" : "ok",
      detail: c.lastPostAt === null ? "nothing published" : `last ${c.daysQuiet ?? 0}d ago`,
    },
    {
      label: "Delivered",
      tone: !c.delivery ? "ok" : c.delivery.behindBy > 0 ? "warn" : "ok",
      detail: !c.delivery ? "no quota" : c.delivery.behindBy > 0 ? `${c.delivery.behindBy} behind` : "on quota",
    },
    {
      label: "Report",
      tone: c.report.stale ? "bad" : c.report.built && !c.report.opened ? "warn" : c.report.url ? "ok" : "warn",
      detail: c.report.stale ? "out of date" : c.report.url ? "published" : "not published",
    },
  ];
}

const STATUS = { bad: "Needs you", warn: "Behind", ok: "On track" } as const;
const RANK: Record<Tone, number> = { bad: 0, warn: 1, ok: 2 };

/** Where the brand stands: its worst pipeline step decides the pill. */
export function status(c: OverviewClient, steps = pipeline(c)): { word: (typeof STATUS)[Tone]; tone: Tone } {
  const tone: Tone = steps.some((s) => s.tone === "bad") ? "bad" : steps.some((s) => s.tone === "warn") ? "warn" : "ok";
  return { word: STATUS[tone], tone };
}

/** The one line under a brand's name in the list: its worst step, or that all is well. */
export function reason(c: OverviewClient, steps = pipeline(c)): string {
  const worst = steps.find((s) => s.tone === "bad") ?? steps.find((s) => s.tone === "warn");
  if (!worst) return `All ${steps.length} steps on track`;
  return `${worst.label}: ${worst.detail}`;
}

/** Needs you, then behind, then on track; the API's attention score breaks ties. */
export function byUrgency(clients: OverviewClient[]): OverviewClient[] {
  return [...clients].sort((a, b) => RANK[status(a).tone] - RANK[status(b).tone] || b.attention - a.attention);
}

/** One sentence for the profile panel, from the same data the tiles show. */
export function summary(c: OverviewClient): string {
  const posted = c.lastPostAt === null ? "Nothing posted yet" : c.daysQuiet === 0 ? "Posted today" : `Posted ${c.daysQuiet}d ago`;
  const plan = c.insight?.status;
  const p = isReady(plan) ? "plan ready" : isRunning(plan) ? "plan being written" : plan === "failed" ? "plan did not finish" : "no plan yet";
  return `${posted}, ${p}.`;
}
