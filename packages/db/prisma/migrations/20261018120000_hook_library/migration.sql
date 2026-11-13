-- Hook library (v0.3.34) and the idea-to-post link. Additive only.
-- CreateEnum
CREATE TYPE "HookSource" AS ENUM ('OWN', 'WEB', 'CREATOR');

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "ideaId" TEXT;

-- CreateTable
CREATE TABLE "Hook" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "reworded" TEXT,
    "sourceType" "HookSource" NOT NULL,
    "sourceUrl" TEXT,
    "sourceAccount" TEXT,
    "sourceVideoId" TEXT,
    "format" TEXT NOT NULL,
    "funnelStage" "FunnelStage",
    "nicheScore" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "stats" JSONB,
    "textHash" TEXT NOT NULL,
    "usedCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Hook_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HookSeenVideo" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "seenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HookSeenVideo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Hook_clientId_createdAt_idx" ON "Hook"("clientId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Hook_clientId_sourceType_textHash_key" ON "Hook"("clientId", "sourceType", "textHash");

-- CreateIndex
CREATE UNIQUE INDEX "HookSeenVideo_clientId_platform_videoId_key" ON "HookSeenVideo"("clientId", "platform", "videoId");

-- CreateIndex
CREATE INDEX "Post_ideaId_idx" ON "Post"("ideaId");

-- AddForeignKey
ALTER TABLE "Post" ADD CONSTRAINT "Post_ideaId_fkey" FOREIGN KEY ("ideaId") REFERENCES "ContentIdea"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Hook" ADD CONSTRAINT "Hook_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HookSeenVideo" ADD CONSTRAINT "HookSeenVideo_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

