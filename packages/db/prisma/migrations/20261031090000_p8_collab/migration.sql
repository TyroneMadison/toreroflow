-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "autoImport" JSONB;

-- AlterTable
ALTER TABLE "ClipCandidate" ADD COLUMN     "favorite" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "perf" JSONB,
ADD COLUMN     "perfAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "EditComment" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "parentId" TEXT,
    "atSec" DOUBLE PRECISION,
    "body" TEXT NOT NULL,
    "authorName" TEXT NOT NULL,
    "authorKind" TEXT NOT NULL DEFAULT 'team',
    "userId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EditComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReviewLink" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "createdById" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReviewLink_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClipCollection" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClipCollection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClipCollectionItem" (
    "collectionId" TEXT NOT NULL,
    "candidateId" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClipCollectionItem_pkey" PRIMARY KEY ("collectionId","candidateId")
);

-- CreateTable
CREATE TABLE "ClipActivity" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "candidateId" TEXT,
    "jobId" TEXT,
    "projectId" TEXT,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClipActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "YouTubeImport" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "videoId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3),
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "clipJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "YouTubeImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "EditComment_projectId_createdAt_idx" ON "EditComment"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "ReviewLink_projectId_idx" ON "ReviewLink"("projectId");

-- CreateIndex
CREATE UNIQUE INDEX "ClipCollection_clientId_name_key" ON "ClipCollection"("clientId", "name");

-- CreateIndex
CREATE INDEX "ClipActivity_clientId_createdAt_idx" ON "ClipActivity"("clientId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "YouTubeImport_clientId_videoId_key" ON "YouTubeImport"("clientId", "videoId");

-- AddForeignKey
ALTER TABLE "EditComment" ADD CONSTRAINT "EditComment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "EditProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EditComment" ADD CONSTRAINT "EditComment_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "EditComment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReviewLink" ADD CONSTRAINT "ReviewLink_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "EditProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClipCollection" ADD CONSTRAINT "ClipCollection_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClipCollectionItem" ADD CONSTRAINT "ClipCollectionItem_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "ClipCollection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClipCollectionItem" ADD CONSTRAINT "ClipCollectionItem_candidateId_fkey" FOREIGN KEY ("candidateId") REFERENCES "ClipCandidate"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ClipActivity" ADD CONSTRAINT "ClipActivity_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "YouTubeImport" ADD CONSTRAINT "YouTubeImport_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Phase 8 cross-project clip search (Postgres full-text). Prisma cannot
-- describe an expression index, so it lives only in this migration.
CREATE INDEX IF NOT EXISTS "ClipCandidate_search_idx" ON "ClipCandidate"
  USING GIN (to_tsvector('simple', coalesce("title", '') || ' ' || coalesce("text", '')));
