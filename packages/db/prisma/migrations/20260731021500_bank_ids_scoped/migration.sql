-- Provider ids are scoped to their parent, which is all SimpleFIN promises.
--
-- The spec says an account id "uniquely identifies the account within the
-- Connection", and that an organization "may reuse transaction ids for
-- different accounts, but may never reuse a transaction id within an account".
-- Held globally unique, a savings transaction numbered the same as a checking
-- one overwrites it and one of the two stops existing, silently and for good.
-- The bridge's own demo feed returns account ids as generic as "Demo Checking",
-- so this is not a theoretical collision.
--
-- itemId moves the same way. It was the access URL with credentials stripped,
-- which for SimpleFIN is the constant "beta-bridge.simplefin.org/simplefin" for
-- every operator alive, so the first workspace to link a bank locked out every
-- other one.

DROP INDEX "BankConnection_itemId_key";
CREATE UNIQUE INDEX "BankConnection_agencyId_itemId_key"
  ON "BankConnection"("agencyId", "itemId");

DROP INDEX "BankAccount_providerAccountId_key";
CREATE UNIQUE INDEX "BankAccount_connectionId_providerAccountId_key"
  ON "BankAccount"("connectionId", "providerAccountId");

DROP INDEX "BankTransaction_providerTransactionId_key";
CREATE UNIQUE INDEX "BankTransaction_accountId_providerTransactionId_key"
  ON "BankTransaction"("accountId", "providerTransactionId");
