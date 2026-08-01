-- Recurring costs become a standing series rather than a one-time copy.
--
-- The bug: rolling last month's costs forward ran exactly once per month,
-- gated on a "has this month been opened" row. Opening a month early spent
-- that single chance against a month that had nothing in it yet. In the live
-- data 2026-08 was opened nine minutes before 2026-07, so August rolled
-- forward from an empty July and stayed empty while July held five recurring
-- costs.

ALTER TABLE "Expense" ADD COLUMN "seriesId" TEXT;
ALTER TABLE "Expense" ADD COLUMN "endedMonth" TEXT;

-- Existing recurring rows have no series yet. Group them by what a human
-- would call the same cost: same agency, same name ignoring case, same
-- Schedule C category. Only recurring rows get an id; one-off rows never
-- repeat, so a series would mean nothing on them.
UPDATE "Expense" e
SET "seriesId" = s.sid
FROM (
  SELECT
    "agencyId"     AS aid,
    lower(name)    AS lname,
    "categoryLine" AS cat,
    md5("agencyId" || '|' || lower(name) || '|' || "categoryLine") AS sid
  FROM "Expense"
  WHERE kind = 'recurring'
  GROUP BY "agencyId", lower(name), "categoryLine"
) s
WHERE e.kind = 'recurring'
  AND e."agencyId" = s.aid
  AND lower(e.name) = s.lname
  AND e."categoryLine" = s.cat;

CREATE INDEX "Expense_agencyId_seriesId_idx" ON "Expense"("agencyId", "seriesId");

-- A month's revenue row tracks the client's standing price until the operator
-- types over it. Deliberately defaulted false for every existing row,
-- including the stale ones: leaving them unclaimed is what lets the next read
-- correct August from $1,500 back to Caleb's real $850. Past months are never
-- reconciled, so July keeps what it recorded either way.
ALTER TABLE "RevenueEntry" ADD COLUMN "priceOverridden" BOOLEAN NOT NULL DEFAULT false;
