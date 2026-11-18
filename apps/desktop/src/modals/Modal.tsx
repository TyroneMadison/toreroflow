import { useEffect, useRef, type PointerEvent, type ReactNode } from "react";

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
  // Phone sheets (mobile pass): a grab handle that drags the sheet down to
  // close. Hidden above the phone width, where the modal is a dialog.
  const sheet = useRef<HTMLDivElement>(null);
  const drag = useRef<{ y: number; dy: number } | null>(null);
  const onGrabDown = (e: PointerEvent<HTMLDivElement>) => {
    drag.current = { y: e.clientY, dy: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onGrabMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!drag.current || !sheet.current) return;
    drag.current.dy = Math.max(0, e.clientY - drag.current.y);
    sheet.current.style.transition = "none";
    sheet.current.style.transform = `translateY(${drag.current.dy}px)`;
  };
  const onGrabUp = () => {
    const d = drag.current;
    drag.current = null;
    if (!sheet.current || !d) return;
    sheet.current.style.transition = "transform .18s ease";
    if (d.dy > 110) onClose();
    else sheet.current.style.transform = "";
  };
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
      <div ref={sheet} className="modal glass" style={{ maxWidth }} role="dialog" aria-modal="true" aria-label={label} data-testid={testId}>
        <div
          className="modal-grab"
          aria-hidden="true"
          onPointerDown={onGrabDown}
          onPointerMove={onGrabMove}
          onPointerUp={onGrabUp}
          onPointerCancel={onGrabUp}
        />
        {children}
      </div>
    </div>
  );
}
