import type { FastifyInstance } from "fastify";
import { promises as fsp } from "node:fs";
import nodePath from "node:path";
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
import { buildSeries, monthKeysEnding, ytdTotals } from "../financials/summary";
import { env } from "../env";
import { renderReportPdf } from "../reports/renderPdf";
import { buildInvoiceHtml } from "../financials/invoicePdf";
import {
  buildTaxExportHtml,
  groupForScheduleC,
  uncategorisedExpenses,
} from "../financials/taxExport";

const NOT_FOUND = { error: "not found" } as const;

/** Prisma's code for "a unique constraint rejected this write". */
const UNIQUE_VIOLATION = "P2002";

/** Bounded so a genuinely stuck allocation fails loudly instead of looping forever. */
const MAX_INVOICE_NUMBER_ATTEMPTS = 10;

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

/** The server clock's own month, in the same "YYYY-MM" shape as everything else here. */
function currentMonthKey(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
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

    // Opening a month is an act of moving into it, not of glancing back at
    // it. The screen offers twelve months back purely for reading history;
    // seeding revenue at today's price or rolling expenses forward into a
    // month that already closed would fabricate records nobody asked for,
    // and there is no revenue DELETE route to undo it. So a month before the
    // current one is read-only here: whatever already exists comes back,
    // and nothing new is created. String comparison sorts correctly because
    // both sides are "YYYY-MM".
    if (month >= currentMonthKey()) {
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

      // Roll recurring costs forward the first time a month is opened. Counting
      // existing expenses cannot tell "never opened" from "every cost deleted on
      // purpose", so open-ness is recorded explicitly instead. The insert is the
      // claim: a unique-constraint violation means another request (or an
      // earlier visit) already opened this month, so skip silently rather than
      // erroring or rolling forward twice.
      let justOpened = true;
      try {
        await prisma.financialMonth.create({ data: { agencyId, month } });
      } catch (error) {
        const code =
          error && typeof error === "object" && "code" in error
            ? (error as { code: unknown }).code
            : null;
        if (code !== UNIQUE_VIOLATION) throw error;
        justOpened = false;
      }
      if (justOpened) {
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
      // Delivered and target summed over tracked formats only, so an
      // untracked format neither inflates nor blocks the fraction shown
      // beside the row. Both null when nothing is tracked.
      const hasTargets = c != null && (c.quotaShort != null || c.quotaLong != null);
      const quotaTarget = hasTargets ? (c.quotaShort ?? 0) + (c.quotaLong ?? 0) : null;
      const quotaDelivered = hasTargets
        ? (c.quotaShort != null ? d.short : 0) + (c.quotaLong != null ? d.long : 0)
        : null;
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
        billingMode: (c?.billingMode ?? "calendar") as "calendar" | "on_fulfilment",
        quotaMet,
        quotaDelivered,
        quotaTarget,
        status: deriveStatus({
          receivedAt: r.receivedAt,
          billingMode: c?.billingMode ?? "calendar",
          quotaMet,
        }),
      };
    });

    const recurring = expenses.filter((e) => e.kind === "recurring");
    const oneOff = expenses.filter((e) => e.kind === "one_off");

    // Twelve months of history for the bars, sparkline, and delta. The
    // window always contains January-to-now of the requested month's year,
    // so the YTD numbers reuse the same two queries.
    const windowKeys = monthKeysEnding(month, 12);
    const [windowRevenue, windowExpenses] = await Promise.all([
      prisma.revenueEntry.findMany({
        where: { agencyId, month: { in: windowKeys } },
        select: { month: true, amountCents: true },
      }),
      prisma.expense.findMany({
        where: { agencyId, month: { in: windowKeys } },
        select: { month: true, amountCents: true },
      }),
    ]);
    const series = buildSeries(month, windowRevenue, windowExpenses);
    const ytd = ytdTotals(month, windowRevenue, windowExpenses);

    // Years the export selector can offer: from the earliest opened month's
    // year up to the server's current year, newest first.
    const firstOpened = await prisma.financialMonth.findFirst({
      where: { agencyId },
      orderBy: { month: "asc" },
      select: { month: true },
    });
    const nowYear = new Date().getFullYear();
    const firstYear = firstOpened ? Number(firstOpened.month.slice(0, 4)) : nowYear;
    const years: number[] = [];
    for (let y = nowYear; y >= Math.min(firstYear, nowYear); y--) years.push(y);

    return {
      month,
      categories: EXPENSE_CATEGORIES,
      revenue: revenueRows,
      recurring,
      oneOff,
      series,
      ytd,
      years,
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

  app.delete<{ Params: { id: string } }>("/financials/revenue/:id", async (request, reply) => {
    const found = await prisma.revenueEntry.findFirst({
      where: { id: request.params.id, agencyId: request.user.agencyId },
      select: { id: true },
    });
    if (!found) return reply.status(404).send(NOT_FOUND);
    await prisma.revenueEntry.delete({ where: { id: found.id } });
    return { ok: true };
  });

  /**
   * Issue an invoice for one client's month.
   *
   * The `@@unique([agencyId, number])` constraint is what actually guarantees
   * no two invoices ever share a number; reading the current maximum first is
   * only an allocation strategy, not a safety mechanism. PostgreSQL's default
   * Read Committed isolation lets two concurrent requests both read the same
   * maximum before either commits, so the loser's create still throws P2002
   * even though the read happened inside a transaction. Retrying with a
   * freshly read maximum, the same shape `ensureReportSlug` uses in
   * reports/slug.ts, is what turns that race into "get the next number"
   * instead of a 500 for a legitimate second request.
   */
  app.post<{ Body: { clientId: string; month: string } }>(
    "/financials/invoices",
    async (request, reply) => {
      const agencyId = request.user.agencyId;
      const { clientId, month } = request.body;
      if (!monthKeySchema.safeParse(month).success) {
        return reply.status(400).send({ error: "month must be YYYY-MM" });
      }

      const entry = await prisma.revenueEntry.findUnique({
        where: { clientId_month: { clientId, month } },
      });
      if (!entry || entry.agencyId !== agencyId) return reply.status(404).send(NOT_FOUND);

      const [client, agency] = await Promise.all([
        prisma.client.findFirst({
          where: { id: clientId, agencyId, deletedAt: null },
          select: { name: true, contactName: true, contactEmail: true },
        }),
        prisma.agency.findUnique({
          where: { id: agencyId },
          select: { name: true, legalName: true, ein: true },
        }),
      ]);
      if (!client || !agency) return reply.status(404).send(NOT_FOUND);

      const start = monthStart(month);
      const end = new Date(start.getFullYear(), start.getMonth() + 1, 0, 23, 59, 59, 999);

      const delivered = await prisma.mediaAsset.findMany({
        where: { clientId, isRevision: false, createdAt: { gte: start, lte: end } },
        orderBy: { createdAt: "asc" },
        select: { originalName: true, createdAt: true },
      });
      const lines = delivered.map((d) => ({
        title: d.originalName,
        publishedAt: d.createdAt.toISOString(),
      }));

      let invoice: Awaited<ReturnType<typeof prisma.invoice.create>> | undefined;
      for (let attempt = 1; attempt <= MAX_INVOICE_NUMBER_ATTEMPTS; attempt++) {
        const last = await prisma.invoice.findFirst({
          where: { agencyId },
          orderBy: { number: "desc" },
          select: { number: true },
        });
        try {
          invoice = await prisma.invoice.create({
            data: {
              agencyId,
              clientId,
              number: (last?.number ?? 0) + 1,
              periodStart: start,
              periodEnd: end,
              amountCents: entry.amountCents,
              status: "draft",
              lineItems: lines as never,
            },
          });
          break;
        } catch (error) {
          const code =
            error && typeof error === "object" && "code" in error
              ? (error as { code: unknown }).code
              : null;
          if (code !== UNIQUE_VIOLATION) throw error;
          // Another request took this number first; re-read the maximum and retry.
        }
      }
      if (!invoice) {
        throw new Error(
          `could not allocate an invoice number for agency ${agencyId} after ${MAX_INVOICE_NUMBER_ATTEMPTS} attempts`,
        );
      }

      const number = String(invoice.number).padStart(3, "0");
      const html = buildInvoiceHtml({
        number,
        issuedAt: invoice.issuedAt.toISOString(),
        periodLabel: start.toLocaleDateString("en-US", { month: "long", year: "numeric" }),
        business: { legalName: agency.legalName ?? agency.name, ein: agency.ein },
        client: {
          name: client.name,
          contactName: client.contactName,
          contactEmail: client.contactEmail,
        },
        amountCents: invoice.amountCents,
        lines,
      });

      const pdf = await renderReportPdf(html, {});
      const storageKey = `${clientId}/invoices/invoice-${number}.pdf`;
      const abs = nodePath.join(env.STORAGE_DIR, storageKey);
      await fsp.mkdir(nodePath.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, pdf);
      await prisma.invoice.update({ where: { id: invoice.id }, data: { storageKey } });

      return reply.status(201).send({ id: invoice.id, number, url: `/files/${storageKey}` });
    },
  );

  /**
   * The year-end document a CPA works from.
   *
   * Cash basis by default: paid revenue only. If the agency's accounting
   * method is accrual the export includes unpaid revenue and says so on the
   * cover, because the two must never be ambiguous on a tax document.
   */
  app.get<{ Querystring: { year?: string } }>(
    "/financials/export",
    async (request, reply) => {
      const agencyId = request.user.agencyId;
      const year = Number.parseInt(request.query.year ?? "", 10);
      if (!Number.isInteger(year) || year < 2000 || year > 2100) {
        return reply.status(400).send({ error: "year must be a four digit year" });
      }

      const agency = await prisma.agency.findUnique({
        where: { id: agencyId },
        select: {
          name: true,
          legalName: true,
          ein: true,
          businessCode: true,
          accountingMethod: true,
        },
      });
      if (!agency) return reply.status(404).send(NOT_FOUND);

      const prefix = `${year}-`;
      const [expenses, revenue] = await Promise.all([
        prisma.expense.findMany({ where: { agencyId, month: { startsWith: prefix } } }),
        prisma.revenueEntry.findMany({
          where: { agencyId, month: { startsWith: prefix } },
          include: { client: { select: { name: true } } },
        }),
      ]);

      const cashBasis = (agency.accountingMethod ?? "cash") === "cash";
      const countedRevenue = cashBasis ? revenue.filter((r) => r.receivedAt !== null) : revenue;

      const expenseRows = expenses.map((e) => ({
        name: e.name,
        categoryLine: e.categoryLine,
        amountCents: e.amountCents,
      }));
      const groups = groupForScheduleC(expenseRows);
      // Rows whose categoryLine predates the enum validation in
      // financeSchemas.ts and matches no catalogue entry. groupForScheduleC
      // already drops these silently (see its own comment); collecting them
      // here separately, rather than losing them, is what lets the PDF say
      // plainly that they exist and are not part of the deductible total.
      const uncategorised = uncategorisedExpenses(expenseRows);

      const html = buildTaxExportHtml({
        year,
        business: {
          legalName: agency.legalName ?? agency.name,
          ein: agency.ein,
          businessCode: agency.businessCode,
          accountingMethod: cashBasis ? "Cash" : "Accrual",
        },
        grossReceiptsCents: sumCents(countedRevenue.map((r) => r.amountCents)),
        receiptsByClient: Object.entries(
          countedRevenue.reduce<Record<string, number>>((acc, r) => {
            acc[r.client.name] = (acc[r.client.name] ?? 0) + r.amountCents;
            return acc;
          }, {}),
        ).map(([name, cents]) => ({ name, cents })),
        groups,
        uncategorised,
      });

      const pdf = await renderReportPdf(html, {});
      // Prefixed with the agency id, the same as every other storage key in
      // this codebase (see the invoice above). /files/ is served by
      // fastifyStatic at the root of server.ts, outside every auth hook, so
      // this prefix is the only thing keeping one agency's tax document out
      // of another's reach: without it, a bare "exports/schedule-c-2026.pdf"
      // is both guessable and shared by every agency exporting that year,
      // so the second export would silently overwrite the first.
      const storageKey = `${agencyId}/exports/schedule-c-${year}.pdf`;
      const abs = nodePath.join(env.STORAGE_DIR, storageKey);
      await fsp.mkdir(nodePath.dirname(abs), { recursive: true });
      await fsp.writeFile(abs, pdf);
      return reply.status(201).send({ url: `/files/${storageKey}`, year });
    },
  );
}
