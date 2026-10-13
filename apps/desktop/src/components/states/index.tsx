import type { ReactNode } from "react";
import "./states.css";

/*
 * The three not-ready states every screen shares, so a person sees the same
 * thing everywhere and a bot can wait on one selector: data-state on the
 * element, and data-testid "<screen>.loading|empty|error". The screen's own
 * root carries data-state="ready" once its content is up.
 */

/** A glass skeleton. Pass children for a screen-shaped one. */
export function Loading({ screen, label = "Loading", children }: { screen: string; label?: string; children?: ReactNode }) {
  return (
    <div className="tf-state tf-loading" data-state="loading" aria-busy="true" role="status" aria-label={label} data-testid={`${screen}.loading`}>
      {children ?? (
        <div className="tf-state-card glass-z1">
          <span className="skel" style={{ width: "40%" }} />
          <span className="skel" />
          <span className="skel" style={{ width: "75%" }} />
        </div>
      )}
    </div>
  );
}

export function Empty({ screen, title, hint, action }: { screen: string; title: string; hint?: ReactNode; action?: ReactNode }) {
  return (
    <div className="tf-state tf-state-card tf-state-msg glass-z1" data-state="empty" data-testid={`${screen}.empty`}>
      <b>{title}</b>
      {hint && <p>{hint}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ screen, message, onRetry }: { screen: string; message: ReactNode; onRetry?: () => void }) {
  return (
    <div className="tf-state tf-state-card tf-state-msg glass-z1" data-state="error" role="alert" data-testid={`${screen}.error`}>
      <b>Something went wrong</b>
      <p>{message}</p>
      {onRetry && (
        <button type="button" className="tf-btn glass-z1" onClick={onRetry} data-testid={`${screen}.retry`}>
          Retry
        </button>
      )}
    </div>
  );
}
