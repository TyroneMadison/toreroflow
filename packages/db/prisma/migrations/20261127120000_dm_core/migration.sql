-- DMs (F2): Instagram through our own Meta app, Messenger read through Zernio.
-- New tables only; nothing existing is altered, so the migration is safe on a
-- live database and a rollback is dropping these seven tables.

-- CreateTable
CREATE TABLE "DmAccount" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "socialAccountId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "transport" TEXT NOT NULL DEFAULT 'zernio',
    "externalId" TEXT,
    "username" TEXT,
    "platformConnectionId" TEXT,
    "accessTokenEnc" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "tokenRefreshedAt" TIMESTAMP(3),
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" TEXT NOT NULL DEFAULT 'active',
    "error" TEXT,
    "lastSyncAt" TIMESTAMP(3),
    "lastWebhookAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DmAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DmContact" (
    "id" TEXT NOT NULL,
    "dmAccountId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "displayName" TEXT,
    "handle" TEXT,
    "avatarUrl" TEXT,
    "stage" TEXT NOT NULL DEFAULT 'new',
    "notes" TEXT,
    "optIn" BOOLEAN NOT NULL DEFAULT false,
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DmContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DmThread" (
    "id" TEXT NOT NULL,
    "dmAccountId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'open',
    "unread" INTEGER NOT NULL DEFAULT 0,
    "pausedAt" TIMESTAMP(3),
    "lastMessageAt" TIMESTAMP(3),
    "lastPreview" TEXT,
    "lastDirection" TEXT,
    "lastInboundAt" TIMESTAMP(3),
    "windowEndsAt" TIMESTAMP(3),
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DmThread_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DmMessage" (
    "id" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "text" TEXT,
    "attachments" JSONB,
    "replyToExternalId" TEXT,
    "reactions" JSONB,
    "unsentAt" TIMESTAMP(3),
    "editedAt" TIMESTAMP(3),
    "transcript" TEXT,
    "status" TEXT NOT NULL DEFAULT 'sent',
    "error" TEXT,
    "sentByUserId" TEXT,
    "sentAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DmMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DmWebhookEvent" (
    "id" TEXT NOT NULL,
    "object" TEXT,
    "payload" JSONB,
    "signatureOk" BOOLEAN NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "DmWebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DmTag" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DmTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DmContactTag" (
    "contactId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DmContactTag_pkey" PRIMARY KEY ("contactId","tagId")
);

-- CreateIndex
CREATE UNIQUE INDEX "DmAccount_socialAccountId_key" ON "DmAccount"("socialAccountId");

-- CreateIndex
CREATE INDEX "DmAccount_clientId_idx" ON "DmAccount"("clientId");

-- CreateIndex
CREATE INDEX "DmAccount_transport_status_idx" ON "DmAccount"("transport", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DmAccount_platform_externalId_key" ON "DmAccount"("platform", "externalId");

-- CreateIndex
CREATE INDEX "DmContact_dmAccountId_lastSeenAt_idx" ON "DmContact"("dmAccountId", "lastSeenAt");

-- CreateIndex
CREATE UNIQUE INDEX "DmContact_dmAccountId_externalId_key" ON "DmContact"("dmAccountId", "externalId");

-- CreateIndex
CREATE INDEX "DmThread_dmAccountId_lastMessageAt_idx" ON "DmThread"("dmAccountId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "DmThread_dmAccountId_status_idx" ON "DmThread"("dmAccountId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "DmThread_dmAccountId_contactId_key" ON "DmThread"("dmAccountId", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "DmThread_dmAccountId_externalId_key" ON "DmThread"("dmAccountId", "externalId");

-- CreateIndex
CREATE INDEX "DmMessage_threadId_sentAt_idx" ON "DmMessage"("threadId", "sentAt");

-- CreateIndex
CREATE INDEX "DmMessage_externalId_idx" ON "DmMessage"("externalId");

-- CreateIndex
CREATE UNIQUE INDEX "DmMessage_threadId_externalId_key" ON "DmMessage"("threadId", "externalId");

-- CreateIndex
CREATE INDEX "DmWebhookEvent_signatureOk_receivedAt_idx" ON "DmWebhookEvent"("signatureOk", "receivedAt");

-- CreateIndex
CREATE INDEX "DmWebhookEvent_processedAt_idx" ON "DmWebhookEvent"("processedAt");

-- CreateIndex
CREATE UNIQUE INDEX "DmTag_clientId_name_key" ON "DmTag"("clientId", "name");

-- CreateIndex
CREATE INDEX "DmContactTag_tagId_idx" ON "DmContactTag"("tagId");

-- AddForeignKey
ALTER TABLE "DmAccount" ADD CONSTRAINT "DmAccount_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DmAccount" ADD CONSTRAINT "DmAccount_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DmAccount" ADD CONSTRAINT "DmAccount_platformConnectionId_fkey" FOREIGN KEY ("platformConnectionId") REFERENCES "PlatformConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DmContact" ADD CONSTRAINT "DmContact_dmAccountId_fkey" FOREIGN KEY ("dmAccountId") REFERENCES "DmAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DmThread" ADD CONSTRAINT "DmThread_dmAccountId_fkey" FOREIGN KEY ("dmAccountId") REFERENCES "DmAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DmThread" ADD CONSTRAINT "DmThread_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "DmContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DmMessage" ADD CONSTRAINT "DmMessage_threadId_fkey" FOREIGN KEY ("threadId") REFERENCES "DmThread"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DmTag" ADD CONSTRAINT "DmTag_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DmContactTag" ADD CONSTRAINT "DmContactTag_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "DmContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DmContactTag" ADD CONSTRAINT "DmContactTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "DmTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

