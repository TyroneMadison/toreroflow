-- The worker's "I am alive" signal, moving off Redis.
--
-- One row, stamped every 30 seconds. It was a Redis key with a TTL so it
-- expired by itself when the worker died. Postgres has no TTL, so the reader
-- judges it by age. The property that matters is the same either way: a killed
-- worker cannot clear anything on its way out, so this has to go stale on its
-- own rather than depend on being cleaned up.

CREATE TABLE "WorkerHeartbeat" (
  "id" TEXT NOT NULL DEFAULT 'worker',
  "beatAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WorkerHeartbeat_pkey" PRIMARY KEY ("id")
);
