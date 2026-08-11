import { signedFilePath } from "@toreroflow/db";
import { env } from "./env";

/**
 * Delivery for reminder accounts: the client gets the video and the words,
 * because the platform gives nobody an API to their personal profile.
 *
 * Email through Resend's plain REST endpoint rather than an SDK, because the
 * whole integration is one POST. The download link is the same signed /files
 * URL the app itself uses, good for seven days, reachable because the API
 * answers on a public domain through the tunnel.
 */

export interface ReminderInput {
  toEmail: string;
  clientName: string;
  platform: string;
  handle: string;
  videoName: string;
  caption: string;
  /** Storage key of the original upload; null when the file is gone. */
  storageKey: string | null;
  scheduledAt: Date | null;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The signed public link, or null when the pieces for one are missing. */
export function reminderFileUrl(storageKey: string | null): string | null {
  if (!storageKey || !env.PUBLIC_API_URL || !env.JWT_SECRET) return null;
  return `${env.PUBLIC_API_URL}${signedFilePath(storageKey, env.JWT_SECRET)}`;
}

/** The email body, kept plain: the client's job is copy, save, post. */
export function reminderHtml(input: ReminderInput, fileUrl: string | null): string {
  const when = input.scheduledAt
    ? input.scheduledAt.toLocaleString("en-US", {
        weekday: "long",
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/New_York",
      })
    : "now";
  return `
<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1a1a1e">
  <h2 style="margin:18px 0 4px">Time to post to ${esc(input.platform)}</h2>
  <p style="margin:0 0 16px;color:#555">@${esc(input.handle)} · scheduled for ${esc(when)}</p>
  <p><b>${esc(input.videoName)}</b></p>
  ${
    fileUrl
      ? `<p><a href="${fileUrl}" style="display:inline-block;background:#FF6F61;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:bold">Download the video</a><br>
         <span style="font-size:12px;color:#888">The link works for 7 days.</span></p>`
      : `<p style="color:#888">Ask for the video file if you do not have it already.</p>`
  }
  <p style="margin-top:18px"><b>Caption, ready to paste:</b></p>
  <pre style="white-space:pre-wrap;background:#f5f5f7;border-radius:10px;padding:14px;font-family:inherit;font-size:14px">${esc(input.caption)}</pre>
  <p style="font-size:12px;color:#888;margin-top:22px">
    Sent by Toreroflow for ${esc(input.clientName)}. This account posts by hand
    on purpose: it is a personal profile, and no platform allows an app to post
    to one on your behalf.
  </p>
</div>`;
}

/** Sends the reminder. Throws with a plain reason so the target fails honestly. */
export async function sendReminder(input: ReminderInput): Promise<void> {
  if (!env.RESEND_API_KEY || !env.REMINDER_FROM) {
    throw new Error(
      "reminder delivery is not configured: set RESEND_API_KEY and REMINDER_FROM in the env",
    );
  }
  const fileUrl = reminderFileUrl(input.storageKey);
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.REMINDER_FROM,
      to: [input.toEmail],
      subject: `Post to ${input.platform} (@${input.handle}): ${input.videoName}`,
      html: reminderHtml(input, fileUrl),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    throw new Error(`resend: ${res.status} ${(await res.text()).slice(0, 300)}`);
  }
}
