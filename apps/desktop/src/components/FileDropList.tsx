import { useRef, useState } from "react";
import { fmtSize, type QueuedFile } from "../lib/trelloUpload";

interface Props {
  files: QueuedFile[];
  disabled?: boolean;
  onAdd: (files: File[]) => void;
  onRemove: (key: string) => void;
  onRetry?: (key: string) => void;
}

/** Drop zone plus a row per file with its progress, route and status. */
export default function FileDropList({ files, disabled, onAdd, onRemove, onRetry }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  return (
    <div>
      <div
        className={`tu-drop${over ? " over" : ""}`}
        role="button"
        tabIndex={0}
        data-testid="tu-drop"
        onClick={() => !disabled && input.current?.click()}
        onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && !disabled && input.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          if (!disabled) onAdd([...e.dataTransfer.files]);
        }}
      >
        Drop files or <u>browse</u> · up to 250 MB each to Trello, bigger files are linked from Toreroflow
        <input ref={input} type="file" multiple hidden onChange={(e) => onAdd([...(e.target.files ?? [])])} />
      </div>
      {files.map((f) => (
        <div key={f.key} className="tu-file" data-testid="tu-file" data-status={f.status} data-route={f.route}>
          <span className="tu-name">{f.file.name}</span>
          <span className="tu-sub">{fmtSize(f.file.size)}</span>
          {f.route === "link" && f.status === "queued" && <span className="tu-note warn">Over 250 MB: stored in Toreroflow, link added to card</span>}
          <div className="tu-bar" aria-label={`${f.file.name} progress`}>
            <i style={{ width: `${f.status === "done" ? 100 : f.pct}%` }} className={f.status} />
          </div>
          <span className="tu-sub">{f.status === "done" ? "✓" : f.status === "failed" ? "Failed" : `${f.pct}%`}</span>
          {f.status === "failed" && onRetry && (
            <button type="button" className="btn ghost" onClick={() => onRetry(f.key)}>
              Retry
            </button>
          )}
          {f.status === "queued" && !disabled && (
            <button type="button" className="btn ghost" aria-label={`Remove ${f.file.name}`} onClick={() => onRemove(f.key)}>
              ×
            </button>
          )}
          {f.error && <span className="tu-note bad">{f.error}</span>}
        </div>
      ))}
    </div>
  );
}
