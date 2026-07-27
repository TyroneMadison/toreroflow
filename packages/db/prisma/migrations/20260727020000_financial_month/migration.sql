-- CreateTable
CREATE TABLE "FinancialMonth" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FinancialMonth_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FinancialMonth_agencyId_month_key" ON "FinancialMonth"("agencyId", "month");

-- AddForeignKey
ALTER TABLE "FinancialMonth" ADD CONSTRAINT "FinancialMonth_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

