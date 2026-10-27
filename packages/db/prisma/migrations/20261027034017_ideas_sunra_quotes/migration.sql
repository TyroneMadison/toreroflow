-- CreateTable
CREATE TABLE "SunraQuote" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "slides" INTEGER NOT NULL,
    "prompt" TEXT NOT NULL,
    "priceUsd" DOUBLE PRECISION NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'quoted',
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "resultKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SunraQuote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SunraQuote_clientId_createdAt_idx" ON "SunraQuote"("clientId", "createdAt");

-- AddForeignKey
ALTER TABLE "SunraQuote" ADD CONSTRAINT "SunraQuote_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

