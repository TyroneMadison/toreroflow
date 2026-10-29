-- Calendar: days the operator marked as posted to X by hand.
CREATE TABLE "XPostedDay" (
    "clientId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "XPostedDay_pkey" PRIMARY KEY ("clientId","date")
);

ALTER TABLE "XPostedDay" ADD CONSTRAINT "XPostedDay_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
