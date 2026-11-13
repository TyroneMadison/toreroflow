-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "driveSource" JSONB;

-- CreateTable
CREATE TABLE "DriveImport" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "fileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "assetId" TEXT,
    "postId" TEXT,
    "detail" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DriveImport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DriveImport_clientId_createdAt_idx" ON "DriveImport"("clientId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DriveImport_clientId_fileId_key" ON "DriveImport"("clientId", "fileId");

-- AddForeignKey
ALTER TABLE "DriveImport" ADD CONSTRAINT "DriveImport_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

