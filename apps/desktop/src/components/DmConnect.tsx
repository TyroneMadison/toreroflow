import { useState } from "react";
import Pf from "./Pf";
import { useToast } from "./Toasts";
import { Ic } from "./analytics/phoneBits";
import { api, type DmStatus } from "../lib/api";
import { openExternal } from "../lib/external";
import { navigate } from "../lib/routes";

/** Instagram's own page on switching to a Business or Creator account. */
const PRO_HELP = "https://help.instagram.com/502981923235522";

/**
 * Mint the Instagram consent link for one account, open it and copy it: the
 * client is usually the one who signs in to Instagram, as with the Google link.
 * Shared by Connect and the reconnect banner.
 */
export async function startInstagramConnect(accountId: string, toast: ReturnType<typeof useToast>): Promise<void> {
  try {
    const r = await api.post<{ authUrl: string; handle: string; expiresInDays: number }>(`/oauth/instagram/start/${accountId}`);
    await navigator.clipboard.writeText(r.authUrl).catch(() => undefined);
    await openExternal(r.authUrl);
    toast.success(`Instagram sign-in for @${r.handle} opened and copied, good for ${r.expiresInDays} days. Send it to the client if they sign in.`);
  } catch (e) {
    toast.fail("Could not start the Instagram connection", e);
  }
}

/**
 * "Connect Instagram for DMs" (mockup 10-states, state a).
 *
 * The whole Inbox until there is a conversation to show; above the list as
 * one line (compact) while an Instagram account still reads its DMs through
 * Zernio. With Torerone's Meta app not set up on the server (dark launch) the
 * button is off and says why; Zernio keeps the threads coming either way.
 * No Instagram account at all: the button goes to Connected Accounts.
 */
export default function DmConnect({
  clientName,
  status,
  accountId,
  phone,
  compact = false,
}: {
  clientName: string;
  status: DmStatus | null;
  accountId: string | null;
  phone: boolean;
  compact?: boolean;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const ready = !accountId || !!status?.native.configured;

  const connect = async () => {
    if (!accountId) return navigate("settings", "accounts");
    setBusy(true);
    await startInstagramConnect(accountId, toast);
    setBusy(false);
  };

  if (compact) {
    return (
      <div className="ibx-connectbar" data-testid="dm-connect">
        <Pf p="ig" size="xs" />
        <span>
          <b>Instagram DMs come through Zernio for now.</b>{" "}
          {ready ? "Connect Instagram for photos, voice notes and automations here." : "Torerone's Meta app is not switched on for this server yet."}
        </span>
        <button type="button" className={phone ? "mb-btn sm" : "btn sm"} disabled={!ready || busy} onClick={() => void connect()} data-testid={ready ? undefined : "dm-connect-pending"}>
          Connect Instagram
        </button>
      </div>
    );
  }

  return (
    <section className={phone ? "mb-card dmc dmc-ph" : "card glass dmc"} data-testid="dm-connect">
      <span className="dmc-ei">
        <Pf p="ig" size="lg" />
      </span>
      <h3>Connect Instagram for DMs</h3>
      <p>
        Read and answer {clientName}'s Instagram DMs here, and run comment-to-DM automations. You sign in with Instagram,
        through Torerone's Meta app.
      </p>
      <div className="dmc-why">
        <span>
          <Ic name="i-check-circle" />
          Replies, reactions and voice notes in one Inbox
        </span>
        <span>
          <Ic name="i-check-circle" />
          Comment, story and DM keyword automations
        </span>
        <span className="info">
          <Ic name="i-info" />
          The account must be a professional account (Business or Creator)
        </span>
      </div>
      {phone ? (
        <>
          <button type="button" className="mb-btn pri dmc-block" disabled={!ready || busy} onClick={() => void connect()}>
            <Pf p="ig" size="sm" />
            Connect Instagram
          </button>
          <button type="button" className="dmc-link" onClick={() => void openExternal(PRO_HELP)}>
            How to switch to a professional account
          </button>
        </>
      ) : (
        <div className="dmc-acts">
          <button type="button" className="btn pri" disabled={!ready || busy} onClick={() => void connect()}>
            <Pf p="ig" size="xs" />
            Connect Instagram
          </button>
          <button type="button" className="btn ghost" onClick={() => void openExternal(PRO_HELP)}>
            How to switch to professional
          </button>
        </div>
      )}
      {!ready && (
        <p className="dmc-note" data-testid="dm-connect-pending">
          Torerone's Meta app is not switched on for this server yet, so this waits. Until then these DMs keep coming
          through Zernio.
        </p>
      )}
    </section>
  );
}
