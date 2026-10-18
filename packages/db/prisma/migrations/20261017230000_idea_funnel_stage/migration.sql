-- Funnel stage per saved idea, assigned at generation (additive, nullable).
CREATE TYPE "FunnelStage" AS ENUM ('top', 'middle', 'bottom');
ALTER TABLE "ContentIdea" ADD COLUMN "funnelStage" "FunnelStage";
ALTER TABLE "ContentIdea" ADD COLUMN "whyItWorks" TEXT;
CREATE TABLE "IdeaFeedback" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "runId" TEXT NOT NULL DEFAULT '',
    "textKey" TEXT NOT NULL,
    "format" TEXT,
    "funnelStage" TEXT,
    "hookStyle" TEXT,
    "creator" TEXT,
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "saved" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "IdeaFeedback_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "IdeaFeedback_clientId_runId_textKey_key" ON "IdeaFeedback"("clientId", "runId", "textKey");
CREATE INDEX "IdeaFeedback_clientId_createdAt_idx" ON "IdeaFeedback"("clientId", "createdAt");
ALTER TABLE "ContentIdea" ADD COLUMN "difficulty" TEXT;
ALTER TABLE "ContentIdea" ADD COLUMN "needs" JSONB;
ALTER TABLE "ContentIdea" ADD COLUMN "remixedFromId" TEXT;
