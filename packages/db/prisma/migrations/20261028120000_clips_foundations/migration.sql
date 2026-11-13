-- AlterTable
ALTER TABLE "EditAsset" ADD COLUMN     "wordsKey" TEXT,
ADD COLUMN     "language" TEXT,
ADD COLUMN     "peaksKey" TEXT,
ADD COLUMN     "error" TEXT;

-- CreateTable
CREATE TABLE "CaptionTemplate" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "style" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CaptionTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CaptionTemplate_clientId_idx" ON "CaptionTemplate"("clientId");

-- AddForeignKey
ALTER TABLE "CaptionTemplate" ADD CONSTRAINT "CaptionTemplate_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
