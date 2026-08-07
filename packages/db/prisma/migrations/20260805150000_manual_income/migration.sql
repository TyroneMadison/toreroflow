-- Money coming in stops meaning only "a client's bill".
--
-- The operator subsidises the business from personal paycheck transfers, and
-- those arrive in the account without a client behind them. A revenue row may
-- now carry a label instead of a client: it is entered by hand, marked
-- received when it is added, never touched by the month seeder or the price
-- reconciler (both iterate clients), and flows into every total, donut and
-- bar exactly as client revenue does because they all sum the same table.
--
-- The (clientId, month) unique survives: Postgres treats NULLs as distinct,
-- so any number of labelled rows fit in one month while a client still gets
-- exactly one.
ALTER TABLE "RevenueEntry" ALTER COLUMN "clientId" DROP NOT NULL;
ALTER TABLE "RevenueEntry" ADD COLUMN "label" TEXT;
