-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "quotaAdjustment" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "quotaResetAt" TIMESTAMP(3),
ADD COLUMN     "videoQuota" INTEGER;

-- AlterTable
ALTER TABLE "MediaAsset" ADD COLUMN     "isRevision" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "revisionOfId" TEXT;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_revisionOfId_fkey" FOREIGN KEY ("revisionOfId") REFERENCES "MediaAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;
