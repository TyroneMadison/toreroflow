import { COLOR_NAME, LABEL_SWATCH, baseColor } from "../lib/labelColors";

/** The Trello color a client routes to, as a dot and a name. */
export default function ClientLabelBadge({ color }: { color: string | null }) {
  const b = baseColor(color);
  if (!b) return <span className="tu-note warn" data-testid="client-label-missing">No Trello label color. Set one in Settings → Trello labels.</span>;
  return (
    <span className="tu-note ok" data-testid="client-label" data-color={b}>
      <span className="rq-dot" style={{ background: LABEL_SWATCH[b] }} aria-hidden="true" /> Label: {COLOR_NAME[b] ?? b} · from Settings
    </span>
  );
}
