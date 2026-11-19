-- Document signing: a contract goes out, people sign it in a browser, and the
-- trail of who did what is kept well enough to stand up if it is ever disputed.
--
-- Purely additive. Nothing existing is altered or dropped, apart from Client
-- gaining a back-reference that costs it no column.

-- CreateEnum
CREATE TYPE "SignatureRequestStatus" AS ENUM ('draft', 'sent', 'completed', 'declined', 'voided');

-- CreateEnum
CREATE TYPE "SignerStatus" AS ENUM ('pending', 'viewed', 'signed', 'declined');

-- CreateEnum
CREATE TYPE "SignatureFieldType" AS ENUM ('signature', 'initials', 'date', 'text', 'checkbox');

-- CreateTable
CREATE TABLE "SignatureRequest" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "clientId" TEXT,
    "createdById" TEXT,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL DEFAULT '',
    "status" "SignatureRequestStatus" NOT NULL DEFAULT 'draft',
    "sourceFileKey" TEXT NOT NULL,
    "sourceSha256" TEXT NOT NULL,
    "pageCount" INTEGER NOT NULL DEFAULT 0,
    "signedFileKey" TEXT,
    "signedSha256" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SignatureRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignatureSigner" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "order" INTEGER NOT NULL DEFAULT 1,
    "status" "SignerStatus" NOT NULL DEFAULT 'pending',
    "consentAt" TIMESTAMP(3),
    "viewedAt" TIMESTAMP(3),
    "signedAt" TIMESTAMP(3),
    "declinedAt" TIMESTAMP(3),
    "declineReason" TEXT NOT NULL DEFAULT '',
    "signedIp" TEXT NOT NULL DEFAULT '',
    "signedUserAgent" TEXT NOT NULL DEFAULT '',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignatureSigner_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignatureField" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "signerId" TEXT,
    "type" "SignatureFieldType" NOT NULL,
    "page" INTEGER NOT NULL,
    "x" DOUBLE PRECISION NOT NULL,
    "y" DOUBLE PRECISION NOT NULL,
    "width" DOUBLE PRECISION NOT NULL,
    "height" DOUBLE PRECISION NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "value" TEXT,
    "filledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignatureField_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SignatureAuditEvent" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "signerId" TEXT,
    "type" TEXT NOT NULL,
    "ip" TEXT NOT NULL DEFAULT '',
    "userAgent" TEXT NOT NULL DEFAULT '',
    "detail" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SignatureAuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SignatureRequest_agencyId_idx" ON "SignatureRequest"("agencyId");

-- CreateIndex
CREATE INDEX "SignatureRequest_clientId_idx" ON "SignatureRequest"("clientId");

-- CreateIndex
CREATE INDEX "SignatureRequest_status_idx" ON "SignatureRequest"("status");

-- CreateIndex
CREATE INDEX "SignatureSigner_requestId_idx" ON "SignatureSigner"("requestId");

-- CreateIndex
CREATE INDEX "SignatureSigner_email_idx" ON "SignatureSigner"("email");

-- CreateIndex
CREATE INDEX "SignatureField_requestId_idx" ON "SignatureField"("requestId");

-- CreateIndex
CREATE INDEX "SignatureField_signerId_idx" ON "SignatureField"("signerId");

-- CreateIndex
CREATE INDEX "SignatureAuditEvent_requestId_idx" ON "SignatureAuditEvent"("requestId");

-- CreateIndex
CREATE INDEX "SignatureAuditEvent_at_idx" ON "SignatureAuditEvent"("at");

-- AddForeignKey
ALTER TABLE "SignatureRequest" ADD CONSTRAINT "SignatureRequest_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignatureRequest" ADD CONSTRAINT "SignatureRequest_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignatureSigner" ADD CONSTRAINT "SignatureSigner_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "SignatureRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignatureField" ADD CONSTRAINT "SignatureField_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "SignatureRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignatureField" ADD CONSTRAINT "SignatureField_signerId_fkey" FOREIGN KEY ("signerId") REFERENCES "SignatureSigner"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SignatureAuditEvent" ADD CONSTRAINT "SignatureAuditEvent_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "SignatureRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
