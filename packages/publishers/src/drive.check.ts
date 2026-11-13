// Drive folder listing and download with fetch injected: the exact requests
// made, that the key never rides a URL, and that the byte cap holds. No network.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DriveError, downloadDriveFile, listFolderVideos } from "./drive";

const KEY = "AIzaTESTKEY123";
const FOLDER = "1AbCdEfGhIjKlMnOpQ";
type Call = { url: string; key: string | null };

function fakeFetch(answer: (url: URL, n: number) => Response): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = [];
  const f = (async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, key: headers["X-Goog-Api-Key"] ?? null });
    return answer(new URL(url), calls.length);
  }) as typeof fetch;
  return { calls, fetch: f };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function rejects(p: Promise<unknown>, status: number, message: string) {
  await assert.rejects(p, (e: unknown) => e instanceof DriveError && e.status === status, message);
}

/* ---- listing follows every page ---- */
{
  const { calls, fetch } = fakeFetch((url, n) =>
    n === 1
      ? json({
          nextPageToken: "page2",
          files: [
            { id: "f1aaaaaaaaaa", name: "a.mp4", size: "1024", mimeType: "video/mp4", createdTime: "2026-11-08T10:00:00Z" },
            { id: "f2aaaaaaaaaa", name: "notes.pdf", size: "5", mimeType: "application/pdf", createdTime: "2026-11-08T10:00:00Z" },
          ],
        })
      : json({ files: [{ id: "f3aaaaaaaaaa", name: "B.MOV", mimeType: "application/octet-stream", createdTime: "2026-11-08T11:00:00Z" }] }),
  );
  const files = await listFolderVideos(FOLDER, { apiKey: KEY, base: "https://stub.test/drive/v3", fetch });
  assert.deepEqual(files, [
    { id: "f1aaaaaaaaaa", name: "a.mp4", mimeType: "video/mp4", size: 1024, createdTime: "2026-11-08T10:00:00Z" },
    { id: "f3aaaaaaaaaa", name: "B.MOV", mimeType: "application/octet-stream", size: null, createdTime: "2026-11-08T11:00:00Z" },
  ], "both pages, videos only, size as a number");
  assert.equal(calls.length, 2, "stops when there is no next page");
  const [first, second] = calls.map((c) => new URL(c.url));
  assert.equal(first!.origin + first!.pathname, "https://stub.test/drive/v3/files", "base is overridable");
  assert.equal(first!.searchParams.get("q"), `'${FOLDER}' in parents and trashed = false and mimeType != 'application/vnd.google-apps.folder'`);
  assert.equal(first!.searchParams.get("fields"), "nextPageToken,files(id,name,size,mimeType,createdTime)");
  assert.equal(first!.searchParams.get("supportsAllDrives"), "true");
  assert.equal(first!.searchParams.get("includeItemsFromAllDrives"), "true");
  assert.equal(first!.searchParams.has("pageToken"), false);
  assert.equal(second!.searchParams.get("pageToken"), "page2", "second page asked for by token");
  for (const c of calls) {
    assert.equal(c.key, KEY, "key sent in the header");
    assert.equal(c.url.includes(KEY), false, "key never in a URL");
    assert.equal(new URL(c.url).searchParams.has("key"), false, "no key param");
  }
}

/* ---- ids are refused before any request ---- */
{
  const { calls, fetch } = fakeFetch(() => json({ files: [] }));
  await rejects(listFolderVideos("x' or name contains 'a", { apiKey: KEY, fetch }), 400, "a quote never reaches the query");
  await rejects(listFolderVideos("short", { apiKey: KEY, fetch }), 400, "too short");
  await rejects(downloadDriveFile("../../etc/passwd", "unused", { apiKey: KEY, fetch, maxBytes: 10 }), 400, "a path never reaches the URL");
  assert.equal(calls.length, 0, "nothing was fetched");
  await rejects(listFolderVideos(FOLDER, { apiKey: "", fetch }), 0, "no key, no request");
  assert.equal(calls.length, 0);
}

/* ---- errors carry the status and a plain reason only ---- */
{
  const { fetch } = fakeFetch(() => json({ error: { message: `bad key ${KEY}` } }, 403));
  await assert.rejects(listFolderVideos(FOLDER, { apiKey: KEY, fetch }), (e: unknown) => {
    assert.ok(e instanceof DriveError);
    assert.equal(e.status, 403);
    assert.match(e.message, /Anyone with the link/);
    assert.equal(e.message.includes(KEY) || e.message.includes("http"), false, "no key or URL in the message");
    return true;
  });
  const down = (async () => {
    throw new TypeError(`fetch failed for https://x/?key=${KEY}`);
  }) as unknown as typeof fetch;
  await assert.rejects(listFolderVideos(FOLDER, { apiKey: KEY, fetch: down }), (e: unknown) =>
    e instanceof DriveError && e.status === 0 && !e.message.includes(KEY));
}

/* ---- download: streamed, capped, cleaned up ---- */
const dir = mkdtempSync(path.join(tmpdir(), "drive-check-"));
try {
  const chunks = (n: number, size: number) =>
    new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < n; i++) c.enqueue(new Uint8Array(size).fill(65));
        c.close();
      },
    });

  // Under the cap: written whole, key in the header only.
  {
    const dest = path.join(dir, "ok.mp4");
    const { calls, fetch } = fakeFetch(() => new Response(chunks(3, 100), { headers: { "Content-Type": "video/mp4" } }));
    const got = await downloadDriveFile("f1aaaaaaaaaa", dest, { apiKey: KEY, base: "https://stub.test/drive/v3", fetch, maxBytes: 1000 });
    assert.deepEqual(got, { bytes: 300, contentType: "video/mp4" });
    assert.equal(readFileSync(dest).length, 300);
    const u = new URL(calls[0]!.url);
    assert.equal(u.pathname, "/drive/v3/files/f1aaaaaaaaaa");
    assert.equal(u.searchParams.get("alt"), "media");
    assert.equal(calls[0]!.url.includes(KEY), false, "key never in the download URL");
    assert.equal(calls[0]!.key, KEY);
  }

  // Past the cap mid-stream: aborted and the partial file removed.
  {
    const dest = path.join(dir, "big.mp4");
    const { fetch } = fakeFetch(() => new Response(chunks(20, 100), { headers: { "Content-Type": "video/quicktime" } }));
    await rejects(downloadDriveFile("f1aaaaaaaaaa", dest, { apiKey: KEY, fetch, maxBytes: 1000 }), 413, "cap aborts the stream");
    assert.equal(existsSync(dest), false, "partial file removed");
  }

  // A declared length over the cap is refused before writing anything.
  {
    const dest = path.join(dir, "declared.mp4");
    const { fetch } = fakeFetch(() => new Response("x", { headers: { "Content-Type": "video/mp4", "Content-Length": "5000" } }));
    await rejects(downloadDriveFile("f1aaaaaaaaaa", dest, { apiKey: KEY, fetch, maxBytes: 1000 }), 413, "declared size over the cap");
    assert.equal(existsSync(dest), false);
  }

  // An HTML page (Drive's virus-scan or sign-in page) is not a video.
  {
    const dest = path.join(dir, "page.mp4");
    const { fetch } = fakeFetch(() => new Response("<html>", { headers: { "Content-Type": "text/html; charset=utf-8" } }));
    await rejects(downloadDriveFile("f1aaaaaaaaaa", dest, { apiKey: KEY, fetch, maxBytes: 1000 }), 415, "content-type guard");
    assert.equal(existsSync(dest), false);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("drive: all checks passed");
