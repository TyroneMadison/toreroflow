-- Brainstorm threads survive the window closing.
--
-- The whole thread lives in one JSONB column rather than a row per message:
-- it is only ever read and written whole, the same way EditProject.doc is, and
-- a thread capped at a couple of dozen turns is small.

CREATE TABLE "BrainstormChat" (
  "id" TEXT NOT NULL,
  "clientId" TEXT NOT NULL,
  "title" TEXT NOT NULL,
  "messages" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "BrainstormChat_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "BrainstormChat_clientId_idx" ON "BrainstormChat"("clientId");
ALTER TABLE "BrainstormChat" ADD CONSTRAINT "BrainstormChat_clientId_fkey"
  FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
