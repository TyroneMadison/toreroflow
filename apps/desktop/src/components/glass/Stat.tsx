import type { ReactNode } from "react";

/** A nested glass tile with a label and a big number, for side columns. */
export default function Stat({
  label,
  value,
  sub,
  tone,
  title,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: "ok" | "bad" | "info" | "warn";
  title?: string;
}) {
  return (
    <div className="gx-stat glass-z2" title={title}>
      <div className="tf-lbl">{label}</div>
      <div className={`gx-statv ${tone ?? ""}`}>{value}</div>
      {sub && <div className="gx-sub">{sub}</div>}
    </div>
  );
}
