-- Handles the client gave for themselves, keyed by platform. Not connected
-- accounts: a typed handle cannot post, and a connected account only ever comes
-- back from the provider.
ALTER TABLE "Client" ADD COLUMN "handles" JSONB;
