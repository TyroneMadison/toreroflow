-- Workflow set S0: draft target overrides, upload queue priority and position,
-- preflight override log, templates, bot full_access flag (default false). Additive only.
-- CreateEnum
CREATE TYPE "QueuePriority" AS ENUM ('rush', 'normal');

-- CreateEnum
CREATE TYPE "TemplateScope" AS ENUM ('client', 'brand');

-- AlterTable
ALTER TABLE "Post" ADD COLUMN     "queuePosition" INTEGER,
ADD COLUMN     "queuePriority" "QueuePriority" NOT NULL DEFAULT 'normal';

-- AlterTable
ALTER TABLE "PostTarget" ADD COLUMN     "overrides" JSONB NOT NULL DEFAULT '{}';

-- CreateTable
CREATE TABLE "PreflightOverride" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "actorKind" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PreflightOverride_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Template" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "scope" "TemplateScope" NOT NULL DEFAULT 'brand',
    "name" TEXT NOT NULL,
    "platforms" "Platform"[] DEFAULT ARRAY[]::"Platform"[],
    "captionPattern" TEXT NOT NULL DEFAULT '',
    "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "coverStyle" TEXT NOT NULL DEFAULT '',
    "postTimes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "cadence" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BotIdentity" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "fullAccess" BOOLEAN NOT NULL DEFAULT false,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotIdentity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PreflightOverride_postId_idx" ON "PreflightOverride"("postId");

-- CreateIndex
CREATE INDEX "Template_clientId_idx" ON "Template"("clientId");

-- CreateIndex
CREATE UNIQUE INDEX "BotIdentity_agencyId_name_key" ON "BotIdentity"("agencyId", "name");

-- AddForeignKey
ALTER TABLE "PreflightOverride" ADD CONSTRAINT "PreflightOverride_postId_fkey" FOREIGN KEY ("postId") REFERENCES "Post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Template" ADD CONSTRAINT "Template_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BotIdentity" ADD CONSTRAINT "BotIdentity_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

