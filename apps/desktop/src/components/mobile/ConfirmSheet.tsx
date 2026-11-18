import { useEffect, type ReactNode } from "react";

/**
 * The phone's "asks first" sheet (mobile pass): a short sheet over a scrim
 * with what will happen, Cancel and the action. Red when it destroys
 * something. Escape and the scrim cancel.
 */
export default function ConfirmSheet({
  title,
  body,
  confirm,
  danger = false,
  busy = false,
  onConfirm,
  onClose,
  children,
}: {
  title: string;
  body?: ReactNode;
  confirm: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm(): void;
  onClose(): void;
  children?: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <>
      <div className="mb-scrim top" onClick={onClose} aria-hidden="true" />
      <div className="mb-sheet top" role="alertdialog" aria-modal="true" aria-label={title} data-testid="mobile.confirm">
        <div className="mb-grab" aria-hidden="true" />
        <div className="mb-sh">
          <div className="mb-ttl">
            <h2>{title}</h2>
          </div>
        </div>
        <div className="mb-shb">
          {body && <p className="mb-p">{body}</p>}
          {children}
          <div className="mb-sf">
            <button type="button" className="mb-btn" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className={`mb-btn ${danger ? "danger solid" : "pri"}`} disabled={busy} onClick={onConfirm} data-testid="mobile.confirm.ok">
              {busy ? "Working" : confirm}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
