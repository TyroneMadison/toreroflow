-- CreateTable
CREATE TABLE "ExternalVideo" (
    "id" TEXT NOT NULL,
    "socialAccountId" TEXT NOT NULL,
    "platform" "Platform" NOT NULL,
    "platformVideoId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "thumbnailUrl" TEXT,
    "url" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "comments" INTEGER NOT NULL DEFAULT 0,
    "durationSec" DOUBLE PRECISION,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalVideo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ExternalVideo_socialAccountId_views_idx" ON "ExternalVideo"("socialAccountId", "views");

-- CreateIndex
CREATE INDEX "ExternalVideo_socialAccountId_publishedAt_idx" ON "ExternalVideo"("socialAccountId", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalVideo_socialAccountId_platformVideoId_key" ON "ExternalVideo"("socialAccountId", "platformVideoId");

-- AddForeignKey
ALTER TABLE "ExternalVideo" ADD CONSTRAINT "ExternalVideo_socialAccountId_fkey" FOREIGN KEY ("socialAccountId") REFERENCES "SocialAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
