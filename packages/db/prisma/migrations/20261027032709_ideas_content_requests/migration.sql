-- CreateTable
CREATE TABLE "ContentRequest" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "what" TEXT NOT NULL,
    "dueDate" TEXT,
    "footageUrl" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "trelloCardId" TEXT,
    "trelloUrl" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContentRequest_clientId_createdAt_idx" ON "ContentRequest"("clientId", "createdAt");

-- AddForeignKey
ALTER TABLE "ContentRequest" ADD CONSTRAINT "ContentRequest_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

