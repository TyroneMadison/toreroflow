import { bandFor, type ScoreDial as Dial } from "@toreroflow/core";

/**
 * One arc gauge: Hook, Retention or Payoff.
 *
 * The arc is drawn at its finished length on the very first paint and its
 * geometry never moves. Sweeping stroke-dashoffset would repaint the stroke on
 * every frame, which is exactly what the motion contract forbids, so the
 * entrance is an opacity and transform keyframe on the whole dial (`.sd` in
 * AnalysisDetail.css) and the arc inside it simply already is the right
 * length when it fades in.
 *
 * `pathLength={100}` rescales the circle to 100 units, so the dash values read
 * straight in percent and no circumference arithmetic is needed. 75 of those
 * units is the 270 degree sweep, rotated so the gap sits at the bottom.
 */

/** Percent of the full circle the gauge sweeps: 270 degrees. */
const SWEEP = 75;

export default function ScoreDial({
  label,
  value,
  dial,
}: {
  label: string;
  value: number;
  /** Which ladder words this gauge. The three dials share one, peak has its own. */
  dial: Dial;
}) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  const band = bandFor(v, dial);
  return (
    <div className="sd" role="img" aria-label={`${label} ${v} out of 100, ${band}`}>
      <div className="sd-lab">{label}</div>
      <div className="sd-arc">
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <g transform="rotate(135 50 50)">
            <circle
              className="sd-track"
              cx="50"
              cy="50"
              r="41"
              pathLength={100}
              strokeDasharray={`${SWEEP} ${100 - SWEEP}`}
            />
            <circle
              className="sd-fill"
              cx="50"
              cy="50"
              r="41"
              pathLength={100}
              // A zero length dash with a round cap still paints a dot, which
              // would read as a score of one on a gauge showing zero.
              strokeLinecap={v > 0 ? "round" : "butt"}
              strokeDasharray={`${(v / 100) * SWEEP} 100`}
            />
          </g>
        </svg>
        <div className="sd-num">{v}</div>
      </div>
      <div className="sd-band">{band}</div>
    </div>
  );
}
