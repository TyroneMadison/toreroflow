-- The Edit tab: Studio projects with their own sources, the AI content
-- analyzer, the ideas list, and knowledge base files. Editor sources are
-- deliberately not MediaAssets, so quota counts and retention sweeps never
-- see them; the bridge to uploads is the normal upload pipe at export.

-- The brand's niche profile, one editable blob for the Ideas area.
ALTER TABLE "Client" ADD COLUMN "nicheProfile" JSONB;

CREATE TABLE "EditProject" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "name" TEXT NOT NULL DEFAULT 'Untitled project',
  "status" TEXT NOT NULL DEFAULT 'draft',
  "doc" JSONB,
  "renderedKey" TEXT,
  "renderPct" INTEGER,
  "renderError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "EditProject_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EditProject_clientId_idx" ON "EditProject"("clientId");
ALTER TABLE "EditProject" ADD CONSTRAINT "EditProject_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "EditAsset" (
  "id" TEXT NOT NULL,
  "projectId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "storageKey" TEXT NOT NULL,
  "proxyKey" TEXT,
  "stripKey" TEXT,
  "originalName" TEXT NOT NULL,
  "durationSec" DOUBLE PRECISION,
  "width" INTEGER,
  "height" INTEGER,
  "words" JSONB,
  "status" TEXT NOT NULL DEFAULT 'uploaded',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "EditAsset_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EditAsset_projectId_idx" ON "EditAsset"("projectId");
ALTER TABLE "EditAsset" ADD CONSTRAINT "EditAsset_projectId_fkey"
  FOREIGN KEY ("projectId") REFERENCES "EditProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "VideoAnalysis" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "mediaAssetId" TEXT,
  "storageKey" TEXT,
  "thumbKey" TEXT,
  "name" TEXT NOT NULL,
  "durationSec" DOUBLE PRECISION,
  "status" TEXT NOT NULL DEFAULT 'running',
  "result" JSONB,
  "error" TEXT,
  "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completedAt" TIMESTAMP(3),
  CONSTRAINT "VideoAnalysis_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "VideoAnalysis_clientId_idx" ON "VideoAnalysis"("clientId");
ALTER TABLE "VideoAnalysis" ADD CONSTRAINT "VideoAnalysis_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "ContentIdea" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "niche" TEXT NOT NULL DEFAULT '',
  "formatName" TEXT,
  "text" TEXT NOT NULL,
  "hook" TEXT,
  "script" JSONB,
  "status" TEXT NOT NULL DEFAULT 'idea',
  "source" TEXT NOT NULL DEFAULT 'custom',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ContentIdea_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ContentIdea_clientId_idx" ON "ContentIdea"("clientId");
ALTER TABLE "ContentIdea" ADD CONSTRAINT "ContentIdea_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "KnowledgeFile" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "storageKey" TEXT NOT NULL,
  "extractedText" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'processing',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "KnowledgeFile_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "KnowledgeFile_clientId_idx" ON "KnowledgeFile"("clientId");
ALTER TABLE "KnowledgeFile" ADD CONSTRAINT "KnowledgeFile_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
