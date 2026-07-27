import type { ExpenseCategory } from "@toreroflow/core";

export interface RevenueRow {
  id: string;
  clientId: string;
  clientName: string;
  avatarUrl: string | null;
  avatarSeed: string | null;
  amountCents: number;
  color: string | null;
  note: string | null;
  receivedAt: string | null;
  status: "paid" | "pending" | "due";
}

export interface ExpenseRow {
  id: string;
  name: string;
  categoryLine: string;
  /** Null means the bill is not known yet, which is not zero. */
  amountCents: number | null;
  month: string;
  kind: "recurring" | "one_off";
  variable: boolean;
  incurredOn: string | null;
  color: string | null;
  note: string | null;
}

export interface FinancialsMonth {
  month: string;
  categories: ExpenseCategory[];
  revenue: RevenueRow[];
  recurring: ExpenseRow[];
  oneOff: ExpenseRow[];
  totals: {
    inCents: number;
    recurringOutCents: number;
    oneOffOutCents: number;
    missingBills: number;
  };
}

/** The five colours a row may take. Matches the design tokens. */
export const FINANCE_COLORS = ["#57d6a0", "#4ea8ff", "#8b7bff", "#ffcf6b", "#ff6b7a"] as const;

/** Stable fallback so a chart is never grey before anything is picked. */
export function colorFor(color: string | null, index: number): string {
  return color ?? FINANCE_COLORS[index % FINANCE_COLORS.length]!;
}
