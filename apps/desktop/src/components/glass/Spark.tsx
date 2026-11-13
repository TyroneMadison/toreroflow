import { useId } from "react";
import { sparkPath } from "../../lib/financials";

/** The Financials v3 sparkline: one bright stroke with a soft fade under it. */
export default function Spark({
  values,
  width = 240,
  height = 56,
  tone = "#fff",
}: {
  values: number[];
  width?: number;
  height?: number;
  tone?: string;
}) {
  const id = useId().replace(/:/g, "");
  if (values.length < 2) return <div className="gx-spark gx-spark-empty" style={{ height }} />;
  const { line, area } = sparkPath(values, width, height);
  return (
    <svg className="gx-spark" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={`sf${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={tone} stopOpacity=".28" />
          <stop offset="1" stopColor={tone} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#sf${id})`} />
      <path d={line} fill="none" stroke={tone} strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
