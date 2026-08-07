import type { TranscriptSegment } from "@toreroflow/media";
import { env } from "./env";

export async function transcribe(sourcePath: string): Promise<{
  segments: TranscriptSegment[];
} | null> {
  try {
    const res = await fetch(`${env.CAPTIONS_URL}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: sourcePath }),
    });
    if (!res.ok) return null;
    return (await res.json()) as { segments: TranscriptSegment[] };
  } catch {
    return null; // captions service down: pipeline continues without captions
  }
}
