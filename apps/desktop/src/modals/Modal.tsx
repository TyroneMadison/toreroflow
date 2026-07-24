import type { ReactNode } from "react";

interface ModalProps {
  maxWidth: number;
  onClose: () => void;
  children: ReactNode;
}

/** Overlay + glass modal shell matching the prototype's .overlay/.modal pattern. */
export default function Modal({ maxWidth, onClose, children }: ModalProps) {
  return (
    <div
      className="overlay open"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="modal glass" style={{ maxWidth }}>
        {children}
      </div>
    </div>
  );
}
