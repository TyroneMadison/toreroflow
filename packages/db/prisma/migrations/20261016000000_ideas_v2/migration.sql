-- Ideas v2: saved ideas keep their script, source creator and a done tick.
ALTER TABLE "ContentIdea" ADD COLUMN "scriptText" TEXT;
ALTER TABLE "ContentIdea" ADD COLUMN "creator" TEXT;
ALTER TABLE "ContentIdea" ADD COLUMN "completed" BOOLEAN NOT NULL DEFAULT false;
