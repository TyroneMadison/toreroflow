import Pf from "../Pf";
import type { PostTargetInfo } from "../../lib/api";
import { PF_ID } from "../../lib/platforms";

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });

/*
 * Reach ring. There is no reach goal anywhere in the app, so the ring
 * measures this period's reach against the period before it, same length.
 * Over 100% the ring stays full and the label says how far ahead it is.
 */
export function ReachCard({
  reach,
  previous,
  rangeLabel,
  loading,
}: {
  reach: number | null;
  previous: number | null;
  rangeLabel: string;
  loading: boolean;
}) {
  const has = reach != null && reach > 0;
  const pct = has && previous ? (reach / previous) * 100 : null;
  const frac = pct == null ? (has ? 1 : 0) : Math.min(1, pct / 100);
  const R = 62;
  const C = 2 * Math.PI * R;
  return (
    <div id="an-reach" className="card glass an6-reach" data-testid="analytics.reach">
      <h3>Reach</h3>
      {has ? (
        <>
          <svg viewBox="0 0 160 160" className="an6-ring" aria-hidden="true">
            <circle cx="80" cy="80" r={R} className="track" />
            <circle
              cx="80"
              cy="80"
              r={R}
              className="val"
              strokeDasharray={`${frac * C} ${C}`}
              transform="rotate(-90 80 80)"
            />
          </svg>
          <div className="an6-ringtxt">
            <b>{loading ? "…" : compact.format(reach!)}</b>
            <span>
              {pct == null
                ? rangeLabel === "all time"
                  ? "all time"
                  : "no earlier period"
                : `${Math.round(pct)}% of previous ${rangeLabel}`}
            </span>
          </div>
        </>
      ) : (
        <div className="empty" style={{ padding: "14px 8px" }}>
          <b>{loading ? "Loading…" : "No reach reported yet"}</b>
          <p>Appears once a connected platform reports reach for this period.</p>
        </div>
      )}
    </div>
  );
}

const STATE: Record<string, string> = { scheduled: "Queued", publishing: "Live", failed: "Failed" };

/** Posting queue: the scheduled posts from Upload and Schedule, failures first. */
export function QueueCard({ posts, loading }: { posts: PostTargetInfo[]; loading: boolean }) {
  const done = posts.filter((p) => p.status === "publishing").length;
  return (
    <div id="an-queue" className="card glass an6-queue" data-testid="analytics.queue">
      <div className="rowhead">
        <h3>Posting queue</h3>
        {posts.length > 0 && <span className="an6-qcount">{done}/{posts.length}</span>}
      </div>
      {posts.length ? (
        <div className="an6-qlist">
          {posts.map((p) => (
            <div className={`an6-qrow ${p.status}`} key={p.id}>
              <Pf p={PF_ID[p.platform]} size="sm" />
              <div className="t">
                <b title={p.youtubeTitle ?? p.caption ?? p.assetName}>
                  {p.youtubeTitle ?? p.caption?.split("\n")[0] ?? p.assetName}
                </b>
                <span>
                  {p.scheduledAt
                    ? new Date(p.scheduledAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
                    : "unscheduled"}
                </span>
              </div>
              <span className="st">{STATE[p.status] ?? p.status}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty" style={{ padding: "14px 8px" }}>
          <b>{loading ? "Loading…" : "Nothing queued"}</b>
          <p>Posts scheduled in Upload and Schedule show here until they go out.</p>
        </div>
      )}
    </div>
  );
}
