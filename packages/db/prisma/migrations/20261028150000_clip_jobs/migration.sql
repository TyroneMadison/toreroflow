-- Studio > Clips: a long source cut into scored short clips.
-- Hand-written. The source is an EditAsset (holder project status "clipsource").

CREATE TABLE "ClipJob" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "sourceAssetId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "stage" TEXT,
    "pct" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "options" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ClipJob_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ClipCandidate" (
    "id" TEXT NOT NULL,
    "jobId" TEXT NOT NULL,
    "rank" INTEGER NOT NULL DEFAULT 0,
    "ranges" JSONB NOT NULL,
    "duration" DOUBLE PRECISION NOT NULL,
    "lengthTarget" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "why" TEXT,
    "description" TEXT,
    "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "text" TEXT,
    "hook" INTEGER NOT NULL DEFAULT 0,
    "flow" INTEGER NOT NULL DEFAULT 0,
    "value" INTEGER NOT NULL DEFAULT 0,
    "trend" INTEGER NOT NULL DEFAULT 0,
    "relevance" INTEGER,
    "sponsorship" INTEGER,
    "raw" INTEGER NOT NULL DEFAULT 0,
    "score" INTEGER NOT NULL DEFAULT 0,
    "comments" JSONB,
    "feedback" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'curate',
    "editProjectId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ClipCandidate_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ClipJob_clientId_idx" ON "ClipJob"("clientId");
CREATE INDEX "ClipCandidate_jobId_idx" ON "ClipCandidate"("jobId");

ALTER TABLE "ClipJob" ADD CONSTRAINT "ClipJob_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClipJob" ADD CONSTRAINT "ClipJob_sourceAssetId_fkey" FOREIGN KEY ("sourceAssetId") REFERENCES "EditAsset"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ClipCandidate" ADD CONSTRAINT "ClipCandidate_jobId_fkey" FOREIGN KEY ("jobId") REFERENCES "ClipJob"("id") ON DELETE CASCADE ON UPDATE CASCADE;
