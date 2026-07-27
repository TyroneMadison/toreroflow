import type { FastifyInstance } from "fastify";
import { getPrisma } from "@toreroflow/db";
import {
  billingSchema,
  EXPENSE_CATEGORIES,
  expenseSchema,
  expenseUpdateSchema,
  monthKeySchema,
  revenueUpdateSchema,
  sumCents,
} from "@toreroflow/core";
import { requireAuth } from "../plugins/requireAuth";
import { deriveStatus, rollForward } from "../financials/month";

const NOT_FOUND = { error: "not found" } as const;

/** First moment of the month a "2026-06" key names. */
function monthStart(key: string): Date {
  const [y, m] = key.split("-").map(Number);
  return new Date(y!, m! - 1, 1);
}

/** The month before a "2026-06" key, as a key. */
function previousMonth(key: string): string {
  const d = monthStart(key);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export async function financialsRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  app.addHook("onRequest", requireAuth);

  app.get<{ Querystring: { month?: string } }>("/financials", async (request, reply) => {
    const parsed = monthKeySchema.safeParse(
      request.query.month ??
        `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, "0")}`,
    );
    if (!parsed.success) return reply.status(400).send({ error: "month must be YYYY-MM" });
    const month = parsed.data;
    const agencyId = request.user.agencyId;

    const clients = await prisma.client.findMany({
      where: { agencyId, deletedAt: null },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        name: true,
        avatarSeed: true,
        monthlyPriceCents: true,
        billingMode: true,
        quotaShort: true,
        quotaLong: true,
        quotaResetAt: true,
        adjustShort: true,
        adjustLong: true,
        socialAccounts: {
          where: { deletedAt: null },
          select: { avatarUrl: true },
        },
      },
    });

    // Seed the month from each client's current price. Only for clients that
    // have one: a client with no price is not an error, it is just not billed.
    for (const c of clients) {
      if (c.monthlyPriceCents == null) continue;
      await prisma.revenueEntry.upsert({
        where: { clientId_month: { clientId: c.id, month } },
        create: { agencyId, clientId: c.id, month, amountCents: c.monthlyPriceCents },
        update: {},
      });
    }

    // Roll recurring costs forward the first time a month is opened. An empty
    // month means roll-forward has not run, not that there are no costs.
    const existing = await prisma.expense.count({ where: { agencyId, month } });
    if (existing === 0) {
      const prev = await prisma.expense.findMany({
        where: { agencyId, month: previousMonth(month) },
      });
      const carried = rollForward(
        prev.map((e) => ({
          name: e.name,
          categoryLine: e.categoryLine,
          amountCents: e.amountCents,
          kind: e.kind,
          variable: e.variable,
          color: e.color,
        })),
        month,
      );
      if (carried.length) {
        await prisma.expense.createMany({
          data: carried.map((r) => ({
            agencyId,
            name: r.name,
            categoryLine: r.categoryLine,
            amountCents: r.amountCents,
            month,
            kind: r.kind,
            variable: r.variable,
            color: r.color,
          })),
        });
      }
    }

    const [revenue, expenses] = await Promise.all([
      prisma.revenueEntry.findMany({ where: { agencyId, month } }),
      prisma.expense.findMany({ where: { agencyId, month }, orderBy: { createdAt: "asc" } }),
    ]);

    const byClient = new Map(clients.map((c) => [c.id, c]));

    // Delivered counts per client for the current quota period, counted the
    // same way the quota card and Account Overview count them, so three
    // screens cannot disagree about whether a cycle is finished.
    const deliveredByClient = new Map<string, { short: number; long: number }>();
    for (const c of clients) {
      const since = c.quotaResetAt ?? new Date(0);
      const base = { clientId: c.id, createdAt: { gte: since }, isRevision: false };
      const [shortCount, longCount] = await Promise.all([
        prisma.mediaAsset.count({ where: { ...base, format: { in: ["short_form"] } } }),
        prisma.mediaAsset.count({ where: { ...base, format: "long_form" } }),
      ]);
      deliveredByClient.set(c.id, {
        short: Math.max(0, shortCount + c.adjustShort),
        long: Math.max(0, longCount + c.adjustLong),
      });
    }

    const revenueRows = revenue.map((r) => {
      const c = byClient.get(r.clientId);
      // Met means every tracked format has reached its target. A client with
      // no targets at all counts as met, because there is nothing to wait for.
      const d = deliveredByClient.get(r.clientId) ?? { short: 0, long: 0 };
      const quotaMet =
        !c ||
        ((c.quotaShort == null || d.short >= c.quotaShort) &&
          (c.quotaLong == null || d.long >= c.quotaLong));
      return {
        id: r.id,
        clientId: r.clientId,
        clientName: c?.name ?? "Unknown",
        avatarUrl: c?.socialAccounts.find((a) => a.avatarUrl)?.avatarUrl ?? null,
        avatarSeed: c?.avatarSeed ?? null,
        amountCents: r.amountCents,
        color: r.color,
        note: r.note,
        receivedAt: r.receivedAt,
        status: deriveStatus({
          receivedAt: r.receivedAt,
          billingMode: c?.billingMode ?? "calendar",
          quotaMet,
        }),
      };
    });

    const recurring = expenses.filter((e) => e.kind === "recurring");
    const oneOff = expenses.filter((e) => e.kind === "one_off");

    return {
      month,
      categories: EXPENSE_CATEGORIES,
      revenue: revenueRows,
      recurring,
      oneOff,
      totals: {
        inCents: sumCents(revenueRows.map((r) => r.amountCents)),
        recurringOutCents: sumCents(recurring.map((e) => e.amountCents)),
        oneOffOutCents: sumCents(oneOff.map((e) => e.amountCents)),
        // Unknown bills are excluded from the total and reported separately so
        // the screen can say the figure is incomplete rather than pretend.
        missingBills: expenses.filter((e) => e.amountCents === null).length,
      },
    };
  });

  app.patch<{ Params: { id: string } }>("/clients/:id/billing", async (request, reply) => {
    const client = await prisma.client.findFirst({
      where: { id: request.params.id, agencyId: request.user.agencyId, deletedAt: null },
      select: { id: true },
    });
    if (!client) return reply.status(404).send(NOT_FOUND);
    const body = billingSchema.parse(request.body);
    return await prisma.client.update({
      where: { id: client.id },
      data: {
        ...(body.monthlyPriceCents !== undefined ? { monthlyPriceCents: body.monthlyPriceCents } : {}),
        ...(body.billingMode !== undefined ? { billingMode: body.billingMode } : {}),
      },
      select: { monthlyPriceCents: true, billingMode: true },
    });
  });

  app.post("/financials/expenses", async (request) => {
    const body = expenseSchema.parse(request.body);
    return await prisma.expense.create({
      data: {
        agencyId: request.user.agencyId,
        name: body.name,
        categoryLine: body.categoryLine,
        amountCents: body.amountCents ?? null,
        month: body.month,
        kind: body.kind,
        variable: body.variable,
        incurredOn: body.incurredOn ? new Date(body.incurredOn) : null,
        color: body.color ?? null,
        note: body.note ?? null,
      },
    });
  });

  app.patch<{ Params: { id: string } }>("/financials/expenses/:id", async (request, reply) => {
    const found = await prisma.expense.findFirst({
      where: { id: request.params.id, agencyId: request.user.agencyId },
      select: { id: true },
    });
    if (!found) return reply.status(404).send(NOT_FOUND);
    const body = expenseUpdateSchema.parse(request.body);
    return await prisma.expense.update({
      where: { id: found.id },
      data: {
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.categoryLine !== undefined ? { categoryLine: body.categoryLine } : {}),
        ...(body.amountCents !== undefined ? { amountCents: body.amountCents } : {}),
        ...(body.color !== undefined ? { color: body.color } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
        ...(body.incurredOn !== undefined
          ? { incurredOn: body.incurredOn ? new Date(body.incurredOn) : null }
          : {}),
      },
    });
  });

  app.delete<{ Params: { id: string } }>("/financials/expenses/:id", async (request, reply) => {
    const found = await prisma.expense.findFirst({
      where: { id: request.params.id, agencyId: request.user.agencyId },
      select: { id: true },
    });
    if (!found) return reply.status(404).send(NOT_FOUND);
    await prisma.expense.delete({ where: { id: found.id } });
    return { ok: true };
  });

  app.patch<{ Params: { id: string } }>("/financials/revenue/:id", async (request, reply) => {
    const found = await prisma.revenueEntry.findFirst({
      where: { id: request.params.id, agencyId: request.user.agencyId },
      select: { id: true },
    });
    if (!found) return reply.status(404).send(NOT_FOUND);
    const body = revenueUpdateSchema.parse(request.body);
    return await prisma.revenueEntry.update({
      where: { id: found.id },
      data: {
        ...(body.amountCents !== undefined ? { amountCents: body.amountCents } : {}),
        ...(body.color !== undefined ? { color: body.color } : {}),
        ...(body.note !== undefined ? { note: body.note } : {}),
        ...(body.receivedAt !== undefined
          ? { receivedAt: body.receivedAt ? new Date(body.receivedAt) : null }
          : {}),
      },
    });
  });
}
