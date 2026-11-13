import { REPORT_SENDER } from "@toreroflow/contracts";
import { env } from "../env";

/**
 * How the app sends email: from the Toreronee@gmail.com account, nowhere else.
 *
 * One function shape so the monthly report job can be run against a fake in
 * tests and against Gmail on the server. Nothing in the app calls Gmail
 * directly; everything that sends goes through a Mailer.
 */
export interface MailMessage {
  to: string;
  subject: string;
  text: string;
}
export interface Mailer {
  send(message: MailMessage): Promise<void>;
}

/** RFC 822 message, base64url, the shape Gmail's send endpoint takes. */
export function rawMessage(from: string, m: MailMessage): string {
  const subject = `=?UTF-8?B?${Buffer.from(m.subject, "utf8").toString("base64")}?=`;
  const lines = [
    `From: ${from}`,
    `To: ${m.to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from(m.text, "utf8").toString("base64"),
  ];
  return Buffer.from(lines.join("\r\n"), "utf8").toString("base64url");
}

/** The env vars the Toreronee@gmail.com sender needs, by name. */
export const GMAIL_ENV = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GMAIL_REFRESH_TOKEN"] as const;

/** Which of GMAIL_ENV are unset on this server. Empty means the sender can try. */
export function gmailMissing(): string[] {
  return GMAIL_ENV.filter((k) => !env[k]);
}

/** Trade the refresh token for an access token. Sends nothing. */
export async function gmailAccessToken(): Promise<string> {
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      refresh_token: env.GMAIL_REFRESH_TOKEN,
      grant_type: "refresh_token",
    }),
  });
  if (!tokenRes.ok) throw new Error(`Gmail token refresh ${tokenRes.status}`);
  return ((await tokenRes.json()) as { access_token: string }).access_token;
}

/**
 * Gmail API sender for the Toreronee@gmail.com account. Null when the account
 * is not connected (any of GMAIL_ENV unset), so the caller can say so instead
 * of failing halfway through a month of reports.
 */
export function gmailMailer(): Mailer | null {
  if (gmailMissing().length) return null;
  return {
    async send(message) {
      const access_token = await gmailAccessToken();
      const res = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
        method: "POST",
        headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ raw: rawMessage(REPORT_SENDER, message) }),
      });
      if (!res.ok) throw new Error(`Gmail send ${res.status}`);
    },
  };
}
