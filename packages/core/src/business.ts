import { z } from "zod";

/**
 * Who the business is, on paper.
 *
 * These four fields are the difference between a document that reads as a
 * registered company and one that reads as a person with a spreadsheet. They
 * appear on invoices a client's accountant will keep and on the year-end
 * export a CPA works from, so the shapes are checked before they are stored
 * rather than after they are printed.
 */

/**
 * An EIN as the IRS writes it: two digits, a hyphen, seven digits.
 *
 * Accepted with or without the hyphen and with surrounding space, because it
 * is copied off a letter or a previous return, and stored in exactly one form
 * so two documents can never show the same number differently. Anything that
 * is not nine digits is refused rather than padded or trimmed to fit: a
 * silently corrected tax identifier is worse than an empty field, which at
 * least prints as "EIN not recorded".
 */
export function normalizeEin(input: string): string | null {
  const digits = input.replace(/[\s-]/g, "");
  if (!/^\d{9}$/.test(digits)) return null;
  return `${digits.slice(0, 2)}-${digits.slice(2)}`;
}

/** Blank means "not recorded", which is a legitimate state, not an error. */
const blankable = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => s.trim())
    .transform((s) => (s.length ? s : null))
    .nullable();

export const businessSchema = z.object({
  /** The registered name, e.g. "Torerone LLC". Distinct from the brand. */
  legalName: blankable(160).optional(),
  /**
   * Refused rather than stored loosely: this number is transcribed onto a real
   * return, and "12-345678" would look plausible on screen and be wrong.
   */
  ein: z
    .string()
    .max(20)
    .transform((s) => s.trim())
    .transform((s) => (s.length ? s : null))
    .nullable()
    .refine((s) => s === null || normalizeEin(s) !== null, {
      message: "An EIN is 9 digits, written 12-3456789.",
    })
    .transform((s) => (s === null ? null : normalizeEin(s)))
    .optional(),
  /** Free text on purpose: a mailing address is not worth a field per line. */
  businessAddress: blankable(300).optional(),
  /** NAICS principal business activity, six digits on Schedule C line B. */
  businessCode: z
    .string()
    .max(10)
    .transform((s) => s.trim())
    .transform((s) => (s.length ? s : null))
    .nullable()
    .refine((s) => s === null || /^\d{6}$/.test(s), {
      message: "A business activity code is 6 digits.",
    })
    .optional(),
  accountingMethod: z.enum(["cash", "accrual"]).optional(),

  /* ---- what the tax estimate needs ---- */

  /** Two letter state. Blank means no state tax is applied at all. */
  taxState: z
    .string()
    .max(2)
    .transform((s) => s.trim().toUpperCase())
    .transform((s) => (s.length ? s : null))
    .nullable()
    .refine((s) => s === null || /^[A-Z]{2}$/.test(s), { message: "Pick a state." })
    .optional(),
  filingStatus: z.enum(["single", "married_joint", "head_of_household"]).optional(),
  /** Wages and anything else taxed the same way, in cents. */
  otherIncomeCents: z.number().int().min(0).max(1_000_000_000).nullish(),
  /**
   * Overrides the built-in state rate, as a percentage.
   *
   * Capped well above any real rate rather than at one: a state could raise
   * its own, and refusing a true number because a table says otherwise is the
   * wrong way round.
   */
  stateTaxRatePct: z.number().min(0).max(30).nullish(),
});

export type BusinessInput = z.infer<typeof businessSchema>;
