-- Sunra quotes are priced in credits now, not an env-configured USD rate.
-- Old open quotes were priced the old way, so they cannot be approved.
UPDATE "SunraQuote" SET "status" = 'failed', "error" = 'priced before Sunra credits; get a new quote' WHERE "status" = 'quoted';

-- AlterTable
ALTER TABLE "SunraQuote" DROP COLUMN "priceUsd",
ADD COLUMN     "credits" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "model" TEXT NOT NULL DEFAULT 'nano-banana-2';
ALTER TABLE "SunraQuote" ALTER COLUMN "credits" DROP DEFAULT;
