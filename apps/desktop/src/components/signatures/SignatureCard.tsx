import { useCallback, useEffect, useState } from "react";
import Stat from "../glass/Stat";
import SignatureBuilder from "./SignatureBuilder";
import { useToast } from "../Toasts";
import { api, API_URL, type SignatureRequest, type SignatureSummary } from "../../lib/api";
import { openExternal } from "../../lib/external";
import { progress, statusLine, type RequestView } from "../../lib/signatures";
import "./signatures.css";

/**
 * Documents out for signature, on Account Overview.
 *
 * The counts come from /signature-requests/summary rather than from the list,
 * so opening this screen does not pull every signer and every field box of
 * every contract ever sent.
 */

const TONE: Record<string, "ok" | "bad" | "warn" | "info" | undefined> = {
  completed: "ok",
  sent: "info",
  declined: "bad",
  voided: undefined,
  draft: "warn",
};

export default function SignatureCard() {
  const toast = useToast();
  const [summary, setSummary] = useState<SignatureSummary | null>(null);
  const [open, setOpen] = useState<SignatureRequest | null>(null);
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

  const openRequest = async (id: string) => {
    try {
      setOpen(await api.get<SignatureRequest>(`/signature-requests/${id}`));
    } catch (err) {
      toast.fail("Could not open that document", err);
    }
  };

  /** Finish or remind: both answer with the request, so the open card refreshes. */
  const act = async (path: string, ok: string, fail: string) => {
    try {
      setOpen(await api.post<SignatureRequest>(path));
      toast.success(ok);
      await load();
    } catch (err) {
      toast.fail(fail, err);
    }
  };

  const voidRequest = async (id: string) => {
    try {
      await api.post<SignatureRequest>(`/signature-requests/${id}/void`, { reason: "" });
      toast.success("Cancelled. The signing links no longer work.");
      setOpen(null);
      await load();
    } catch (err) {
      toast.fail("Could not cancel it", err);
    }
  };

  return (
    <aside className="sg-card glass-z1" data-testid="signatures.card">
      <div className="sg-card-head">
        <div className="tf-lbl">Documents to sign</div>
        <button type="button" className="tf-btn" onClick={() => setBuilding(true)} data-testid="signatures.new">
          + Send one
        </button>
      </div>

      <div className="sg-card-stats">
        <Stat label="Out for signature" value={summary?.awaitingOthers ?? "—"} tone={summary?.awaitingOthers ? "info" : undefined} />
        <Stat label="Signed" value={summary?.completed ?? "—"} tone="ok" />
        <Stat
          label="Expiring soon"
          value={summary?.expiringSoon ?? "—"}
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
          onSent={() => {
            void load();
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
function RequestDetail({
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
  const view = r as unknown as RequestView;
  /**
   * Everyone signed but no signed copy exists: completion threw after the last
   * signature was committed. The signers cannot retry, so without this the
   * document would be stuck with no way out but cancelling something that is
   * already signed.
   */
  const stuck = r.signers.length > 0 && r.signers.every((s) => s.status === "signed") && !r.signedUrl;
  const copy = async (url: string, who: string) => {
    try {
      await navigator.clipboard.writeText(`${API_URL}${url}`);
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
            <p>{statusLine(view)}</p>
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
                {s.status !== "signed" && s.status !== "declined" && s.signingUrl && r.status === "sent" && (
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
          {r.status === "sent" && !stuck && (
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
