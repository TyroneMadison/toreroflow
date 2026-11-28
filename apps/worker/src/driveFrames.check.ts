// Recent videos pictures from Drive, with real ffmpeg against a local stand-in
// for Drive that answers range requests the way Drive does. The key travels in
// the X-Goog-Api-Key header only; a gone file is marked so it is not asked
// again, a busy Drive is tried next check, and one check takes at most 4.
//   pnpm --filter @toreroflow/worker test
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const KEY = "frame-check-key";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tf-frames-"));
const storage = path.join(tmp, "storage");
fs.mkdirSync(storage);

// A 3 s clip with its index at the end (no faststart), the shape that makes ffmpeg seek.
const video = path.join(tmp, "clip.mp4");
const made = spawnSync(process.env.FFMPEG_PATH ?? "ffmpeg", [
  "-y", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=360x640:rate=30:duration=3", "-pix_fmt", "yuv420p", video,
]);
assert.equal(made.status, 0, `ffmpeg made the clip: ${made.stderr}`);
const bytes = fs.readFileSync(video);

const seen: Array<{ url: string; key: string | undefined; range: string | undefined }> = [];
const server = http.createServer((req, res) => {
  seen.push({ url: req.url ?? "", key: req.headers["x-goog-api-key"] as string | undefined, range: req.headers.range });
  if (req.headers["x-goog-api-key"] !== KEY) return void res.writeHead(403).end();
  const id = /\/files\/([^?]+)/.exec(req.url ?? "")?.[1];
  if (id === "busyaaaaaaaa") return void res.writeHead(503).end();
  if (id !== "goodaaaaaaaa" && id !== "good2aaaaaaa" && id !== "good3aaaaaaa") return void res.writeHead(404).end();
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? "");
  const start = m ? Number(m[1]) : 0;
  const end = m && m[2] ? Number(m[2]) : bytes.length - 1;
  res.writeHead(m ? 206 : 200, {
    "content-type": "video/mp4",
    "accept-ranges": "bytes",
    "content-length": end - start + 1,
    ...(m ? { "content-range": `bytes ${start}-${end}/${bytes.length}` } : {}),
  });
  res.end(bytes.subarray(start, end + 1));
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;

delete process.env.DATABASE_URL;
process.env.GOOGLE_DRIVE_API_KEY = KEY;
process.env.DRIVE_API_BASE = `http://127.0.0.1:${port}/drive/v3`;
process.env.STORAGE_DIR = storage;

const { getPrisma } = await import("@toreroflow/db");
const { driveFrames, frameFailureFinal } = await import("./drive");

/* ---- which ffmpeg failures are final for the row ---- */

assert.equal(frameFailureFinal("ffmpeg exited 8: [http @ 0x1] HTTP error 404 Not Found ... Server returned 404 Not Found"), true, "gone");
assert.equal(frameFailureFinal("ffmpeg exited 1: Server returned 403 Forbidden (access denied)"), true, "not shared");
assert.equal(frameFailureFinal("ffmpeg exited 1: x.mp4: Invalid data found when processing input"), true, "not a video");
assert.equal(frameFailureFinal("ffmpeg exited 1: Server returned 5XX Server Error reply"), false, "Drive busy: next check");
assert.equal(frameFailureFinal("ffmpeg exited 1: Connection timed out"), false, "a timeout: next check");
assert.equal(frameFailureFinal("ffmpeg exited 1: Server returned 429 Too Many Requests"), false, "rate limited: next check");

/* ---- the backfill, against the stand-in ---- */

type Row = { id: string; clientId: string; fileId: string; assetId: string | null; thumbKey: string | null; createdAt: Date };
const t = (n: number) => new Date(Date.UTC(2026, 10, 27, 12, 0, 60 - n));
const rows: Row[] = [
  { id: "r1", clientId: "c1", fileId: "goodaaaaaaaa", assetId: null, thumbKey: null, createdAt: t(1) }, // skipped, never downloaded
  { id: "r2", clientId: "c1", fileId: "goneaaaaaaaa", assetId: null, thumbKey: null, createdAt: t(2) }, // deleted from Drive
  { id: "r3", clientId: "c1", fileId: "haveaaaaaaaa", assetId: "a3", thumbKey: null, createdAt: t(3) }, // upload has thumb.jpg
  { id: "r4", clientId: "c1", fileId: "good2aaaaaaa", assetId: "a4", thumbKey: null, createdAt: t(4) }, // thumb.jpg missing
  { id: "r5", clientId: "c1", fileId: "procaaaaaaaa", assetId: "a5", thumbKey: null, createdAt: t(5) }, // still processing
  { id: "r6", clientId: "c1", fileId: "triedaaaaaaa", assetId: null, thumbKey: "", createdAt: t(6) }, // Drive said no before
  { id: "r7", clientId: "c1", fileId: "busyaaaaaaaa", assetId: null, thumbKey: null, createdAt: t(7) }, // Drive answers 503
  { id: "r8", clientId: "c1", fileId: "good3aaaaaaa", assetId: null, thumbKey: null, createdAt: t(8) }, // past the per-check cap
  { id: "x1", clientId: "c2", fileId: "goodaaaaaaaa", assetId: null, thumbKey: null, createdAt: t(0) }, // another client
];
const asset = (id: string, status: string) => ({ id, clientId: "c1", kind: "video", status, coverKey: null, thumbDeletedAt: null, updatedAt: t(0) });
const assets = [asset("a3", "ready"), asset("a4", "ready"), asset("a5", "processing")];
fs.mkdirSync(path.join(storage, "c1", "a3"), { recursive: true });
fs.writeFileSync(path.join(storage, "c1", "a3", "thumb.jpg"), "jpeg");

const prisma = getPrisma();
const stub = (name: string, value: unknown) => Object.defineProperty(prisma, name, { value });
stub("driveImport", {
  findMany: async ({ where, take }: any) =>
    rows
      .filter((r) => r.clientId === where.clientId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, take),
  update: async ({ where, data }: any) => Object.assign(rows.find((r) => r.id === where.id)!, data),
});
stub("mediaAsset", { findMany: async ({ where }: any) => assets.filter((a) => where.id.in.includes(a.id) && a.clientId === where.clientId) });

const key = (id: string) => rows.find((r) => r.id === id)!.thumbKey;
const jpeg = (k: string) => fs.readFileSync(path.join(storage, k)).subarray(0, 2).toString("hex") === "ffd8";

assert.equal(await driveFrames("c1"), 4, "one check takes four");
assert.equal(key("r1"), "c1/drive-frames/goodaaaaaaaa.jpg", "a skipped file gets a frame");
assert.ok(jpeg(key("r1")!), "and it is a real JPEG");
assert.equal(key("r2"), "", "a gone file is marked, not asked again");
assert.equal(key("r3"), null, "an upload with its thumbnail needs nothing");
assert.equal(key("r4"), "c1/drive-frames/good2aaaaaaa.jpg", "a missing thumb.jpg is filled from Drive");
assert.ok(jpeg(key("r4")!));
assert.equal(key("r5"), null, "an upload still processing makes its own");
assert.equal(key("r6"), "", "Drive is not asked again");
assert.equal(key("r7"), null, "Drive busy: tried next check");
assert.equal(key("r8"), null, "past the cap: next check");
assert.equal(key("x1"), null, "another client's rows are untouched");

assert.equal(await driveFrames("c1"), 2, "the next check takes the busy one again and the one past the cap");
assert.equal(key("r8"), "c1/drive-frames/good3aaaaaaa.jpg");
assert.equal(key("r7"), null, "still busy, still waiting");

assert.ok(seen.length > 0 && seen.every((s) => s.key === KEY), "every request carries the key in the header");
assert.ok(seen.every((s) => !s.url.includes(KEY)), "and never in the URL");
assert.ok(seen.some((s) => s.range), "ffmpeg reads with range requests, not a whole download");
assert.ok(seen.every((s) => /^\/drive\/v3\/files\/[A-Za-z0-9_-]+\?alt=media&supportsAllDrives=true$/.test(s.url)), "the Drive media URL");

server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log("driveFrames.check.ts: ok");
