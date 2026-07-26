import type { PrismaClient } from "@toreroflow/db";

/**
 * Background failures the operator would otherwise never see.
 *
 * Scheduled work runs with nobody watching. A month-end republish that fails
 * at 3am reaches a log file and nothing else, so a client's page can sit
 * stale for weeks while every screen in the app looks healthy. Worse, the
 * operator keeps sending a link they believe is current.
 *
 * These functions are the other half of every background check: raise when it
 * fails, clear when it works. A check that only ever raises produces a list
 * nobody trusts, so clearing on success is not optional.
 */

export const ALERT_KINDS = {
  /** The publishing credential was rejected; nothing can be published. */
  publishAuth: "publish_auth",
  /** One client's page could not be refreshed for the new month. */
  reportPublish: "report_publish",
  /** One client's month-end PDF could not be built. */
  reportBuild: "report_build",
} as const;

export type AlertKind = (typeof ALERT_KINDS)[keyof typeof ALERT_KINDS];

export interface RaiseInput {
  agencyId: string;
  /** Stable per problem, so a repeat updates rather than stacks. */
  key: string;
  kind: AlertKind;
  message: string;
  severity?: "error" | "warning";
  clientId?: string | null;
  detail?: string | null;
}

/** Trim a thrown value to something worth storing next to the message. */
export function describeFailure(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.length > 500 ? `${raw.slice(0, 500)}…` : raw;
}

/**
 * Records that something failed, or that it failed again.
 *
 * A repeat bumps the count and the timestamp rather than creating a second
 * row. It also un-dismisses: acknowledging a problem says "I have seen this",
 * not "stop telling me", and a failure after that is new information.
 */
export async function raiseAlert(prisma: PrismaClient, input: RaiseInput): Promise<void> {
  const now = new Date();
  await prisma.systemAlert.upsert({
    where: { agencyId_key: { agencyId: input.agencyId, key: input.key } },
    create: {
      agencyId: input.agencyId,
      key: input.key,
      kind: input.kind,
      severity: input.severity ?? "error",
      clientId: input.clientId ?? null,
      message: input.message,
      detail: input.detail ?? null,
      firstSeenAt: now,
      lastSeenAt: now,
    },
    update: {
      kind: input.kind,
      severity: input.severity ?? "error",
      clientId: input.clientId ?? null,
      message: input.message,
      detail: input.detail ?? null,
      lastSeenAt: now,
      dismissedAt: null,
      count: { increment: 1 },
    },
  });
}

/**
 * Records that the thing works again.
 *
 * The row is deleted rather than marked resolved: this is a list of what is
 * broken now, and a problem that fixed itself should leave nothing behind to
 * explain away. The API log keeps the history.
 */
export async function clearAlert(
  prisma: PrismaClient,
  agencyId: string,
  key: string,
): Promise<void> {
  await prisma.systemAlert.deleteMany({ where: { agencyId, key } });
}

/** Every open alert for one agency, most recently seen first. */
export async function listAlerts(prisma: PrismaClient, agencyId: string) {
  return await prisma.systemAlert.findMany({
    where: { agencyId },
    orderBy: [{ severity: "asc" }, { lastSeenAt: "desc" }],
    include: { client: { select: { name: true } } },
  });
}

/** Key for a problem that concerns one client. */
export function clientAlertKey(kind: AlertKind, clientId: string): string {
  return `${kind}:${clientId}`;
}
