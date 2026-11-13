-- CreateTable
CREATE TABLE "RepurposeJob" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "sourceVideoId" TEXT NOT NULL,
    "step" TEXT NOT NULL DEFAULT 'transcribe',
    "state" TEXT NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RepurposeJob_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RepurposeJob_clientId_createdAt_idx" ON "RepurposeJob"("clientId", "createdAt");

-- AddForeignKey
ALTER TABLE "RepurposeJob" ADD CONSTRAINT "RepurposeJob_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

