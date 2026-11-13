import { useEffect, useRef, useState } from "react";
import { VIDEO_FORMATS } from "@toreroflow/core";
import { api } from "../../lib/api";
import { openExternal } from "../../lib/external";
import { useToast } from "../../components/Toasts";
import { FUNNEL_LABEL, FormatTag, FunnelPill, Icon } from "./coralBits";

interface HookStats { views?: number; likes?: number; comments?: number; shares?: number; saves?: number; er?: number; lift?: number }
export interface HookRow {
  id: string;
  text: string;
  reworded: string | null;
  sourceType: "OWN" | "WEB" | "CREATOR";
  sourceUrl: string | null;
  sourceAccount: string | null;
  format: string;
  funnelStage: string | null;
  nicheScore: number;
  stats: HookStats | null;
}

const SOURCES: Array<[string, string]> = [["", "All"], ["OWN", "Ours"], ["WEB", "Web"], ["CREATOR", "Creators"]];
const STAGES: Array<[string, string]> = [["", "All stages"], ...Object.entries(FUNNEL_LABEL)];
const FORMATS: Array<[string, string]> = [["", "All formats"], ...VIDEO_FORMATS.map((f): [string, string] => [f, f])];

function Chips({ items, on, set, label }: { items: Array<[string, string]>; on: string; set: (v: string) => void; label: string }) {
  return (
    <div className="co-chips" role="group" aria-label={label}>
      {items.map(([v, x]) => (
        <button type="button" key={x} className={`co-chip${v === on ? " on" : ""}`} aria-pressed={v === on} onClick={() => set(v)}>{x}</button>
      ))}
    </div>
  );
}

const n = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}K` : String(v));

/** "tiktok.com/discover" from a full link, for the "via" line. */
function shortUrl(u: string) {
  try {
    const url = new URL(u);
    return (url.hostname.replace(/^www\./, "") + url.pathname.replace(/\/$/, "")).slice(0, 48);
  } catch {
    return u.slice(0, 48);
  }
}

function Source({ h }: { h: HookRow }) {
  const s = h.stats ?? {};
  const facts = [s.views ? `${n(s.views)} views` : "", s.likes ? `${n(s.likes)} likes` : "", s.er ? `${s.er}% ER` : ""].filter(Boolean);
  const link = h.sourceUrl && (
    <a className="co-lnk" href={h.sourceUrl} onClick={(e) => { e.preventDefault(); void openExternal(h.sourceUrl!); }}>
      via {shortUrl(h.sourceUrl)}
    </a>
  );
  return (
    <div className="co-srcb">
      {h.sourceType === "OWN" ? (
        <span className="co-badge perf"><Icon n="trend" s={13} w={2.4} />Our posts · performed</span>
      ) : h.sourceType === "CREATOR" ? (
        <span className="co-badge insp"><Icon n="quote" s={13} w={2.4} />Creator · {h.sourceAccount ?? "unknown"}</span>
      ) : (
        <span className="co-badge web"><Icon n="globe" s={13} />Web trending</span>
      )}
      {s.lift ? <span className="co-stat"><b>{s.lift}x</b>avg views</span> : null}
      {h.reworded && <p className="co-orig">Original: "{h.text}"</p>}
      {h.sourceType !== "OWN" && link}
      <span className="co-hmeta">Niche fit {Math.round(h.nicheScore * 100)}%{facts.length ? ` · ${facts.join(" · ")}` : ""}</span>
    </div>
  );
}

function HookCard({ h, feat, busy, onUse }: { h: HookRow; feat?: boolean; busy: boolean; onUse: () => void }) {
  return (
    <article className={`co-hc${feat ? " feat" : ""}`}>
      <div className="co-hct">
        <FormatTag name={h.format} />
        <FunnelPill stage={h.funnelStage} />
      </div>
      {feat && <span className="co-lab">Top performer</span>}
      <blockquote>{h.reworded || h.text}</blockquote>
      <div className="co-hcf">
        <Source h={h} />
        <button type="button" className="co-sb" disabled={busy} onClick={onUse}>
          {busy ? "Adding..." : "Use this hook"}<Icon n="arrow" s={14} />
        </button>
      </div>
    </article>
  );
}

/**
 * Hook library (v0.3.34): opening lines from our own best posts, the web and
 * the creators we follow. Filled on demand by Brainstorm, Generate and Super
 * generate (or Refresh here). "Use this hook" banks it as a saved idea.
 */
export default function HookLibrary({ clientId, onUsed }: { clientId: string; onUsed: () => void }) {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [format, setFormat] = useState("");
  const [stage, setStage] = useState("");
  const [source, setSource] = useState("");
  const [hooks, setHooks] = useState<HookRow[] | null>(null);
  const [total, setTotal] = useState(0);
  const [using, setUsing] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [tick, setTick] = useState(0);
  const input = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== "/" || (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA"))) return;
      e.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    let live = true;
    const qs = new URLSearchParams(Object.entries({ source, stage, format, q: q.trim() }).filter(([, v]) => v)).toString();
    const t = setTimeout(() => {
      api.get<{ hooks: HookRow[]; total: number }>(`/clients/${clientId}/hooks${qs ? `?${qs}` : ""}`)
        .then((got) => { if (live) { setHooks(got.hooks); setTotal(got.total); } })
        .catch((err) => { if (live) { setHooks([]); toast.fail("Could not load the hook library", err); } });
    }, q ? 250 : 0);
    return () => { live = false; clearTimeout(t); };
  }, [clientId, source, stage, format, q, tick, toast]);

  const use = async (h: HookRow) => {
    setUsing(h.id);
    try {
      await api.post(`/hooks/${h.id}/use`, {});
      toast.success("Added to Saved ideas");
      onUsed();
    } catch (err) {
      toast.fail("Could not use that hook", err);
    } finally {
      setUsing(null);
    }
  };

  const refresh = async () => {
    setRefreshing(true);
    try {
      const got = await api.post<{ own: number; web: number; creator: number }>(`/clients/${clientId}/hooks/refresh`, {});
      toast.success(`${got.own + got.web + got.creator} new hooks`);
      setTick((k) => k + 1);
    } catch (err) {
      toast.fail("Could not refresh the library", err);
    } finally {
      setRefreshing(false);
    }
  };

  // The best proven hook leads the page, when there is one.
  const lead = hooks?.reduce<HookRow | null>((best, h) => ((h.stats?.lift ?? 0) > (best?.stats?.lift ?? 0) ? h : best), null) ?? null;
  const rest = (hooks ?? []).filter((h) => h !== lead);
  const filtered = Boolean(source || stage || format || q.trim());

  return (
    <div className="co-hooks">
      <div className="co-hbar">
        <label className="co-search">
          <Icon n="search" s={20} />
          <input ref={input} type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search${total ? ` ${total}` : ""} hooks, try “fees” or “weekend”`} aria-label="Search hooks" />
          <kbd>/</kbd>
        </label>
        <button type="button" className="co-gb" disabled={refreshing} onClick={() => void refresh()}>
          {refreshing ? "Refreshing..." : "Refresh"}
        </button>
      </div>
      <div className="co-filt">
        <span className="co-lab">Format</span><Chips label="Format" items={FORMATS} on={format} set={setFormat} />
        <span className="co-lab">Funnel</span><Chips label="Funnel stage" items={STAGES} on={stage} set={setStage} />
        <span className="co-lab">Source</span><Chips label="Source" items={SOURCES} on={source} set={setSource} />
      </div>
      {hooks === null ? (
        <div className="co-empty"><p>Loading the library...</p></div>
      ) : hooks.length === 0 ? (
        <div className="co-empty big">
          <span className="co-q" aria-hidden="true">&#8220;</span>
          <h3 className="co-d">{filtered ? "No hooks match that." : "No hooks in the library yet."}</h3>
          <p>
            {filtered
              ? "Try another source, stage or format, or clear the search."
              : "Hooks are collected when you press Brainstorm, Generate or Super generate: the opening lines of your own best posts, lines from the creators you follow, and what is trending on the web."}
          </p>
          {!filtered && <p className="co-muted">Each one shows where it came from and how it did.</p>}
        </div>
      ) : (
        <div className="co-hgrid">
          {lead && <HookCard h={lead} feat busy={using === lead.id} onUse={() => void use(lead)} />}
          {rest.map((h) => <HookCard key={h.id} h={h} busy={using === h.id} onUse={() => void use(h)} />)}
        </div>
      )}
    </div>
  );
}
