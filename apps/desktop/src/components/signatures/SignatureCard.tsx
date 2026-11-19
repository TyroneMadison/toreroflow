import { useCallback, useEffect, useState } from "react";
import Stat from "../glass/Stat";
import SignatureBuilder from "./SignatureBuilder";
import { useRequestActions } from "./useRequestActions";
import { useToast } from "../Toasts";
import { api, API_URL, type SignatureRequest, type SignatureSummary } from "../../lib/api";
import { openExternal } from "../../lib/external";
import { progress, statusLine, TONE, waitingOn } from "../../lib/signatures";
import "./signatures.css";

/**
 * Documents out for signature, on Account Overview.
 *
 * The counts come from /signature-requests/summary rather than from the list,
 * so opening this screen does not pull every signer and every field box of
 * every contract ever sent.
 */

export default function SignatureCard() {
  const toast = useToast();
  const [summary, setSummary] = useState<SignatureSummary | null>(null);
  const [building, setBuilding] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setSummary(await api.get<SignatureSummary>("/signature-requests/summary"));
    } catch (err) {
      toast.fail("Could not load the signature list", err);
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Opening and acting on one contract is shared with the Contracts screen.
  const { open, setOpen, openRequest, act, voidRequest } = useRequestActions(load);

  return (
    <aside className="sg-card glass-z1" data-testid="signatures.card">
      <div className="sg-card-head">
        <div className="tf-lbl">Documents to sign</div>
        <button type="button" className="tf-btn" onClick={() => setBuilding(true)} data-testid="signatures.new">
          + Send one
        </button>
      </div>

      <div className="sg-card-stats">
        <Stat label="Out for signature" value={summary?.awaitingOthers ?? "-"} tone={summary?.awaitingOthers ? "info" : undefined} />
        <Stat label="Signed" value={summary?.completed ?? "-"} tone="ok" />
        <Stat
          label="Expiring soon"
          value={summary?.expiringSoon ?? "-"}
          sub="within 3 days"
          tone={summary?.expiringSoon ? "bad" : undefined}
        />
      </div>

      {loading ? (
        <p className="sg-note">Checking…</p>
      ) : !summary?.recent.length ? (
        <p className="sg-note">
          Nothing sent yet. Upload a contract, drop the signature boxes where they go, and it is emailed
          to whoever has to sign.
        </p>
      ) : (
        <ul className="sg-list" data-testid="signatures.list">
          {summary.recent.map((r) => (
            <li key={r.id}>
              <button type="button" className="sg-item" onClick={() => void openRequest(r.id)} data-testid={`signatures.item-${r.id}`}>
                <span className="sg-item-txt">
                  <b>{r.title}</b>
                  <small>{progress(r.signedCount, r.signerCount)}</small>
                </span>
                <span className={`sg-badge ${TONE[r.status] ?? ""}`}>{r.status}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {building && (
        <SignatureBuilder
          onClose={() => setBuilding(false)}
          onSent={(r) => {
            void load();
            // Straight into the contract, where the signing links are, as the Contracts page does.
            setOpen(r);
          }}
        />
      )}

      {open && (
        <RequestDetail
          r={open}
          onClose={() => setOpen(null)}
          onVoid={() => void voidRequest(open.id)}
          onAction={(path, ok, fail) => void act(path, ok, fail)}
        />
      )}
    </aside>
  );
}

/** One document: who has signed, who has not, and the signed copy once it exists. */
export function RequestDetail({
  r,
  onClose,
  onVoid,
  onAction,
}: {
  r: SignatureRequest;
  onClose(): void;
  onVoid(): void;
  onAction(path: string, ok: string, fail: string): void;
}) {
  const toast = useToast();
  /**
   * Everyone signed but no signed copy exists: completion threw after the last
   * signature was committed. The signers cannot retry, so without this the
   * document would be stuck with no way out but cancelling something that is
   * already signed.
   */
  const stuck = r.signers.length > 0 && r.signers.every((s) => s.status === "signed") && !r.signedUrl;
  // Past its expiry the links refuse to open, so nothing offers one.
  const expired = Date.parse(r.expiresAt) <= Date.now();
  // Only whoever is up can sign; a later signer's link would just say "not your turn yet".
  const upNow = new Set(waitingOn(r.signers).map((s) => s.id));
  const byHand = r.emailed === false || r.emailConnected === false;
  const copy = async (url: string, who: string) => {
    try {
      // The server sends it absolute, on the address the signer can open. Older servers sent a path.
      await navigator.clipboard.writeText(/^https?:\/\//.test(url) ? url : `${API_URL}${url}`);
      toast.success(`Signing link for ${who} copied`);
    } catch (err) {
      toast.fail("Could not copy the link", err);
    }
  };
  return (
    <div
      className="overlay open"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal glass" style={{ maxWidth: 560 }} role="dialog" aria-modal="true" aria-label={r.title} data-testid="signatures.detail">
        <div className="modal-head">
          <div>
            <h3>{r.title}</h3>
            <p>{statusLine(r)}</p>
          </div>
          <button type="button" className="modal-x" aria-label="Close" onClick={onClose}>
            <svg>
              <use href="#i-x" />
            </svg>
          </button>
        </div>
        <div className="modal-body">
          <ul className="sg-signer-list">
            {r.signers.map((s) => (
              <li key={s.id} data-status={s.status}>
                <span className="sg-signer-who">
                  <b>{s.name || s.email}</b>
                  <small>
                    {s.name ? `${s.email} · ` : ""}#{s.order}
                  </small>
                </span>
                <span className={`sg-badge ${s.status === "signed" ? "ok" : s.status === "declined" ? "bad" : "info"}`}>
                  {s.status === "signed" && s.signedAt ? `signed ${new Date(s.signedAt).toLocaleDateString()}` : s.status}
                </span>
                {upNow.has(s.id) && s.signingUrl && r.status === "sent" && !expired && (
                  <button type="button" className="tf-btn" onClick={() => void copy(s.signingUrl!, s.name || s.email)}>
                    Copy link
                  </button>
                )}
              </li>
            ))}
          </ul>
          {r.signers.some((s) => s.declineReason) && (
            <p className="sg-note">
              Reason given: {r.signers.find((s) => s.declineReason)?.declineReason}
            </p>
          )}
          <p className="sg-note sg-hash">
            Original SHA-256 {r.sourceSha256.slice(0, 16)}…
            {r.signedSha256 ? ` · signed copy ${r.signedSha256.slice(0, 16)}…` : ""}
          </p>
        </div>
        {byHand && r.status === "sent" && !expired && (
          <p className="sg-note sg-stuck" data-testid="signatures.not-emailed">
            Email is not connected on this server, so signers are not emailed. Copy the link for whoever
            is up now and send it to them yourself. When they have signed, come back here for the next
            person's link.
          </p>
        )}
        {expired && r.status === "sent" && (
          <p className="sg-note sg-stuck">This document has expired, so its links no longer open. Send it again.</p>
        )}
        {stuck && (
          <p className="sg-note sg-stuck">
            Everyone has signed, but the signed copy was not built. Finish it to produce the signed
            document and the certificate.
          </p>
        )}
        <div className="modal-foot">
          {r.status !== "completed" && r.status !== "voided" && (
            <button type="button" className="mb-btn ghost" onClick={onVoid} data-testid="signatures.void">
              Cancel document
            </button>
          )}
          {r.status === "sent" && !stuck && !expired && r.emailConnected !== false && (
            <button
              type="button"
              className="mb-btn ghost"
              onClick={() => onAction(`/signature-requests/${r.id}/remind`, "Reminder sent", "Could not send the reminder")}
              data-testid="signatures.remind"
            >
              Send a reminder
            </button>
          )}
          <button type="button" className="mb-btn ghost" onClick={() => openExternal(`${API_URL}${r.documentUrl}`)}>
            Open original
          </button>
          {stuck && (
            <button
              type="button"
              className="mb-btn pri"
              onClick={() => onAction(`/signature-requests/${r.id}/complete`, "Signed copy built", "Could not build the signed copy")}
              data-testid="signatures.finish"
            >
              Finish it
            </button>
          )}
          {r.signedUrl && (
            <button type="button" className="mb-btn pri" onClick={() => openExternal(`${API_URL}${r.signedUrl}`)} data-testid="signatures.signed">
              Open signed copy
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
