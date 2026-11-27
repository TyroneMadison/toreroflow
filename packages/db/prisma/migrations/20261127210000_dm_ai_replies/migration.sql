-- AI replies (F5): two new tables and four columns on DmThread. AI replies
-- are OFF until a person turns them on: DmAiSettings.enabled defaults to
-- false and mode to drafts, and no row at all means the same. Nothing
-- existing is rewritten.

-- AlterTable
ALTER TABLE "DmThread" ADD COLUMN     "aiHandoffAt" TIMESTAMP(3),
ADD COLUMN     "aiHandoffReason" TEXT,
ADD COLUMN     "aiOff" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "aiPausedUntil" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "DmAiSettings" (
    "id" TEXT NOT NULL,
    "dmAccountId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "mode" TEXT NOT NULL DEFAULT 'drafts',
    "instructions" TEXT NOT NULL DEFAULT '',
    "links" JSONB NOT NULL DEFAULT '[]',
    "lessons" JSONB NOT NULL DEFAULT '[]',
    "replyDelayMinSec" INTEGER NOT NULL DEFAULT 20,
    "replyDelayMaxSec" INTEGER NOT NULL DEFAULT 90,
    "typing" BOOLEAN NOT NULL DEFAULT true,
    "pauseOnTeamReply" BOOLEAN NOT NULL DEFAULT true,
    "resumeAfterHours" INTEGER NOT NULL DEFAULT 12,
    "quietStartHour" INTEGER,
    "quietEndHour" INTEGER,
    "handoffTopics" TEXT[] DEFAULT ARRAY['price', 'refund', 'complaint', 'person']::TEXT[],
    "handoffWords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dailyCap" INTEGER NOT NULL DEFAULT 50,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DmAiSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DmAiDraft" (
    "id" TEXT NOT NULL,
    "dmAccountId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "forExternalId" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "origin" TEXT NOT NULL DEFAULT 'auto',
    "bubbles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "note" TEXT,
    "stage" TEXT,
    "reason" TEXT,
    "sendAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "sentHow" TEXT,
    "messageExternalId" TEXT,
    "sentByUserId" TEXT,
    "model" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DmAiDraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DmAiSettings_dmAccountId_key" ON "DmAiSettings"("dmAccountId");

-- CreateIndex
CREATE INDEX "DmAiDraft_dmAccountId_createdAt_idx" ON "DmAiDraft"("dmAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "DmAiDraft_threadId_createdAt_idx" ON "DmAiDraft"("threadId", "createdAt");

-- CreateIndex
CREATE INDEX "DmAiDraft_status_sendAt_idx" ON "DmAiDraft"("status", "sendAt");

-- CreateIndex
CREATE UNIQUE INDEX "DmAiDraft_threadId_forExternalId_key" ON "DmAiDraft"("threadId", "forExternalId");

-- AddForeignKey
ALTER TABLE "DmAiSettings" ADD CONSTRAINT "DmAiSettings_dmAccountId_fkey" FOREIGN KEY ("dmAccountId") REFERENCES "DmAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DmAiDraft" ADD CONSTRAINT "DmAiDraft_dmAccountId_fkey" FOREIGN KEY ("dmAccountId") REFERENCES "DmAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DmAiDraft" ADD CONSTRAINT "DmAiDraft_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "DmThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

