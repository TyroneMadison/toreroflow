import type { ReactNode } from "react";

/*
 * The small marks the ideas screens share. No CSS import here, so the UI
 * check can render them under plain node; the styles live in IdeaScreens.css.
 */

/** The small-caps card label from the mockups. */
export function Lbl({ children, as: Tag = "div" }: { children: ReactNode; as?: "div" | "h3" }) {
  return <Tag className="id-lbl">{children}</Tag>;
}

export function Note({ tone, children }: { tone?: "ok" | "warn" | "bad"; children: ReactNode }) {
  return (
    <div className={`lfnote${tone ? ` ${tone}` : ""}`} role={tone === "bad" ? "alert" : undefined}>
      {children}
    </div>
  );
}

export function Badge({ tone = "accent", children }: { tone?: "accent" | "ok" | "warn" | "bad" | "flat"; children: ReactNode }) {
  return <span className={`id-badge ${tone}`}>{children}</span>;
}

/** A real switch: a button with role="switch". Read-only when there is no onChange. */
export function Switch({
  on,
  label,
  onChange,
  disabled,
  id,
}: {
  on: boolean;
  label: string;
  onChange?: (next: boolean) => void;
  disabled?: boolean;
  id?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={on}
      aria-label={label}
      className={`id-switch${on ? " on" : ""}`}
      disabled={disabled || !onChange}
      onClick={() => onChange?.(!on)}
    >
      <span className="switch" aria-hidden="true" />
      <span className="id-switch-txt">{on ? "ON" : "OFF"}</span>
    </button>
  );
}

/**
 * The monthly report's send switch. Always shown and never flipped from the
 * app: turning sending on is Tyrone's call, made on the server.
 */
export function KillSwitch({ on }: { on: boolean }) {
  return (
    <div className="id-row id-kill" data-testid="report.killswitch">
      <div className="id-rowtext">
        <b>Send emails</b>
        <small>
          {on
            ? "ON. Reports go out on the 1st."
            : "OFF. Reports are built as previews and never emailed. Turning this on needs Tyrone's yes."}
        </small>
      </div>
      <Switch on={on} label="Send monthly report emails" />
    </div>
  );
}
