-- AlterTable
ALTER TABLE "ContentRequest" ADD COLUMN     "attachmentKey" TEXT,
ADD COLUMN     "linkId" TEXT;

-- CreateTable
CREATE TABLE "RequestFormLink" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequestFormLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RateLimitBucket" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "RequestFormAudit" (
    "id" TEXT NOT NULL,
    "clientId" TEXT,
    "linkId" TEXT,
    "action" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "ip" TEXT,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RequestFormAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RequestFormLink_clientId_createdAt_idx" ON "RequestFormLink"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "RateLimitBucket_expiresAt_idx" ON "RateLimitBucket"("expiresAt");

-- CreateIndex
CREATE INDEX "RequestFormAudit_clientId_createdAt_idx" ON "RequestFormAudit"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "RequestFormAudit_createdAt_idx" ON "RequestFormAudit"("createdAt");

-- AddForeignKey
ALTER TABLE "RequestFormLink" ADD CONSTRAINT "RequestFormLink_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

