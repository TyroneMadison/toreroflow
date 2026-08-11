-- A post target on a reminder account never publishes itself: the app sends
-- the client the video and the words, and the client posts by hand. That is
-- a different fact from "posted" and from "failed", so it gets its own value
-- rather than borrowing one that would lie.
ALTER TYPE "PostTargetStatus" ADD VALUE IF NOT EXISTS 'reminded';
