import type { FastifyInstance } from "fastify";
import { promises as fsp } from "node:fs";
import nodePath from "node:path";
import { getPrisma } from "@toreroflow/db";
import {
  billingSchema,
  EXPENSE_CATEGORIES,
  expenseSchema,
  expenseUpdateSchema,
  estimateTax,
  monthKeySchema,
  revenueUpdateSchema,
  STATE_TAX,
  sumCents,
  TAX_YEAR,
  type FilingStatus,
} from "@toreroflow/core";
import { requireAuth } from "../plugins/requireAuth";
import {
  deriveStatus,
  monthlyShareOfAnnual,
  quotaMetFor,
  rollForward,
} from "../financials/month";
import { buildSeries, exportYears, monthKeysEnding, ytdTotals } from "../financials/summary";
import { env } from "../env";
import { renderReportPdf } from "@toreroflow/media";
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
    // and the seeder would even recreate a row the operator deleted. So a
    // month before the current one is read-only here: whatever already
    // exists comes back, and nothing new is created. String comparison
    // sorts correctly because both sides are "YYYY-MM".
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
            cadence: e.cadence,
            dueDay: e.dueDay,
            note: e.note,
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
              cadence: r.cadence ?? "monthly",
              dueDay: r.dueDay ?? null,
              note: r.note ?? null,
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
      // Met means every tracked format has reached its target. With no
      // targets, the answer depends on billing: calendar owes by the month
      // regardless, but a fulfilment client with no targets has nothing
      // countable delivered, so its cycle is not met. See quotaMetFor.
      const d = deliveredByClient.get(r.clientId) ?? { short: 0, long: 0 };
      const quotaMet =
        !c ||
        quotaMetFor(
          { quotaShort: c.quotaShort, quotaLong: c.quotaLong, billingMode: c.billingMode },
          d,
        );
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

    const isAnnual = (e: { cadence: string }) => e.cadence === "annual";
    const recurring = expenses.filter((e) => e.kind === "recurring" && !isAnnual(e));
    const oneOff = expenses.filter((e) => e.kind === "one_off");

    /*
     * Annual costs belong to the year, not to the month they were entered in.
     *
     * A domain renewal charged in March is money the business spends all year,
     * so the card lists every yearly cost regardless of which month it sits
     * in, and the monthly screens carry a twelfth of the total. The row itself
     * stays where it is, charged once, so the tax export still sees one
     * payment rather than twelve.
     */
    const annual = await prisma.expense.findMany({
      where: { agencyId, month: { startsWith: `${month.slice(0, 4)}-` }, cadence: "annual" },
      orderBy: { createdAt: "asc" },
    });
    const annualShareCents = monthlyShareOfAnnual(annual);

    // Twelve months of history for the bars, sparkline, and delta. The
    // window always contains January-to-now of the requested month's year,
    // so the YTD numbers reuse the same two queries.
    const windowKeys = monthKeysEnding(month, 12);
    const windowYears = [...new Set(windowKeys.map((k) => k.slice(0, 4)))];
    const [windowRevenue, windowExpenses, windowAnnual] = await Promise.all([
      prisma.revenueEntry.findMany({
        where: { agencyId, month: { in: windowKeys } },
        select: { month: true, amountCents: true },
      }),
      prisma.expense.findMany({
        where: { agencyId, month: { in: windowKeys }, cadence: { not: "annual" } },
        select: { month: true, amountCents: true },
      }),
      prisma.expense.findMany({
        where: {
          agencyId,
          cadence: "annual",
          OR: windowYears.map((y) => ({ month: { startsWith: `${y}-` } })),
        },
        select: { month: true, amountCents: true },
      }),
    ]);

    /*
     * The annual costs, spread.
     *
     * One synthetic row per month carrying that year's twelfth, so the bars,
     * the sparkline and the year-to-date figure all see the same steady cost
     * the monthly total does. The window can straddle two years, so the share
     * is worked out per year rather than once.
     */
    const shareByYear = new Map(
      windowYears.map((y) => [
        y,
        monthlyShareOfAnnual(windowAnnual.filter((e) => e.month.startsWith(`${y}-`))),
      ]),
    );
    const spreadAnnual = windowKeys
      .map((key) => ({ month: key, amountCents: shareByYear.get(key.slice(0, 4)) ?? 0 }))
      .filter((row) => row.amountCents > 0);
    const outRows = [...windowExpenses, ...spreadAnnual];

    const series = buildSeries(month, windowRevenue, outRows);
    const ytd = ytdTotals(month, windowRevenue, outRows);

    // Years the export selector can offer: from the earliest opened month's
    // year up to the server's current year, newest first.
    const [firstOpened, firstRevenue, firstExpense] = await Promise.all([
      prisma.financialMonth.findFirst({
        where: { agencyId },
        orderBy: { month: "asc" },
        select: { month: true },
      }),
      prisma.revenueEntry.findFirst({
        where: { agencyId },
        orderBy: { month: "asc" },
        select: { month: true },
      }),
      prisma.expense.findFirst({
        where: { agencyId },
        orderBy: { month: "asc" },
        select: { month: true },
      }),
    ]);
    const years = exportYears(new Date().getFullYear(), [
      firstOpened?.month ?? null,
      firstRevenue?.month ?? null,
      firstExpense?.month ?? null,
    ]);

    return {
      month,
      categories: EXPENSE_CATEGORIES,
      revenue: revenueRows,
      recurring,
      oneOff,
      annual,
      series,
      ytd,
      years,
      totals: {
        inCents: sumCents(revenueRows.map((r) => r.amountCents)),
        recurringOutCents: sumCents(recurring.map((e) => e.amountCents)),
        oneOffOutCents: sumCents(oneOff.map((e) => e.amountCents)),
        /** A twelfth of the year's annual costs, counted in every month. */
        annualShareCents,
        /** The full yearly figure, for the card that lists them. */
        annualYearCents: sumCents(annual.map((e) => e.amountCents)),
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

  /**
   * A year of one-off spending, month by month.
   *
   * One-offs never roll forward, which is what makes them one-off, so each
   * month holds only what actually happened in it. That is correct and it is
   * also why a year of them was unreadable: seeing March meant moving the
   * whole screen to March. This serves the lot in one go so the section can
   * carry its own month picker without dragging the rest of Financials along.
   */
  app.get<{ Querystring: { year?: string; kind?: string } }>(
    "/financials/expenses/by-month",
    async (request, reply) => {
      const year = Number.parseInt(request.query.year ?? "", 10);
      if (!Number.isInteger(year) || year < 2000 || year > 2100) {
        return reply.status(400).send({ error: "year must be a 4 digit year" });
      }
      const kind = request.query.kind === "recurring" ? "recurring" : "one_off";

      const rows = await prisma.expense.findMany({
        where: { agencyId: request.user.agencyId, kind, month: { startsWith: `${year}-` } },
        orderBy: [{ month: "asc" }, { createdAt: "asc" }],
      });

      // Every month of the year, including the empty ones. A gap in the list
      // would read as a month that has not been looked at rather than a month
      // with nothing in it.
      const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, "0")}`);
      return {
        year,
        kind,
        months: months.map((m) => {
          const mine = rows.filter((r) => r.month === m);
          return {
            month: m,
            rows: mine,
            totalCents: sumCents(mine.map((r) => r.amountCents)),
            missingBills: mine.filter((r) => r.amountCents === null).length,
          };
        }),
        totalCents: sumCents(rows.map((r) => r.amountCents)),
      };
    },
  );

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
        cadence: body.cadence,
        dueDay: body.dueDay ?? null,
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
        ...(body.cadence !== undefined ? { cadence: body.cadence } : {}),
        ...(body.dueDay !== undefined ? { dueDay: body.dueDay } : {}),
        ...(body.variable !== undefined ? { variable: body.variable } : {}),
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
          select: { name: true, legalName: true, ein: true, businessAddress: true },
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
        business: {
          legalName: agency.legalName ?? agency.name,
          ein: agency.ein,
          address: agency.businessAddress,
        },
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
  /**
   * What to set aside for tax on this year's profit.
   *
   * Built from the same figures the year-end export uses, so the two can never
   * disagree: receipts on the agency's own accounting basis, minus what is
   * actually deductible, with business meals already halved.
   *
   * An estimate for a single member LLC that has not elected corporate
   * treatment. It is not tax advice and the screen says so.
   */
  app.get<{ Querystring: { year?: string } }>("/financials/tax-estimate", async (request) => {
    const agencyId = request.user.agencyId;
    const year = Number.parseInt(request.query.year ?? "", 10);
    const useYear = Number.isInteger(year) && year >= 2000 && year <= 2100
      ? year
      : new Date().getFullYear();

    const agency = await prisma.agency.findUnique({
      where: { id: agencyId },
      select: {
        accountingMethod: true,
        taxState: true,
        filingStatus: true,
        otherIncomeCents: true,
        stateTaxRatePct: true,
      },
    });

    const prefix = `${useYear}-`;
    const [expenses, revenue] = await Promise.all([
      prisma.expense.findMany({ where: { agencyId, month: { startsWith: prefix } } }),
      prisma.revenueEntry.findMany({ where: { agencyId, month: { startsWith: prefix } } }),
    ]);

    const cashBasis = (agency?.accountingMethod ?? "cash") === "cash";
    const counted = cashBasis ? revenue.filter((r) => r.receivedAt !== null) : revenue;
    const receiptsCents = sumCents(counted.map((r) => r.amountCents));

    // Grouped rather than summed raw, because that is where meals are halved.
    // Summing the raw amounts would overstate the deduction and understate the
    // tax, which is the wrong direction for a reserve.
    const groups = groupForScheduleC(
      expenses.map((e) => ({
        name: e.name,
        categoryLine: e.categoryLine,
        amountCents: e.amountCents,
      })),
    );
    const deductibleCents = sumCents(groups.map((g) => g.deductibleCents));

    const estimate = estimateTax({
      netProfitCents: receiptsCents - deductibleCents,
      otherIncomeCents: agency?.otherIncomeCents ?? 0,
      filingStatus: (agency?.filingStatus as FilingStatus | null) ?? "single",
      state: agency?.taxState ?? "",
      stateRateOverride: agency?.stateTaxRatePct ?? null,
    });

    return {
      year: useYear,
      /** The year the built-in rates were published for, so staleness is visible. */
      ratesYear: TAX_YEAR,
      basis: cashBasis ? "cash" : "accrual",
      receiptsCents,
      deductibleCents,
      ...estimate,
      stateName: agency?.taxState ? (STATE_TAX[agency.taxState]?.note ?? null) : null,
      /** Null until a state is chosen, which is different from a state with no tax. */
      stateChosen: Boolean(agency?.taxState),
    };
  });

  app.get<{ Querystring: { year?: string } }>(
    "/financials/export",
    async (request, reply) => {
      const agencyId = request.user.agencyId;
      const year = Number.parseInt(request.query.year ?? "", 10);
      if (!Number.isInteger(year) || year < 2000 || year > 2100) {
        return reply.status(400).send({ error: "year must be a 4 digit year" });
      }

      const agency = await prisma.agency.findUnique({
        where: { id: agencyId },
        select: {
          name: true,
          legalName: true,
          ein: true,
          businessAddress: true,
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
          address: agency.businessAddress,
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
