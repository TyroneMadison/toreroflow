-- DM automations (F4): new tables, plus one nullable column on DmAccount (the
-- per-account kill switch). Nothing existing is rewritten.

-- AlterTable
ALTER TABLE "DmAccount" ADD COLUMN     "automationsPausedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "DmAutomation" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "socialAccountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "trigger" TEXT NOT NULL,
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "matchMode" TEXT NOT NULL DEFAULT 'contains',
    "excludeKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scope" TEXT NOT NULL DEFAULT 'all',
    "postIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "steps" JSONB NOT NULL DEFAULT '[]',
    "publicReplyOn" BOOLEAN NOT NULL DEFAULT false,
    "publicReplies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "oncePerContact" BOOLEAN NOT NULL DEFAULT true,
    "followersOnly" BOOLEAN NOT NULL DEFAULT false,
    "trackLinks" BOOLEAN NOT NULL DEFAULT true,
    "alsoDmKeyword" BOOLEAN NOT NULL DEFAULT false,
    "folder" TEXT,
    "published" JSONB,
    "publishedAt" TIMESTAMP(3),
    "testCode" TEXT,
    "testCodeExpiresAt" TIMESTAMP(3),
    "lastTestAt" TIMESTAMP(3),
    "runCount" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "clickCount" INTEGER NOT NULL DEFAULT 0,
    "lastRunAt" TIMESTAMP(3),
    "createdById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DmAutomation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DmAutomationRun" (
    "id" TEXT NOT NULL,
    "dmAccountId" TEXT NOT NULL,
    "automationId" TEXT,
    "eventKey" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "contactExternalId" TEXT NOT NULL,
    "username" TEXT,
    "text" TEXT,
    "mediaId" TEXT,
    "commentId" TEXT,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "test" BOOLEAN NOT NULL DEFAULT false,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "retryAt" TIMESTAMP(3),
    "eventAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "messageId" TEXT,
    "publicReplyAt" TIMESTAMP(3),
    "linkUrl" TEXT,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "clickedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DmAutomationRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DmAutomation_clientId_deletedAt_idx" ON "DmAutomation"("clientId", "deletedAt");

-- CreateIndex
CREATE INDEX "DmAutomation_socialAccountId_status_idx" ON "DmAutomation"("socialAccountId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DmAutomation_socialAccountId_testCode_key" ON "DmAutomation"("socialAccountId", "testCode");

-- CreateIndex
CREATE INDEX "DmAutomationRun_automationId_createdAt_idx" ON "DmAutomationRun"("automationId", "createdAt");

-- CreateIndex
CREATE INDEX "DmAutomationRun_automationId_contactExternalId_idx" ON "DmAutomationRun"("automationId", "contactExternalId");

-- CreateIndex
CREATE INDEX "DmAutomationRun_dmAccountId_sentAt_idx" ON "DmAutomationRun"("dmAccountId", "sentAt");

-- CreateIndex
CREATE INDEX "DmAutomationRun_dmAccountId_createdAt_idx" ON "DmAutomationRun"("dmAccountId", "createdAt");

-- CreateIndex
CREATE INDEX "DmAutomationRun_status_retryAt_idx" ON "DmAutomationRun"("status", "retryAt");

-- CreateIndex
CREATE UNIQUE INDEX "DmAutomationRun_dmAccountId_eventKey_key" ON "DmAutomationRun"("dmAccountId", "eventKey");

-- AddForeignKey
ALTER TABLE "DmAutomation" ADD CONSTRAINT "DmAutomation_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DmAutomation" ADD CONSTRAINT "DmAutomation_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DmAutomationRun" ADD CONSTRAINT "DmAutomationRun_dmAccountId_fkey" FOREIGN KEY ("dmAccountId") REFERENCES "DmAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DmAutomationRun" ADD CONSTRAINT "DmAutomationRun_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "DmAutomation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

