-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "reportPublishedAt" TIMESTAMP(3),
ADD COLUMN     "reportPublishedMonth" TEXT,
ADD COLUMN     "reportSlug" TEXT,
ADD COLUMN     "reportUrl" TEXT;

-- Backfill a permanent report path for every existing client, matching
-- clientSlug()/buildReportSlug() in @toreroflow/core: lowercase, non-alphanumeric
-- runs collapsed to a dash, dashes trimmed, capped at 40 characters.
--
-- Two clients can share a name, so identical slugs are disambiguated by a
-- counter rather than letting the unique index abort the migration. Oldest
-- client keeps the clean path.
WITH slugged AS (
  SELECT
    id,
    coalesce(
      nullif(left(trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')), 40), ''),
      'client'
    ) AS base,
    row_number() OVER (
      PARTITION BY coalesce(
        nullif(left(trim(both '-' from regexp_replace(lower(name), '[^a-z0-9]+', '-', 'g')), 40), ''),
        'client'
      )
      ORDER BY "createdAt", id
    ) AS n
  FROM "Client"
)
UPDATE "Client" c
SET "reportSlug" = CASE
      WHEN s.n = 1 THEN s.base || '-end-of-month-report'
      ELSE s.base || '-' || s.n || '-end-of-month-report'
    END
FROM slugged s
WHERE c.id = s.id;

-- CreateIndex
CREATE UNIQUE INDEX "Client_reportSlug_key" ON "Client"("reportSlug");
