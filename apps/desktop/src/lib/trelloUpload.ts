import { TRELLO_MAX_BYTES, linkTrelloAttachment, uploadMedia, uploadTrelloAttachment } from "./api";

export type FileRoute = "trello" | "link";
export interface QueuedFile {
  key: string;
  file: File;
  route: FileRoute;
  status: "queued" | "uploading" | "done" | "failed";
  pct: number;
  error?: string;
}

/** Files up to 250 MB go to Trello; bigger ones are stored in Toreroflow and linked. */
export function routeFor(size: number): FileRoute {
  return size > TRELLO_MAX_BYTES ? "link" : "trello";
}

export function queue(files: File[]): QueuedFile[] {
  return files.map((file, i) => ({ key: `${Date.now()}-${i}-${file.name}`, file, route: routeFor(file.size), status: "queued", pct: 0 }));
}

/** One file, one at a time (Trello rate-limits per token). */
export async function sendOne(cardId: string, clientId: string, f: QueuedFile, onPct: (pct: number) => void): Promise<void> {
  if (f.route === "trello") {
    try {
      await uploadTrelloAttachment(cardId, f.file, onPct);
      return;
    } catch (e) {
      // The server can still refuse for size (multipart overhead); fall through to a link.
      if ((e as { status?: number }).status !== 413) throw e;
    }
  }
  onPct(10);
  const asset = await uploadMedia(clientId, f.file);
  onPct(90);
  await linkTrelloAttachment(cardId, asset.id);
}

export function fmtSize(n: number): string {
  return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${(n / 1024 ** 2).toFixed(1)} MB`;
}
