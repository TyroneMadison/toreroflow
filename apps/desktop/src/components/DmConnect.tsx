import { useState } from "react";
import Pf from "./Pf";
import { useToast } from "./Toasts";
import { Ic } from "./analytics/phoneBits";
import { api, type DmStatus } from "../lib/api";
import { openExternal } from "../lib/external";

/** Instagram's own page on switching to a Business or Creator account. */
const PRO_HELP = "https://help.instagram.com/502981923235522";

/**
 * "Connect Instagram for DMs" (mockup 10-states, state a), above the inbox.
 *
 * Shown while an Instagram account still reads its DMs through Zernio. With
 * Torerone's Meta app not set up on the server (dark launch) the button is
 * off and says why; the threads below keep coming through Zernio either way.
 * Connecting mints a consent link, opens it and copies it: the client is
 * usually the one who signs in to Instagram, as with the Google link.
 */
export default function DmConnect({
  clientName,
  status,
  accountId,
  phone,
}: {
  clientName: string;
  status: DmStatus;
  accountId: string;
  phone: boolean;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const ready = status.native.configured;

  const connect = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ authUrl: string; handle: string; expiresInDays: number }>(`/oauth/instagram/start/${accountId}`);
      await navigator.clipboard.writeText(r.authUrl).catch(() => undefined);
      await openExternal(r.authUrl);
      toast.success(`Instagram sign-in for @${r.handle} opened and copied, good for ${r.expiresInDays} days. Send it to the client if they sign in.`);
    } catch (e) {
      toast.fail("Could not start the Instagram connection", e);
    } finally {
      setBusy(false);
    }
  };

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
          through Zernio below.
        </p>
      )}
    </section>
  );
}
