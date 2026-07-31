import { z } from "zod";
import { EXPENSE_CATEGORIES } from "./expenseCategories";

/** "2026-06". Rejected early so a bad month never reaches a query. */
export const monthKeySchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM");

const HEX = /^#[0-9a-fA-F]{6}$/;

// Built from EXPENSE_CATEGORIES itself so the two can never drift. An
// expense whose categoryLine matches no Schedule C line is invisible to
// taxExport.ts's grouping (it only ever collects matching rows), so it
// would sit on screen counting toward the monthly total while contributing
// nothing to the year-end export, an understated deduction with no visible
// sign. That bad value must never reach the database in the first place.
const CATEGORY_KEYS = EXPENSE_CATEGORIES.map((c) => c.key) as [string, ...string[]];

export const billingSchema = z.object({
  monthlyPriceCents: z.number().int().min(0).max(100_000_000).nullish(),
  billingMode: z.enum(["calendar", "on_fulfilment"]).optional(),
});

/**
 * The operator's own note on a cost.
 *
 * 250 characters, which is the length asked for. Long enough for "renews on
 * the business card, cancel before renewal if we drop the retainer" and
 * short enough that it stays a reminder rather than a document.
 */
export const NOTE_MAX = 250;
const noteSchema = z.string().max(NOTE_MAX).nullish();

/** 1 to 31. Not every month has a 31st, which the screens say rather than hide. */
const dueDaySchema = z.number().int().min(1).max(31).nullish();

export const expenseSchema = z.object({
  name: z.string().min(1).max(120),
  categoryLine: z.enum(CATEGORY_KEYS),
  amountCents: z.number().int().min(0).max(100_000_000).nullish(),
  month: monthKeySchema,
  kind: z.enum(["recurring", "one_off"]).default("recurring"),
  variable: z.boolean().default(false),
  /** An annual cost holds its whole yearly figure and is charged once. */
  cadence: z.enum(["monthly", "annual"]).default("monthly"),
  dueDay: dueDaySchema,
  incurredOn: z.string().datetime().nullish(),
  color: z.string().regex(HEX).nullish(),
  note: noteSchema,
});

/**
 * What may be changed after an expense exists.
 *
 * Deliberately narrower than expenseSchema: month and kind are decided when
 * the row is created and are not editable, because moving a cost between
 * months or flipping recurring to one-off silently rewrites a period that may
 * already have been reported or exported.
 */
export const expenseUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  categoryLine: z.enum(CATEGORY_KEYS).optional(),
  amountCents: z.number().int().min(0).max(100_000_000).nullish(),
  /** Editable: whether a cost is billed monthly or yearly is a correction. */
  cadence: z.enum(["monthly", "annual"]).optional(),
  dueDay: dueDaySchema,
  variable: z.boolean().optional(),
  incurredOn: z.string().datetime().nullish(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish(),
  note: noteSchema,
});

export const revenueUpdateSchema = z.object({
  amountCents: z.number().int().min(0).max(100_000_000).optional(),
  /** ISO date, or null to mark unpaid again. */
  receivedAt: z.string().datetime().nullish(),
  color: z.string().regex(HEX).nullish(),
  note: z.string().max(500).nullish(),
});
