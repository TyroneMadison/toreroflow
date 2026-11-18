import { useEffect, useState, type ReactNode } from "react";
import { reportsSaves } from "@toreroflow/core";
import Pf from "../Pf";
import BrandAvatar from "../BrandAvatar";
import DataProvenance from "../DataProvenance";
import ViewsChart from "../ViewsChart";
import { Empty, ErrorState, Loading } from "../states";
import {
  api,
  type AccountAnalytics,
  type ClientPost,
  type ClientResults,
  type ClientSummary,
  type PostTargetInfo,
} from "../../lib/api";
import { openExternal } from "../../lib/external";
import { PF_ID, PLATFORM_LABELS, type Platform } from "../../lib/platforms";
import type { ViewTier } from "../../lib/viewTiers";
import { PF_COLOR } from "./AnalyticsHero";
import { fmt, fmtDate, fmtDay, fmtDur, gain, thumb } from "./fmt";
import { Ic, PhoneHead, PickSheet, Sheet, usePullToRefresh } from "./phoneBits";

/*
 * Analytics on the phone (mobile pass, mockup "analytics"): one hero, a sticky
 * platform and range row, the uploads as cards with a detail sheet, top videos
 * as chips, one followers list. Every number comes from AnalyticsScreen, which
 * computes them exactly as the desktop does; this file only lays them out.
 */

export interface AnalyticsPhoneProps {
  state: "empty" | "error" | "loading" | "ready";
  client: ClientSummary | null;
  clientIndex: number;
  reloadKey: number;
  onOpenConnect?: () => void;
  onRetry(): void;
  refresh(): void;
  refreshing: boolean;
  exportReport(): void;
  exporting: boolean;
  loading: boolean;
  tab: string;
  setTab(key: string): void;
  tabs: Array<{ key: string; platform: string; label: string }>;
  rangeDays: number | null;
  setRangeDays(days: number | null): void;
  earliest: string | null;
  rangeLabel: string;
  /** One per connected account, for the hero's platform tiles. */
  platforms: Platform[];
  stats: Array<{ label: string; value: string }>;
  shares: Array<{ platform: string; views: number; frac: number }>;
  shareTotal: number;
  reach: number | null;
  prevReach: number | null;
  /** Range and platform scoped posts, newest first. */
  posts: ClientPost[];
  chartPlatforms: string[];
  mostViewed: ClientPost[];
  tiers: [ViewTier, ViewTier, ViewTier];
  carousels: ClientPost[];
  queue: PostTargetInfo[];
  queueLoading: boolean;
  engagement: Array<{ label: string; value: string }>;
  /** Followers gained, only once some platform reports it. */
  follows: number | null;
  dms: { sent: number; opens: number | null; videos: number } | null;
  savesNote: boolean;
  uploads: Array<{ days: number; count: number }>;
  /** Accounts in the selected platform scope. */
  accounts: AccountAnalytics[];
  allAccounts: AccountAnalytics[];
  refreshedAt: Date | null;
}

const compact = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 });
const label = (p: string) => PLATFORM_LABELS[p as Platform] ?? p;
const andList = (xs: string[]) => new Intl.ListFormat("en-US", { type: "conjunction" }).format(xs);
const shortDate = (iso: string) => new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
/** Solid legend dots; the bars use PF_COLOR, where Instagram is a gradient. */
const DOT: Record<string, string> = { instagram: "#DD2A7B", tiktok: "#25F4EE", youtube: "#FF3B30", facebook: "#1877F2", snapchat: "#FFE600" };
const QSTATE: Record<string, { text: string; tone: string }> = {
  scheduled: { text: "Queued", tone: "info" },
  publishing: { text: "Live", tone: "ok" },
  failed: { text: "Failed", tone: "bad" },
};
const BOARDS = [
  { id: "most", label: "Most viewed", range: "" },
  { id: "1m", label: "1M+ club", range: "Videos with 1,000,000+ views" },
  { id: "100k", label: "100K to 999K", range: "Videos with 100,000 to 999,999 views" },
  { id: "10k", label: "10K to 99K", range: "Videos with 10,000 to 99,999 views" },
] as const;
type Board = (typeof BOARDS)[number]["id"];

/** What the client has had since joining; the same call the desktop card makes. */
function useResults(clientId: string | null, reloadKey: number): ClientResults | null {
  const [r, setR] = useState<ClientResults | null>(null);
  useEffect(() => {
    let live = true;
    setR(null);
    if (clientId)
      api
        .get<ClientResults>(`/clients/${clientId}/results`)
        .then((res) => live && setR(res))
        .catch(() => live && setR(null));
    return () => {
      live = false;
    };
  }, [clientId, reloadKey]);
  return r;
}

function Thumb({ post }: { post: ClientPost }) {
  const t = thumb(post.thumbnailUrl);
  return (
    <span className="rp-thumb">
      {t && <img src={t} alt="" />}
      {post.mediaType !== "carousel" && <Ic name="i-play" />}
      {post.durationSec ? <span className="rp-dur">{fmtDur(post.durationSec)}</span> : null}
    </span>
  );
}

function Stat({ k, v, ft }: { k: string; v: string; ft?: ReactNode }) {
  return (
    <div className="rp-stat">
      <div className="k">{k}</div>
      <div className="v">{v}</div>
      {ft && <div className="ft">{ft}</div>}
    </div>
  );
}

export default function AnalyticsPhone(p: AnalyticsPhoneProps) {
  const [platformSheet, setPlatformSheet] = useState(false);
  const [detail, setDetail] = useState<ClientPost | null>(null);
  const [list, setList] = useState<"carousels" | "queue" | null>(null);
  const [allUploads, setAllUploads] = useState(false);
  const [board, setBoard] = useState<Board>("most");
  const [boardAll, setBoardAll] = useState(false);
  const [since, setSince] = useState(false);
  const results = useResults(p.client?.id ?? null, p.reloadKey);
  const ptr = usePullToRefresh(p.refresh, p.refreshing);

  const head = (
    <PhoneHead
      screen="analytics"
      actions={
        <>
          <button
            type="button"
            className="mb-ib"
            aria-label="Refresh from every platform"
            disabled={!p.client || p.refreshing || p.loading}
            onClick={p.refresh}
            data-testid="analytics.refresh"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true" className={p.refreshing ? "spin" : undefined}>
              <use href="#i-refresh" />
            </svg>
          </button>
          <button
            type="button"
            className="mb-ib"
            aria-label={p.exporting ? "Building the report" : "Export report"}
            disabled={!p.client || p.exporting}
            onClick={p.exportReport}
            data-testid="analytics.export"
          >
            <Ic name="i-dl" />
          </button>
        </>
      }
    />
  );

  if (p.state !== "ready" || !p.client) {
    return (
      <section className="screen active mb-page rp-page" data-screen="analytics" data-state={p.state}>
        {head}
        {p.state === "empty" ? (
          <Empty
            screen="analytics"
            title="No brand selected"
            hint="Pick a brand with the switcher at the top, or connect one to get started."
            action={
              p.onOpenConnect && (
                <button type="button" className="mb-btn pri" onClick={p.onOpenConnect}>
                  Connect client
                </button>
              )
            }
          />
        ) : p.state === "error" ? (
          <ErrorState screen="analytics" message="Could not load the analytics for this brand." onRetry={p.onRetry} />
        ) : (
          <Loading screen="analytics" label="Loading the analytics" />
        )}
      </section>
    );
  }

  const client = p.client;
  const active = p.tabs.find((t) => t.key === p.tab) ?? null;
  const scope = active ? active.label : "all platforms";
  const rangeText = p.rangeDays == null ? "all time" : `the last ${p.rangeLabel}`;
  const stats = p.stats.filter((s) => s.value !== "-");
  const shares = [...p.shares].sort((a, b) => b.views - a.views);
  const n = p.platforms.length;

  // Reach against the period before this one, as the desktop ring does.
  const hasReach = p.reach != null && p.reach > 0;
  const pct = hasReach && p.prevReach ? (p.reach! / p.prevReach) * 100 : null;
  const ring = 2 * Math.PI * 22;

  const last10 = p.posts.slice(0, 10);
  const maxViews = Math.max(1, ...last10.map((x) => x.views));
  const tier = board === "1m" ? p.tiers[0] : board === "100k" ? p.tiers[1] : board === "10k" ? p.tiers[2] : null;
  const rows = tier ? tier.posts : p.mostViewed;
  const boardRange = BOARDS.find((b) => b.id === board)!.range;
  const live = p.queue.filter((q) => q.status === "publishing").length;
  const failed = p.queue.filter((q) => q.status === "failed").length;

  return (
    <section className={`screen active mb-page rp-page${p.loading ? " rp-busy" : ""}`} data-screen="analytics" data-state={p.state}>
      {head}
      {ptr}

      <div className="rp-filt" data-testid="analytics.filters">
        <button
          type="button"
          className="mb-chip out rp-pfbtn"
          aria-haspopup="dialog"
          aria-label={`Platform: ${active ? active.label : "Overall"}`}
          onClick={() => setPlatformSheet(true)}
          data-testid="analytics.platform"
        >
          {active && <Pf p={PF_ID[active.platform as Platform]} size="xs" />}
          <span>{active ? active.label : "Overall"}</span>
          <Ic name="i-chev" />
        </button>
        <div className="seg rp-range" role="group" aria-label="Range">
          {[7, 30, 60, 90].map((d) => (
            <button
              key={d}
              type="button"
              className={p.rangeDays === d ? "on" : undefined}
              aria-pressed={p.rangeDays === d}
              onClick={() => p.setRangeDays(d)}
              data-testid={`analytics.range.${d}`}
            >
              {d}d
            </button>
          ))}
          <button
            type="button"
            className={p.rangeDays === null ? "on" : undefined}
            aria-pressed={p.rangeDays === null}
            onClick={() => p.setRangeDays(null)}
            data-testid="analytics.range.all"
          >
            All
          </button>
        </div>
      </div>
      {p.rangeDays === null && (
        <p className="rp-note">
          Everything the provider holds{p.earliest ? `, back to ${fmtDate(p.earliest)}` : ""}.
        </p>
      )}

      {/* ---- Overview ---- */}
      <div className="rp-grp" id="an-overview">
        <div className="mb-lab">Overview</div>
        <section className="rp-hero" data-testid="analytics.profile">
          <div className="rp-idrow">
            <BrandAvatar client={client} index={p.clientIndex} size={40} />
            <div className="rp-idt">
              <b data-testid="analytics.name">{client.name}</b>
              <small>{n ? `${n} connected platform${n === 1 ? "" : "s"}` : "No platforms connected"}</small>
            </div>
            <span className="rp-pfrow">
              {p.platforms.map((pl, i) => (
                <Pf key={`${pl}${i}`} p={PF_ID[pl]} size="xs" />
              ))}
            </span>
          </div>
          {stats.length > 0 && (
            <div className="rp-stats">
              {stats.map((s) => (
                <Stat key={s.label} k={s.label.replace(" · ", ", ")} v={p.loading ? "…" : s.value} />
              ))}
            </div>
          )}
          {shares.length > 0 && (
            <>
              <div className="rp-sharet">
                <span>Share of views</span>
                <span>{fmt(p.shareTotal)} views</span>
              </div>
              <div className="rp-share" aria-label="Share of views per platform" data-testid="analytics.platform-strip">
                {shares.map((s) => (
                  <i key={s.platform} style={{ flex: s.views, background: PF_COLOR[s.platform] ?? "var(--mb-coral)" }} />
                ))}
              </div>
              <div className="rp-legend">
                {shares.map((s) => (
                  <span key={s.platform}>
                    <i style={{ background: DOT[s.platform] ?? "var(--mb-coral)" }} />
                    {label(s.platform)} <b>{Math.round(s.frac * 100)}%</b>
                  </span>
                ))}
              </div>
            </>
          )}
          <div className="rp-reach" data-testid="analytics.reach">
            <svg viewBox="0 0 56 56" aria-hidden="true">
              <circle cx="28" cy="28" r="22" className="track" />
              {hasReach && (
                <circle
                  cx="28"
                  cy="28"
                  r="22"
                  className="val"
                  strokeDasharray={`${(pct == null ? 1 : Math.min(1, pct / 100)) * ring} ${ring}`}
                  transform="rotate(-90 28 28)"
                />
              )}
            </svg>
            <div className="rp-grow">
              <small>Reach</small>
              <b className="rp-num">{hasReach ? (p.loading ? "…" : compact.format(p.reach!)) : "-"}</b>
            </div>
            {hasReach ? (
              <span className={`rp-delta ${pct == null ? "flat" : pct >= 100 ? "up" : "down"}`}>
                {pct == null
                  ? p.rangeDays == null
                    ? "all time"
                    : "no earlier period"
                  : `${Math.round(pct)}% of previous ${p.rangeLabel}`}
              </span>
            ) : (
              <small className="rp-muted">No reach reported yet for this period</small>
            )}
          </div>
        </section>

        {results && (
          <section className="mb-card" data-testid="analytics.since">
            <div className="rp-cardh">
              <h3>Since joining</h3>
              <small>
                {fmtDate(results.joinedAt)}, {results.days} {results.days === 1 ? "day" : "days"} with Torerone
              </small>
            </div>
            <div className="rp-stats">
              <Stat
                k="Posts published"
                v={results.published.posts.toLocaleString()}
                ft={`from ${results.published.videos} ${results.published.videos === 1 ? "video" : "videos"}${
                  results.published.carousels > 0
                    ? ` and ${results.published.carousels} ${results.published.carousels === 1 ? "carousel" : "carousels"}`
                    : ""
                }`}
              />
              <Stat
                k="Views on those posts"
                v={results.views.reporting ? fmt(results.views.total) : "-"}
                ft={
                  results.views.reporting === 0
                    ? results.published.posts
                      ? "counts arrive with the nightly sync"
                      : "nothing published yet"
                    : results.views.reporting < results.views.posts
                      ? `${results.views.reporting} of ${results.views.posts} posts reporting`
                      : `all ${results.views.posts} posts reporting`
                }
              />
              <Stat
                k="Best post"
                v={results.views.best ? fmt(results.views.best.views) : "-"}
                ft={
                  results.views.best ? (
                    <>
                      <Pf p={PF_ID[results.views.best.platform as Platform]} size="xs" />{" "}
                      {results.views.best.url ? (
                        <a
                          className="rp-a"
                          href={results.views.best.url}
                          onClick={(e) => {
                            e.preventDefault();
                            void openExternal(results.views.best!.url!);
                          }}
                        >
                          {results.views.best.title}
                        </a>
                      ) : (
                        results.views.best.title
                      )}
                    </>
                  ) : (
                    "appears once views come in"
                  )
                }
              />
              <Stat
                k="Average per post"
                v={results.views.reporting ? fmt(Math.round(results.views.total / results.views.reporting)) : "-"}
                ft="views, across the posts reporting"
              />
            </div>
            <p className="rp-note">
              Views are each platform's own count for posts published through Toreroflow
              {results.viewsCountedAt ? `, last counted ${fmtDate(results.viewsCountedAt)}` : ""}.
            </p>
          </section>
        )}
      </div>

      {/* ---- Views ---- */}
      <div className="rp-grp">
        <div className="mb-lab">Views</div>
        <section className="mb-card rp-chart" id="an-views">
          <div className="rp-cardh">
            <h3>Views over time</h3>
            <small>By publish date{p.tab === "all" ? ", per platform and combined" : ""}</small>
          </div>
          <ViewsChart posts={p.posts} platforms={p.chartPlatforms} compact />
        </section>
      </div>

      {/* ---- Videos ---- */}
      <div className="rp-grp" id="an-videos">
        <div className="mb-lab">Videos</div>
        <div className="rp-rowsb">
          <h3 className="rp-h3">Last {last10.length || 10} uploads</h3>
          {last10.length > 3 && (
            <button type="button" className="mb-link rp-linkbtn" onClick={() => setAllUploads((v) => !v)} aria-expanded={allUploads}>
              {allUploads ? "Show fewer" : `See all ${last10.length}`}
            </button>
          )}
        </div>
        {last10.length ? (
          (allUploads ? last10 : last10.slice(0, 3)).map((post) => (
            <button type="button" className="rp-post" key={post.id} onClick={() => setDetail(post)} data-testid={`analytics.upload.${post.id}`}>
              <Thumb post={post} />
              <span className="rp-pb">
                <span className="rp-pt">
                  <b>{post.title}</b>
                  <span className="rp-pv">
                    {fmt(post.views)}
                    <small>views</small>
                  </span>
                </span>
                <span className="rp-pfs">
                  {post.platforms.map((pl) => (
                    <Pf key={pl} p={PF_ID[pl]} size="xs" />
                  ))}
                  <small>{shortDate(post.publishedAt)}</small>
                </span>
                <span className="rp-vbar">
                  <i
                    style={{
                      width: `${Math.max(2, (post.views / maxViews) * 100)}%`,
                      background: PF_COLOR[post.platforms[0] ?? ""] ?? "var(--mb-coral)",
                    }}
                  />
                </span>
              </span>
            </button>
          ))
        ) : (
          <div className="mb-card rp-none">
            <b>{p.loading ? "Loading" : "No uploads found"}</b>
            <p>Connected accounts' videos appear here automatically.</p>
          </div>
        )}

        <section className="mb-card rp-top" data-testid="analytics.top">
          <div className="rp-cardh row">
            <h3>Top videos</h3>
            <small>Tap a row for its numbers</small>
          </div>
          <div className="mb-chips rp-inc" role="tablist" aria-label="Top videos">
            {BOARDS.map((b) => (
              <button
                key={b.id}
                type="button"
                role="tab"
                aria-selected={board === b.id}
                className={`mb-chip${board === b.id ? " on" : ""}`}
                onClick={() => {
                  setBoard(b.id);
                  setBoardAll(false);
                }}
              >
                {b.label}
              </button>
            ))}
          </div>
          <p className="rp-note">
            {tier ? (
              <>
                {boardRange}, all time, whatever the range.
                {tier.total > 0 && (
                  <>
                    {" "}
                    {tier.total} all time
                    {tier.addedInRange > 0 && (
                      <>
                        , <span className="rp-ok">{tier.addedInRange} in 30d</span>
                      </>
                    )}
                    .
                  </>
                )}
              </>
            ) : (
              `Top videos across ${scope}, ${rangeText}.`
            )}
          </p>
          {rows.length ? (
            <div className="rp-list">
              {(boardAll ? rows : rows.slice(0, 3)).map((post, i) => (
                <button type="button" className="mb-lrow rp-rk" key={post.id} onClick={() => setDetail(post)}>
                  <span className="rp-n">{i + 1}</span>
                  <Pf p={PF_ID[post.platforms[0] ?? "instagram"]} size="sm" />
                  <span className="mb-lt">
                    <b>{post.title}</b>
                    <small>{shortDate(post.publishedAt)}</small>
                  </span>
                  <b className="rp-num">{fmt(post.views)}</b>
                </button>
              ))}
            </div>
          ) : (
            <p className="rp-empty">
              {tier ? "Nothing here yet. Rows appear as videos cross the threshold." : "Appears with view data. Ranks build from every connected platform."}
            </p>
          )}
          {rows.length > 3 && (
            <button type="button" className="mb-btn ghost sm block" onClick={() => setBoardAll((v) => !v)} aria-expanded={boardAll}>
              {boardAll ? "Show the top 3" : `See all ${rows.length}`}
            </button>
          )}
        </section>

        <section className="mb-card list">
          <button type="button" className="mb-lrow" onClick={() => setList("carousels")} data-testid="analytics.carousels">
            <span className="mb-lic n">
              <Ic name="i-layers" />
            </span>
            <span className="mb-lt">
              <b>Carousels</b>
              <small>Slide posts and how they did</small>
            </span>
            <span className="rp-tr">
              {p.carousels.length}
              <Ic name="i-chev-r" />
            </span>
          </button>
          <button type="button" className="mb-lrow" onClick={() => setList("queue")} data-testid="analytics.queue">
            <span className="mb-lic n">
              <Ic name="i-clock" />
            </span>
            <span className="mb-lt">
              <b>Posting queue</b>
              <small>
                {p.queueLoading && !p.queue.length
                  ? "Loading"
                  : p.queue.length
                    ? `${live} of ${p.queue.length} live, failures first`
                    : "Nothing queued"}
              </small>
            </span>
            <span className="rp-tr">
              {failed > 0 && <span className="mb-pill bad">{failed} failed</span>}
              <Ic name="i-chev-r" />
            </span>
          </button>
        </section>
      </div>

      {/* ---- Engagement ---- */}
      <div className="rp-grp" id="an-engagement">
        <div className="mb-lab">Engagement</div>
        <section className="mb-card">
          <div className="rp-cardh">
            <h3>Engagement</h3>
            <small>What people did beyond watching, over {rangeText}</small>
          </div>
          <div className="rp-stats three rp-eng">
            {p.engagement.map((e) => (
              <Stat key={e.label} k={e.label} v={p.loading ? "…" : e.value} />
            ))}
            {p.follows != null && <Stat k="Followed" v={p.loading ? "…" : fmt(p.follows)} />}
          </div>
          {p.dms && (
            <div className="rp-dm">
              <Ic name="i-send" />
              <span>
                <b>
                  {fmt(p.dms.sent)} DMs sent{p.dms.opens != null ? `, ${fmt(p.dms.opens)} link opens` : ""}
                </b>
                <small>
                  Across {p.dms.videos} {p.dms.videos === 1 ? "video" : "videos"} running a comment-to-DM campaign.
                </small>
              </span>
            </div>
          )}
          {p.follows == null && !p.loading && (
            <p className="rp-note">
              Followers gained per video is not reported yet. It arrives empty on every platform, so a zero would read as a
              result.
            </p>
          )}
          {p.savesNote && !p.loading && (
            <p className="rp-note">
              Saves are counted on Instagram only. YouTube and Facebook have no save button, and TikTok has one but has never
              reported the number.
            </p>
          )}
          <div className="rp-div" />
          <div className="rp-uplh">Videos uploaded, across every connected platform</div>
          <div className="rp-upl">
            {p.uploads.map((u) => (
              <div key={u.days}>
                <b>{p.loading ? "…" : u.count}</b>
                <small>last {u.days} days</small>
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* ---- Platforms and growth ---- */}
      <div className="rp-grp" id="an-growth">
        <div className="mb-lab">Platforms and growth</div>
        <section className="mb-card rp-fol">
          <div className="rp-cardh row">
            <h3>Followers</h3>
            <small>Latest snapshot per account</small>
          </div>
          <div className="seg" role="tablist" aria-label="Follower change">
            <button type="button" role="tab" aria-selected={!since} className={since ? undefined : "on"} onClick={() => setSince(false)}>
              Last 30 days
            </button>
            <button type="button" role="tab" aria-selected={since} className={since ? "on" : undefined} onClick={() => setSince(true)}>
              Since joining
            </button>
          </div>
          <div className="rp-list">
            {since ? (
              results?.accounts.length ? (
                results.accounts.map((a) => {
                  const f = a.followers;
                  const noun = a.platform === "youtube" ? "subscribers" : "followers";
                  // A count that stopped updating says when it was last true.
                  const stale = f != null && Date.now() - new Date(`${f.nowOn}T12:00:00`).getTime() > 2 * 86_400_000;
                  return (
                    <div className="mb-lrow" key={`${a.platform}:${a.handle}`}>
                      <Pf p={PF_ID[a.platform]} />
                      <span className="mb-lt">
                        <b>@{a.handle}</b>
                        <small>
                          {f
                            ? `${f.start.toLocaleString()} to ${f.now.toLocaleString()} ${noun} since ${fmtDay(f.startOn)}${stale ? `, as of ${fmtDay(f.nowOn)}` : ""}`
                            : `${noun}: not enough history yet`}
                        </small>
                      </span>
                      {f && (
                        <span className={`rp-delta ${f.change > 0 ? "up" : f.change < 0 ? "down" : "flat"}`}>
                          {f.change > 0 ? "+" : ""}
                          {f.pct != null ? `${f.pct}%` : fmt(f.change)}
                        </span>
                      )}
                    </div>
                  );
                })
              ) : (
                <p className="rp-empty">{results ? "No connected accounts to compare yet." : "Loading"}</p>
              )
            ) : p.accounts.length ? (
              p.accounts.map((a) => {
                const d = gain(a);
                return (
                  <div className="mb-lrow" key={a.id}>
                    <Pf p={PF_ID[a.platform]} />
                    <span className="mb-lt">
                      <b>{a.displayName ?? `@${a.handle}`}</b>
                      <small>
                        @{a.handle}
                        {a.platform === "youtube" ? ", subscribers" : ""}
                      </small>
                    </span>
                    <span className="rp-fr">
                      <b className="rp-num">{fmt(a.followers)}</b>
                      <span className={`rp-delta ${d == null || d === 0 ? "flat" : d > 0 ? "up" : "down"}`}>
                        {d == null ? "-" : d > 0 ? `+${fmt(d)}` : fmt(d)}
                      </span>
                    </span>
                  </div>
                );
              })
            ) : (
              <p className="rp-empty">Nothing connected. Follower counts appear once an account is connected.</p>
            )}
          </div>
          <p className="rp-note">Follower change covers the whole account, including anything posted outside the app.</p>
        </section>
      </div>

      <div className="rp-prov">
        <DataProvenance platforms={p.platforms} refreshedAt={p.refreshedAt} />
        <p className="rp-note">Watch time counts only the platforms that report it.</p>
      </div>

      {platformSheet && (
        <PickSheet
          label="Platform"
          value={p.tab}
          onPick={p.setTab}
          onClose={() => setPlatformSheet(false)}
          testId="analytics.platform-sheet"
          options={[
            {
              value: "all",
              label: "Overall",
              hint: "Every connected platform",
              lead: (
                <span className="mb-lic n rp-lic">
                  <Ic name="i-grid" />
                </span>
              ),
            },
            ...p.tabs.map((t) => ({ value: t.key, label: t.label, lead: <Pf p={PF_ID[t.platform as Platform]} size="sm" /> })),
          ]}
        />
      )}

      {list === "carousels" && (
        <Sheet
          label="Carousels"
          title="Carousels"
          sub="Slide posts and how they did. Shares include TikTok reposts."
          onClose={() => setList(null)}
          testId="analytics.carousels-sheet"
        >
          {p.carousels.length ? (
            <div className="mb-card list">
              {p.carousels.map((c) => (
                <button
                  type="button"
                  className="mb-lrow"
                  key={c.id}
                  onClick={() => {
                    setList(null);
                    setDetail(c);
                  }}
                >
                  <Thumb post={c} />
                  <span className="mb-lt">
                    <b>{c.title}</b>
                    <small>
                      {fmtDate(c.publishedAt)} · {c.platforms.map(label).join(", ")}
                    </small>
                    <small>
                      {fmt(c.likes)} likes · {fmt(c.comments)} comments · {fmt(c.shares)} shares · {fmt(c.saves)} saves
                    </small>
                  </span>
                  <b className="rp-num">{fmt(c.views)}</b>
                </button>
              ))}
            </div>
          ) : (
            <div className="mb-empty">
              <h3>No carousels yet</h3>
              <p>
                Add one in Upload and Schedule and it appears here with its views, likes, comments, shares and saves.
                Carousels posted straight on the platform count too.
              </p>
            </div>
          )}
        </Sheet>
      )}

      {list === "queue" && (
        <Sheet
          label="Posting queue"
          title="Posting queue"
          sub={p.queue.length ? `${live} of ${p.queue.length} live, failures first` : undefined}
          onClose={() => setList(null)}
          testId="analytics.queue-sheet"
        >
          {p.queue.length ? (
            <div className="mb-card list">
              {p.queue.map((q) => (
                <div className="mb-lrow" key={q.id}>
                  <Pf p={PF_ID[q.platform]} size="sm" />
                  <span className="mb-lt">
                    <b>{q.youtubeTitle ?? q.caption?.split("\n")[0] ?? q.assetName}</b>
                    <small>
                      {q.scheduledAt
                        ? new Date(q.scheduledAt).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })
                        : "unscheduled"}
                    </small>
                  </span>
                  <span className={`mb-pill ${QSTATE[q.status]?.tone ?? ""}`}>{QSTATE[q.status]?.text ?? q.status}</span>
                </div>
              ))}
            </div>
          ) : (
            <div className="mb-empty">
              <h3>{p.queueLoading ? "Loading" : "Nothing queued"}</h3>
              <p>Posts scheduled in Upload and Schedule show here until they go out.</p>
            </div>
          )}
        </Sheet>
      )}

      {detail && <DetailSheet post={detail} accounts={p.allAccounts} onClose={() => setDetail(null)} />}
    </section>
  );
}

/** One video's numbers: all six, the split per platform, Open the post. */
function DetailSheet({ post, accounts, onClose }: { post: ClientPost; accounts: AccountAnalytics[]; onClose(): void }) {
  const max = Math.max(1, ...post.byPlatform.map((b) => b.views));
  return (
    <Sheet
      label={post.title}
      className="rp-dsh"
      lead={<Thumb post={post} />}
      title={post.title}
      sub={`${fmtDate(post.publishedAt)}, ${andList(post.platforms.map(label))}`}
      onClose={onClose}
      testId="analytics.video-sheet"
      foot={
        <>
          <button type="button" className="mb-btn ghost" onClick={onClose}>
            Close
          </button>
          {post.url && (
            <button type="button" className="mb-btn" onClick={() => void openExternal(post.url!)}>
              Open the post
              <Ic name="i-ext" />
            </button>
          )}
        </>
      }
    >
      <div className="rp-stats three">
        <Stat k="Views" v={fmt(post.views)} />
        {/* A dash, not a zero, where the platform has no save button. */}
        <Stat k="Saves" v={reportsSaves(post.platforms) ? fmt(post.saves) : "-"} />
        <Stat k="Comments" v={fmt(post.comments)} />
        <Stat k="Shares" v={fmt(post.shares)} />
        <Stat k="Avg view" v={post.avgWatchSec != null ? fmtDur(post.avgWatchSec) : "-"} />
        <Stat k="Length" v={fmtDur(post.durationSec)} />
      </div>
      <div className="mb-lab">By platform</div>
      <div className="mb-card list rp-split">
        {post.byPlatform.map((b) => {
          const handle = accounts.find((a) => a.id === b.accountId)?.handle;
          return (
            <div className="mb-lrow" key={`${b.platform}:${b.accountId ?? ""}`}>
              <Pf p={PF_ID[b.platform]} />
              <span className="mb-lt">
                <b>
                  {label(b.platform)}
                  {handle ? ` @${handle}` : ""}
                </b>
                <span className="rp-vbar">
                  <i style={{ width: `${(b.views / max) * 100}%`, background: PF_COLOR[b.platform] ?? "var(--mb-coral)" }} />
                </span>
              </span>
              <b className="rp-num">{fmt(b.views)}</b>
            </div>
          );
        })}
      </div>
      <p className="rp-help">Saves are counted on Instagram only. Where a platform has no save count the sheet shows a dash, not a zero.</p>
    </Sheet>
  );
}
