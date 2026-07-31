import { buildReminder, daysUntilFiling, filingReminderFor } from "@toreroflow/core";
import { getPrisma } from "@toreroflow/db";

/**
 * The yearly nudge to file the LLC's annual paperwork with the State.
 *
 * Runs daily and says nothing on all but five days of the year. Everything
 * else in this app reminds the operator about something they did; this is the
 * only deadline that arrives on its own, and missing it costs penalties and
 * can dissolve the company, so it is worth a job of its own.
 *
 * Deliberately one-directional: it raises, and never clears. An operator who
 * connects a bank in June must not have April's warning quietly deleted
 * because the gate happened to be open on a day with nothing to say, and a
 * reminder the operator dismissed is theirs to have dismissed.
 */

const prisma = getPrisma();

export async function checkFilingReminders(today = new Date()): Promise<void> {
  const agencies = await prisma.agency.findMany({
    select: { id: true, taxState: true, filingStatus: true },
  });

  for (const agency of agencies) {
    // "Set up" means the app knows enough for the date to be about them: a
    // state to file in, and a bank saying the business is really running here.
    const taxDetailsSet = Boolean(agency.taxState) && Boolean(agency.filingStatus);
    const bankConnected =
      (await prisma.bankConnection.count({ where: { agencyId: agency.id } })) > 0;

    const reminder = filingReminderFor({ today, taxDetailsSet, bankConnected });
    if (!reminder) continue;

    await raise(agency.id, reminder);
  }
}

/**
 * Raises this year's reminder for one agency regardless of the date or the
 * gate, for an operator who wants it in front of them now rather than in April.
 */
export async function raiseFilingReminderNow(agencyId: string, today = new Date()): Promise<void> {
  const daysLeft = daysUntilFiling(today);
  // A deadline already past this year is next year's deadline.
  const year = daysLeft < 0 ? today.getFullYear() + 1 : today.getFullYear();
  await raise(agencyId, buildReminder(year, daysLeft < 0 ? daysUntilNext(today) : daysLeft));
}

/** Days to next year's deadline, once this year's has gone. */
function daysUntilNext(today: Date): number {
  const next = new Date(today.getFullYear() + 1, 4, 1);
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  return Math.round((next.getTime() - start.getTime()) / 86_400_000);
}

async function raise(
  agencyId: string,
  reminder: { key: string; severity: "warning" | "error"; message: string; detail: string },
): Promise<void> {
  const now = new Date();
  await prisma.systemAlert.upsert({
    where: { agencyId_key: { agencyId, key: reminder.key } },
    create: {
      agencyId,
      key: reminder.key,
      kind: "llc_filing",
      severity: reminder.severity,
      message: reminder.message,
      detail: reminder.detail,
      firstSeenAt: now,
      lastSeenAt: now,
    },
    update: {
      severity: reminder.severity,
      message: reminder.message,
      detail: reminder.detail,
      lastSeenAt: now,
      // Un-dismissed on purpose. Each escalation is a new thing to say, and
      // "I have seen this" in April does not mean "stop telling me" on the
      // day it is due.
      dismissedAt: null,
      count: { increment: 1 },
    },
  });
  console.log(`[worker] LLC filing reminder raised for ${agencyId}: ${reminder.message}`);
}
