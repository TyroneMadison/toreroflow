-- Additive only: one metrics row per external video per UTC day, the
-- rolling view-count history that outlives Zernio's one-year window.
CREATE TABLE "ExternalVideoMetric" (
    "id" TEXT NOT NULL,
    "externalVideoId" TEXT NOT NULL,
    "capturedOn" DATE NOT NULL,
    "views" INTEGER NOT NULL DEFAULT 0,
    "likes" INTEGER NOT NULL DEFAULT 0,
    "comments" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalVideoMetric_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ExternalVideoMetric_externalVideoId_capturedOn_key" ON "ExternalVideoMetric"("externalVideoId", "capturedOn");

ALTER TABLE "ExternalVideoMetric" ADD CONSTRAINT "ExternalVideoMetric_externalVideoId_fkey" FOREIGN KEY ("externalVideoId") REFERENCES "ExternalVideo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
