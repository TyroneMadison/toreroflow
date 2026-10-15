-- Ideas redesign: creator links per client, Super generate runs, cached creator playbooks.
ALTER TABLE "Client" ADD COLUMN "ideaCreators" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "Client" ADD COLUMN "superGenCapCents" INTEGER NOT NULL DEFAULT 200;

CREATE TABLE "SuperGenerateRun" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "creators" JSONB NOT NULL DEFAULT '[]',
    "ideas" JSONB NOT NULL DEFAULT '[]',
    "capCents" INTEGER NOT NULL,
    "spentCents" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    CONSTRAINT "SuperGenerateRun_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "SuperGenerateRun_clientId_createdAt_idx" ON "SuperGenerateRun"("clientId", "createdAt");
ALTER TABLE "SuperGenerateRun" ADD CONSTRAINT "SuperGenerateRun_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "CreatorPlaybook" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "videos" INTEGER NOT NULL DEFAULT 0,
    "playbook" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CreatorPlaybook_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CreatorPlaybook_url_key" ON "CreatorPlaybook"("url");
