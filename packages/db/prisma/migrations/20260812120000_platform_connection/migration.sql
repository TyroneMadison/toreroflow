-- Direct platform API credentials, alongside the publishing provider.
--
-- Separate from SocialAccount.tokensEncrypted on purpose: that column is what
-- the publish path branches on, so a refresh token written there would route
-- every YouTube post to the dry-run publisher while the calendar still said
-- "posted".

CREATE TABLE "PlatformConnection" (
    "id" TEXT NOT NULL,
    "socialAccountId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "externalId" TEXT NOT NULL,
    "externalName" TEXT,
    "refreshTokenEnc" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "error" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "connectedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlatformConnection_pkey" PRIMARY KEY ("id")
);

-- One direct connection per account, so re-authorizing replaces rather than
-- stacks a second credential nobody would know was there.
CREATE UNIQUE INDEX "PlatformConnection_socialAccountId_key" ON "PlatformConnection"("socialAccountId");

CREATE INDEX "PlatformConnection_platform_status_idx" ON "PlatformConnection"("platform", "status");

ALTER TABLE "PlatformConnection" ADD CONSTRAINT "PlatformConnection_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;
