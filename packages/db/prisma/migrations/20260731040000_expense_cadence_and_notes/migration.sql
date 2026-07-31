-- Annual costs, bill days, and a place to write down what a cost actually is.
--
-- cadence: an annual subscription holds its whole yearly figure in amountCents
-- and is charged once, so it must not roll forward month to month the way a
-- monthly cost does. The screens spread a twelfth across the year instead, so
-- the monthly picture includes what is really being paid without the tax
-- export counting the same payment twelve times.
--
-- dueDay: which day of the month a recurring bill lands, so the operator can
-- see what is about to leave the account.

ALTER TABLE "Expense" ADD COLUMN "cadence" TEXT NOT NULL DEFAULT 'monthly';
ALTER TABLE "Expense" ADD COLUMN "dueDay" INTEGER;
