-- AlterTable
ALTER TABLE "EditAsset" ADD COLUMN     "languageProb" DOUBLE PRECISION,
ADD COLUMN     "languageSource" TEXT;

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "trends" JSONB,
ADD COLUMN     "judgeTuning" JSONB;

-- AlterTable
ALTER TABLE "ClipCandidate" ADD COLUMN     "visual" INTEGER;
