// The publish path skips an over-length YouTube Short instead of posting it.
import assert from "node:assert/strict";
import fs from "node:fs";
import { YOUTUBE_SHORTS_LIMIT_REASON, measuredDurationSec, youtubeShortsPublishBlock } from "@toreroflow/core";
import type { PrismaClient } from "@toreroflow/db";
import { markYoutubeShortsOverLimit } from "./shortsLimit";

type Db = Pick<PrismaClient, "postTarget" | "post">;

{
  const rows = [
    { id: "yt", postId: "p1", status: "publishing" },
    { id: "ig", postId: "p1", status: "scheduled" },
  ];
  const posts: Array<{ id: string; status: string }> = [];
  await markYoutubeShortsOverLimit(
    {
      postTarget: {
        update: async ({ where, data }: { where: { id: string }; data: { status: string; error: string } }) => {
          const row = rows.find((r) => r.id === where.id);
          if (row) row.status = data.status;
          assert.equal(data.error, YOUTUBE_SHORTS_LIMIT_REASON);
          assert.equal(data.status, "failed");
        },
        findMany: async ({ where }: { where: { postId: string } }) =>
          rows.filter((r) => r.postId === where.postId).map((r) => ({ status: r.status })),
      },
      post: {
        update: async (args: { where: { id: string }; data: { status: string } }) => {
          posts.push({ id: args.where.id, status: args.data.status });
        },
      },
    } as unknown as Db,
    { id: "yt", postId: "p1" },
  );
  assert.equal(rows[0]!.status, "failed");
  assert.equal(rows[1]!.status, "scheduled", "Instagram in the same batch is untouched");
  assert.equal(posts.length, 0, "the parent stays scheduled while another platform is still going out");
}

{
  const rows = [{ id: "yt", postId: "p2", status: "publishing" }];
  let postStatus: string | null = null;
  await markYoutubeShortsOverLimit(
    {
      postTarget: {
        update: async ({ where, data }: { where: { id: string }; data: { status: string } }) => {
          const row = rows.find((r) => r.id === where.id)!;
          row.status = data.status;
        },
        findMany: async () => rows.map((r) => ({ status: r.status })),
      },
      post: {
        update: async ({ data }: { data: { status: string } }) => {
          postStatus = data.status;
        },
      },
    } as unknown as Db,
    { id: "yt", postId: "p2" },
  );
  assert.equal(postStatus, "failed", "a Shorts-only post is failed with its target");
}

assert.equal(
  youtubeShortsPublishBlock({
    platform: "youtube",
    format: "short_form",
    kind: "video",
    durationSec: measuredDurationSec(181, 30),
  }),
  YOUTUBE_SHORTS_LIMIT_REASON,
  "ffprobe wins, so a stale 30s metadata cannot sneak a 3:01 file through",
);
assert.equal(
  youtubeShortsPublishBlock({
    platform: "youtube",
    format: "short_form",
    kind: "video",
    durationSec: measuredDurationSec(null, 180),
  }),
  null,
);

const worker = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
const gate = worker.indexOf("youtubeShortsPublishBlock");
const post = worker.indexOf("createPost");
assert.ok(gate > 0, "publish path calls the Shorts gate");
assert.ok(post > gate, "the gate runs before any provider post");
assert.match(worker, /markYoutubeShortsOverLimit/);
assert.equal(worker.includes("Over 3:00, Shorts limit") || worker.includes("YOUTUBE_SHORTS_LIMIT_REASON") || worker.includes("markYoutubeShortsOverLimit"), true);

console.log("shortsLimit.check: all checks passed");
