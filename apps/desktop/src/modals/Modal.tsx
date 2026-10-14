import { useEffect, type ReactNode } from "react";

interface ModalProps {
  maxWidth: number;
  onClose: () => void;
  children: ReactNode;
  /** Accessible name; announced by screen readers and readable by bots. */
  label?: string;
  testId?: string;
  /** Render in the page flow instead of over it (routed pages reuse a modal's body). */
  inline?: boolean;
}

/** Overlay + glass modal shell matching the prototype's .overlay/.modal pattern. */
export default function Modal({ maxWidth, onClose, children, label, testId, inline = false }: ModalProps) {
  // Escape closes, like every other dialog on the platform.
  useEffect(() => {
    if (inline) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [inline, onClose]);

  if (inline) {
    return (
      <div className="modal glass modal-inline" style={{ maxWidth }} role="region" aria-label={label} data-testid={testId}>
        {children}
      </div>
    );
  }
  return (
    <div
      className="overlay open"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal glass" style={{ maxWidth }} role="dialog" aria-modal="true" aria-label={label} data-testid={testId}>
        {children}
      </div>
    </div>
  );
}
