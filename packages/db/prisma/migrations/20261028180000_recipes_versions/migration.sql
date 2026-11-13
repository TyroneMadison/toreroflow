-- Phase 6: recipes, edit versions, after-render send. Hand-written.

ALTER TABLE "EditProject" ADD COLUMN "afterRender" JSONB;
ALTER TABLE "EditProject" ADD COLUMN "uploadAssetId" TEXT;

CREATE TABLE "Recipe" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "settings" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Recipe_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "Recipe_clientId_idx" ON "Recipe"("clientId");
ALTER TABLE "Recipe" ADD CONSTRAINT "Recipe_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "EditVersion" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "auto" BOOLEAN NOT NULL DEFAULT false,
    "doc" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EditVersion_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "EditVersion_projectId_createdAt_idx" ON "EditVersion"("projectId", "createdAt");
ALTER TABLE "EditVersion" ADD CONSTRAINT "EditVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "EditProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;
