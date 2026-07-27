import { z } from "zod";

/** "2026-06". Rejected early so a bad month never reaches a query. */
export const monthKeySchema = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM");

const HEX = /^#[0-9a-fA-F]{6}$/;

export const billingSchema = z.object({
  monthlyPriceCents: z.number().int().min(0).max(100_000_000).nullish(),
  billingMode: z.enum(["calendar", "on_fulfilment"]).optional(),
});

export const expenseSchema = z.object({
  name: z.string().min(1).max(120),
  categoryLine: z.string().min(1).max(40),
  amountCents: z.number().int().min(0).max(100_000_000).nullish(),
  month: monthKeySchema,
  kind: z.enum(["recurring", "one_off"]).default("recurring"),
  variable: z.boolean().default(false),
  incurredOn: z.string().datetime().nullish(),
  color: z.string().regex(HEX).nullish(),
  note: z.string().max(500).nullish(),
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
  categoryLine: z.string().min(1).max(40).optional(),
  amountCents: z.number().int().min(0).max(100_000_000).nullish(),
  incurredOn: z.string().datetime().nullish(),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullish(),
  note: z.string().max(500).nullish(),
});

export const revenueUpdateSchema = z.object({
  amountCents: z.number().int().min(0).max(100_000_000).optional(),
  /** ISO date, or null to mark unpaid again. */
  receivedAt: z.string().datetime().nullish(),
  color: z.string().regex(HEX).nullish(),
  note: z.string().max(500).nullish(),
});
