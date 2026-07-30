-- The bank's own id, which survives a relink where itemId does not.
-- Needed so a second link to an already connected bank can be refused: both
-- items' accounts default into cash flow and every figure would double.
ALTER TABLE "BankConnection" ADD COLUMN "institutionId" TEXT;

CREATE INDEX "BankConnection_agencyId_institutionId_idx"
  ON "BankConnection"("agencyId", "institutionId");
