-- Ideas v2: shot list + drawn GIFs per saved idea, GIF bytes cached by hash.
ALTER TABLE "ContentIdea" ADD COLUMN "shots" JSONB;
ALTER TABLE "ContentIdea" ADD COLUMN "gifs" JSONB;
CREATE TABLE "IdeaGif" (
    "key" TEXT NOT NULL,
    "bytes" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IdeaGif_pkey" PRIMARY KEY ("key")
);
