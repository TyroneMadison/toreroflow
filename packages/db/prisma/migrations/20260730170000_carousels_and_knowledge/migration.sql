-- A carousel is several images posted as one Instagram post. It rides the
-- existing asset table so the calendar, the queue and the scheduler reach it
-- without any of them learning a second kind of thing.
ALTER TABLE "MediaAsset" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'video';
ALTER TABLE "MediaAsset" ADD COLUMN "slideKeys" JSONB;

-- What the carousel writer works from, beyond a handle.
CREATE TABLE "KnowledgeNote" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "KnowledgeNote_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "KnowledgeNote_clientId_idx" ON "KnowledgeNote"("clientId");
ALTER TABLE "KnowledgeNote" ADD CONSTRAINT "KnowledgeNote_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- The words, kept server side so closing the screen never loses a generation
-- that was already paid for.
CREATE TABLE "CarouselDraft" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "topic" TEXT NOT NULL,
  "slides" JSONB NOT NULL,
  "caption" TEXT NOT NULL DEFAULT '',
  "hashtags" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CarouselDraft_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "CarouselDraft_clientId_idx" ON "CarouselDraft"("clientId");
ALTER TABLE "CarouselDraft" ADD CONSTRAINT "CarouselDraft_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
