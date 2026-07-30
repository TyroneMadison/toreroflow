-- Identifies a brand in their own welcome link, so a reply arriving through a
-- form on the website can be matched back to them.
ALTER TABLE "Client" ADD COLUMN "onboardingToken" TEXT;
ALTER TABLE "Client" ADD COLUMN "onboardedAt" TIMESTAMP(3);
CREATE UNIQUE INDEX "Client_onboardingToken_key" ON "Client"("onboardingToken");
