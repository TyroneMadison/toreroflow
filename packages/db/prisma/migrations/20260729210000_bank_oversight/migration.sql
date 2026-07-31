-- Bank oversight: read-only balances and transactions for the agency's own
-- account, read through SimpleFIN.
--
-- Nothing in this feature can move money. The provider has one endpoint and it
-- is a GET, so that is a property of the protocol rather than a rule the app
-- keeps. The stored credential is the access URL SimpleFIN returns when a
-- setup token is claimed, encrypted at rest like every other secret.

-- CreateTable
CREATE TABLE "BankConnection" (
    "id" TEXT NOT NULL,
    "agencyId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "institutionId" TEXT,
    "institutionName" TEXT,
    "accessTokenEnc" TEXT NOT NULL,
    -- The last day the feed was read through, ISO "2026-07-31". The provider is
    -- queried by date range rather than by change cursor.
    "syncedThrough" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "error" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankAccount" (
    "id" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "officialName" TEXT,
    "mask" TEXT,
    "currentCents" INTEGER,
    "availableCents" INTEGER,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    -- Starts true: the provider reports no account type, so there is nothing to
    -- decide from, and a default that is visibly too generous beats one that
    -- silently drops the account the business actually runs on.
    "includeInCashFlow" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BankTransaction" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "providerTransactionId" TEXT NOT NULL,
    -- A date, not an instant, stored as text so it cannot slide into the
    -- previous month by timezone. Month totals are the point of this feature.
    "date" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "merchantName" TEXT,
    -- Integer cents in our convention: positive means money arrived.
    "amountCents" INTEGER NOT NULL,
    "pending" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankTransaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BankConnection_itemId_key" ON "BankConnection"("itemId");

-- CreateIndex
CREATE INDEX "BankConnection_agencyId_idx" ON "BankConnection"("agencyId");

-- CreateIndex
CREATE INDEX "BankConnection_agencyId_institutionId_idx" ON "BankConnection"("agencyId", "institutionId");

-- CreateIndex
CREATE UNIQUE INDEX "BankAccount_providerAccountId_key" ON "BankAccount"("providerAccountId");

-- CreateIndex
CREATE INDEX "BankAccount_connectionId_idx" ON "BankAccount"("connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "BankTransaction_providerTransactionId_key" ON "BankTransaction"("providerTransactionId");

-- CreateIndex
CREATE INDEX "BankTransaction_accountId_date_idx" ON "BankTransaction"("accountId", "date");

-- AddForeignKey
ALTER TABLE "BankConnection" ADD CONSTRAINT "BankConnection_agencyId_fkey" FOREIGN KEY ("agencyId") REFERENCES "Agency"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankAccount" ADD CONSTRAINT "BankAccount_connectionId_fkey" FOREIGN KEY ("connectionId") REFERENCES "BankConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BankTransaction" ADD CONSTRAINT "BankTransaction_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "BankAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
