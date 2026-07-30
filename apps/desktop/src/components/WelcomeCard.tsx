import { useState } from "react";
import { api } from "../lib/api";
import { useToast } from "./Toasts";
import { useAppState } from "../state/AppState";

/**
 * The link a client gets after they pay, and the replies coming back.
 *
 * Two halves, because they happen days apart. Pressing Get the link mints it
 * once and keeps it: the link may already be sitting in a client's messages,
 * and a new one would break the old. Pressing Check for replies reads what has
 * come in from the website and fills the blanks it can.
 *
 * The connect links go to the publishing provider's own hosted pages, which is
 * what lets a client authorise their accounts from a phone without this app
 * being reachable from anywhere.
 */

interface WelcomeLink {
  url: string;
  token: string;
  connect: Array<{ platform: string; url: string }>;
  onboardedAt: string | null;
  note: string | null;
}

interface CheckResult {
  checked: number;
  applied: Array<{ client: string; filled: string[]; handles: number }>;
  unmatched: number;
}

export default function WelcomeCard() {
  const toast = useToast();
  const { selectedClient } = useAppState();
  const [link, setLink] = useState<WelcomeLink | null>(null);
  const [busy, setBusy] = useState(false);

  if (!selectedClient) return null;

  const getLink = async () => {
    setBusy(true);
    try {
      setLink(await api.post<WelcomeLink>(`/clients/${selectedClient.id}/welcome-link`));
    } catch (err) {
      toast.fail("Could not make a welcome link", err);
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success(`${what} copied.`);
    } catch (err) {
      toast.fail(`Could not copy the ${what.toLowerCase()}`, err);
    }
  };

  const check = async () => {
    setBusy(true);
    try {
      const result = await api.post<CheckResult>("/onboarding/check");
      if (result.applied.length === 0) {
        toast.success(
          result.checked === 0
            ? "No replies yet."
            : `${result.checked} replies, nothing new to fill in.`,
        );
      } else {
        const names = result.applied.map((a) => a.client).join(", ");
        toast.success(`Filled in details for ${names}.`);
      }
    } catch (err) {
      toast.fail("Could not check for replies", err);
    } finally {
      setBusy(false);
    }
  };

  /** Everything to send, as one message he can paste into a text. */
  const message = link
    ? [
        `Welcome aboard. Two quick things:`,
        ``,
        `1. Fill this in, it takes a minute: ${link.url}`,
        ...(link.connect.length
          ? [
              ``,
              `2. Connect your accounts, one tap each:`,
              ...link.connect.map((c) => `   ${c.platform}: ${c.url}`),
            ]
          : []),
      ].join("\n")
    : "";

  return (
    <div className="card glass setsec">
      <div className="rowhead">
        <div>
          <h3>Welcome link</h3>
          <div className="sub">
            Send this to {selectedClient.name} once they have paid. They fill in their details
            and connect their own accounts from their phone, and it lands here.
          </div>
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button className="cbtn" disabled={busy} onClick={() => void getLink()}>
            {link ? "Refresh" : "Get the link"}
          </button>
          <button className="btn ghost" disabled={busy} onClick={() => void check()}>
            Check for replies
          </button>
        </div>
      </div>

      {link && (
        <>
          {link.onboardedAt && (
            <p className="insworking" style={{ marginTop: 10 }}>
              They replied on {new Date(link.onboardedAt).toLocaleDateString()}. Sending the
              link again is fine: a reply only ever fills what is still blank.
            </p>
          )}
          {link.note && (
            <p className="insworking" style={{ marginTop: 10 }}>
              {link.note}
            </p>
          )}

          <div className="best" style={{ marginTop: 12 }}>
            <div className="l" style={{ wordBreak: "break-all" }}>
              {link.url}
            </div>
            <button className="cbtn" onClick={() => void copy(link.url, "Link")}>
              Copy
            </button>
          </div>

          {link.connect.map((c) => (
            <div className="best" key={c.platform}>
              <div className="l">
                Connect {c.platform}
                <span style={{ color: "var(--txt-3)" }}> · they tap this on their phone</span>
              </div>
              <button className="cbtn" onClick={() => void copy(c.url, `${c.platform} link`)}>
                Copy
              </button>
            </div>
          ))}

          <div className="best">
            <div className="l">
              <b>The whole message</b>
              <div className="sub">Link and connect taps together, ready to paste into a text.</div>
            </div>
            <button className="cbtn" onClick={() => void copy(message, "Message")}>
              Copy
            </button>
          </div>
        </>
      )}
    </div>
  );
}
