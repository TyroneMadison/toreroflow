import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/api";
import { useToast } from "../../components/Toasts";
import { useRecipes } from "./RecipesPanel";

/**
 * Phase 8, mock-ups 24 and 25: the brand's clip library across jobs
 * (search, favorites, collections), clip performance, team activity, and
 * imports (YouTube auto-import, Google Drive).
 */

interface SearchHit {
  id: string;
  jobId: string;
  title: string;
  score: number;
  duration: number;
  favorite: boolean;
  source: string;
  collections: string[];
  perf: Perf | null;
  snippet: string;
}
interface Perf {
  views: number;
  likes: number;
  comments: number;
  shares: number;
  saves: number;
  avgWatchPct: number | null;
  posts: number;
  platforms: string[];
}
interface Collection {
  id: string;
  name: string;
  count: number;
}

const n = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(1)}k` : String(v));
const secs = (s: number) => `${Math.round(s)}s`;

export function ClipLibrary({ clientId, onOpen }: { clientId: string; onOpen: (jobId: string) => void }) {
  const toast = useToast();
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<string>("all"); // all | fav | <collection id>
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [cols, setCols] = useState<{ favorites: number; collections: Collection[] }>({ favorites: 0, collections: [] });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [newName, setNewName] = useState("");

  const loadCols = useCallback(async () => {
    try {
      setCols(await api.get(`/clients/${clientId}/collections`));
    } catch (e) {
      toast.fail("Loading collections", e);
    }
  }, [clientId, toast]);
  const search = useCallback(async () => {
    const p = new URLSearchParams();
    if (q.trim()) p.set("q", q.trim());
    if (filter === "fav") p.set("favorites", "1");
    else if (filter !== "all") p.set("collectionId", filter);
    try {
      setHits((await api.get<{ results: SearchHit[] }>(`/clients/${clientId}/clip-search?${p}`)).results);
    } catch (e) {
      toast.fail("Searching clips", e);
    }
  }, [clientId, q, filter, toast]);
  useEffect(() => void loadCols(), [loadCols]);
  useEffect(() => {
    const t = window.setTimeout(() => void search(), 250);
    return () => window.clearTimeout(t);
  }, [search]);

  async function fav(h: SearchHit) {
    try {
      await api.post(`/clip-candidates/${h.id}/favorite`, { on: !h.favorite });
      setHits((hs) => hs?.map((x) => (x.id === h.id ? { ...x, favorite: !h.favorite } : x)) ?? null);
      void loadCols();
    } catch (e) {
      toast.fail("Favoriting", e);
    }
  }
  async function addTo(colId: string) {
    try {
      await api.post(`/collections/${colId}/items`, { candidateIds: [...sel] });
      setSel(new Set());
      await loadCols();
      void search();
    } catch (e) {
      toast.fail("Adding to the collection", e);
    }
  }
  async function create() {
    if (!newName.trim()) return;
    try {
      await api.post(`/clients/${clientId}/collections`, { name: newName.trim() });
      setNewName("");
      await loadCols();
    } catch (e) {
      toast.fail("Making the collection", e);
    }
  }
  async function removeCol(c: Collection) {
    try {
      await api.del(`/collections/${c.id}`);
      if (filter === c.id) setFilter("all");
      await loadCols();
    } catch (e) {
      toast.fail("Deleting the collection", e);
    }
  }
  async function removeFromCol(h: SearchHit) {
    try {
      await api.del(`/collections/${filter}/items/${h.id}`);
      void search();
      void loadCols();
    } catch (e) {
      toast.fail("Removing from the collection", e);
    }
  }

  const inCol = filter !== "all" && filter !== "fav";
  return (
    <div className="cliplib">
      <div className="cliplib-side">
        <button className={filter === "all" ? "on" : ""} onClick={() => setFilter("all")}>All clips</button>
        <button className={filter === "fav" ? "on" : ""} onClick={() => setFilter("fav")}>★ Favorites · {cols.favorites}</button>
        {cols.collections.map((c) => (
          <div key={c.id} className="cliplib-col">
            <button className={filter === c.id ? "on" : ""} onClick={() => setFilter(c.id)}>{c.name} · {c.count}</button>
            <button className="linkbtn" title="Delete collection" onClick={() => void removeCol(c)}>×</button>
          </div>
        ))}
        <div className="collab-row">
          <input className="field-in" placeholder="New collection" maxLength={60} value={newName} onChange={(e) => setNewName(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void create()} />
        </div>
      </div>
      <div className="cliplib-main">
        <input className="field-in" placeholder="Search every clip's title and transcript" value={q} onChange={(e) => setQ(e.target.value)} />
        {sel.size > 0 && (
          <div className="collab-row">
            <span className="mini">{sel.size} picked</span>
            <select className="field-in" value="" onChange={(e) => e.target.value && void addTo(e.target.value)}>
              <option value="">Add to collection…</option>
              {cols.collections.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
            <button className="linkbtn" onClick={() => setSel(new Set())}>Clear</button>
          </div>
        )}
        {hits?.length === 0 && <div className="empty">{q ? "Nothing matches." : "No clips here yet."}</div>}
        {hits?.map((h) => (
          <div key={h.id} className="best projrow cliplib-row" onClick={() => onOpen(h.jobId)}>
            <input
              type="checkbox"
              checked={sel.has(h.id)}
              onClick={(e) => e.stopPropagation()}
              onChange={() => setSel((s) => { const x = new Set(s); if (x.has(h.id)) x.delete(h.id); else x.add(h.id); return x; })}
            />
            <div className="projmeta">
              <div className="t">{h.title}</div>
              <div className="sub">{h.source} · {secs(h.duration)} · score {h.score}{h.perf ? ` · ${n(h.perf.views)} views` : ""}</div>
              {h.snippet && <div className="sub cliplib-snip">{h.snippet}</div>}
            </div>
            <div className="acts" onClick={(e) => e.stopPropagation()}>
              <button className={`btn sm ghost${h.favorite ? " on" : ""}`} onClick={() => void fav(h)}>{h.favorite ? "★" : "☆"}</button>
              {inCol && <button className="linkbtn" onClick={() => void removeFromCol(h)}>Remove</button>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

interface PerfRow {
  id: string;
  jobId: string;
  title: string;
  score: number;
  duration: number;
  perf: Perf;
  perfAt: string | null;
}

export function ClipPerformanceTable({ clientId, onOpen }: { clientId: string; onOpen: (jobId: string) => void }) {
  const toast = useToast();
  const [rows, setRows] = useState<PerfRow[] | null>(null);
  const load = useCallback(async () => {
    try {
      setRows((await api.get<{ clips: PerfRow[] }>(`/clients/${clientId}/clip-performance`)).clips);
    } catch (e) {
      toast.fail("Loading performance", e);
    }
  }, [clientId, toast]);
  useEffect(() => void load(), [load]);
  async function refresh() {
    try {
      await api.post(`/clients/${clientId}/clip-performance/refresh`);
      toast.success("Pulling the latest numbers. They update every 3 hours on their own.");
      window.setTimeout(() => void load(), 4000);
    } catch (e) {
      toast.fail("Refreshing", e);
    }
  }
  return (
    <div>
      <div className="collab-row">
        <span className="sub" style={{ flex: 1 }}>How posted clips did, matched through their render to the post. Score is the AI's guess before posting.</span>
        <button className="btn sm ghost" onClick={() => void refresh()}>Refresh</button>
      </div>
      {rows?.length === 0 && <div className="empty">No posted clips yet. Render a clip with Send, post it, and its numbers show here.</div>}
      {!!rows?.length && (
        <table className="cliplib-perf">
          <thead>
            <tr><th>Clip</th><th>Score</th><th>Views</th><th>Likes</th><th>Comments</th><th>Shares</th><th>Watched</th><th>Where</th></tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} onClick={() => onOpen(r.jobId)}>
                <td>{r.title}</td>
                <td>{r.score}</td>
                <td>{n(r.perf.views)}</td>
                <td>{n(r.perf.likes)}</td>
                <td>{n(r.perf.comments)}</td>
                <td>{n(r.perf.shares)}</td>
                <td>{r.perf.avgWatchPct != null ? `${Math.round(r.perf.avgWatchPct * 100)}%` : "--"}</td>
                <td>{r.perf.platforms.join(", ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

interface ActivityRow {
  id: string;
  actor: string;
  action: string;
  detail: string | null;
  jobId: string | null;
  createdAt: string;
}
const VERB: Record<string, string> = {
  opened: "opened",
  rendered: "rendered",
  rendered_sent: "rendered and sent",
  liked: "liked",
  disliked: "passed on",
  trimmed: "trimmed",
  commented: "commented on",
  replied: "replied on",
  resolved: "resolved a note on",
  reopened: "reopened a note on",
  review_link: "shared a review link for",
  imported: "imported",
  auto_imported: "auto-imported",
  favorited: "favorited",
  unfavorited: "unfavorited",
  collected: "collected",
};

export function ClipActivityFeed({ clientId, onOpen }: { clientId: string; onOpen: (jobId: string) => void }) {
  const toast = useToast();
  const [rows, setRows] = useState<ActivityRow[] | null>(null);
  useEffect(() => {
    api.get<{ activity: ActivityRow[] }>(`/clients/${clientId}/clip-activity`).then(
      (r) => setRows(r.activity),
      (e) => toast.fail("Loading activity", e),
    );
  }, [clientId, toast]);
  return (
    <div className="collab-list">
      {rows?.length === 0 && <div className="empty">Nothing yet. Opens, renders, comments and imports show up here.</div>}
      {rows?.map((r) => (
        <div key={r.id} className="cliplib-act" onClick={() => r.jobId && onOpen(r.jobId)}>
          <b>{r.actor}</b> {VERB[r.action] ?? r.action} {r.detail && <i>{r.detail}</i>}
          <span className="sub">{new Date(r.createdAt).toLocaleString()}</span>
        </div>
      ))}
    </div>
  );
}

interface AutoImportView {
  settings: { on: boolean; channelId: string | null; playlists: string[]; uploads: boolean; recipeId: string | null; lastCheckAt: string | null; lastResult: string | null };
  keyReady: boolean;
  imports: { id: string; videoId: string; title: string; status: string; reason: string | null; clipJobId: string | null; createdAt: string }[];
}

export function ClipImports({ clientId, onOpen }: { clientId: string; onOpen: (jobId: string) => void }) {
  const toast = useToast();
  const { recipes } = useRecipes(clientId);
  const [yt, setYt] = useState<AutoImportView | null>(null);
  const [form, setForm] = useState({ on: false, channelId: "", playlists: "", uploads: true, recipeId: "" });
  const [link, setLink] = useState("");
  const [files, setFiles] = useState<{ id: string; name: string | null; size: number | null }[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const apply = (v: AutoImportView) => {
    setYt(v);
    setForm({ on: v.settings.on, channelId: v.settings.channelId ?? "", playlists: v.settings.playlists.join("\n"), uploads: v.settings.uploads, recipeId: v.settings.recipeId ?? "" });
  };
  useEffect(() => {
    api.get<AutoImportView>(`/clients/${clientId}/auto-import`).then(apply, (e) => toast.fail("Loading auto-import", e));
  }, [clientId, toast]);

  async function save() {
    try {
      apply(
        await api.put<AutoImportView>(`/clients/${clientId}/auto-import`, {
          on: form.on,
          channelId: form.channelId.trim() || null,
          playlists: form.playlists.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
          uploads: form.uploads,
          recipeId: form.recipeId || null,
        }),
      );
      toast.success(form.on ? "Auto-import is on. New uploads start a clip job." : "Saved.");
    } catch (e) {
      toast.fail("Saving auto-import", e);
    }
  }
  async function checkNow() {
    try {
      await api.post(`/clients/${clientId}/auto-import/check`);
      toast.success("Checking the channel now.");
      window.setTimeout(() => api.get<AutoImportView>(`/clients/${clientId}/auto-import`).then(apply, () => undefined), 5000);
    } catch (e) {
      toast.fail("Checking", e);
    }
  }
  async function listDrive() {
    setBusy("list");
    try {
      setFiles((await api.post<{ files: { id: string; name: string | null; size: number | null }[] }>(`/clients/${clientId}/drive/list`, { link })).files);
    } catch (e) {
      toast.fail("Reading the Drive link", e);
    } finally {
      setBusy(null);
    }
  }
  async function importDrive(f: { id: string; name: string | null }) {
    setBusy(f.id);
    try {
      const r = await api.post<{ id: string }>(`/clients/${clientId}/clip-jobs/from-drive`, { fileId: f.id, ...(f.name ? { name: f.name } : {}) });
      onOpen(r.id);
    } catch (e) {
      toast.fail("Importing from Drive", e);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="cliplib-imports">
      <div className="glass-sm pnl-card">
        <b>YouTube auto-import</b>
        {/* ponytail: the YouTube API has no download, so only videos posted through Toreroflow (file still on disk) import. */}
        <p className="sub">
          New videos on the brand's channel start a clip job with the chosen recipe. Only videos posted through Toreroflow can import (YouTube gives no
          download); others are listed as skipped.
        </p>
        {yt && !yt.keyReady && <p className="sub">YOUTUBE_API_KEY is not set on the server, so checks are off.</p>}
        <label className="mini"><input type="checkbox" checked={form.on} onChange={(e) => setForm({ ...form, on: e.target.checked })} /> On</label>
        <input className="field-in" placeholder="Channel id (UC…)" value={form.channelId} onChange={(e) => setForm({ ...form, channelId: e.target.value })} />
        <label className="mini"><input type="checkbox" checked={form.uploads} onChange={(e) => setForm({ ...form, uploads: e.target.checked })} /> Watch all uploads</label>
        <textarea className="field-in" rows={2} placeholder="Extra playlist ids (PL…), one per line" value={form.playlists} onChange={(e) => setForm({ ...form, playlists: e.target.value })} />
        <select className="field-in" value={form.recipeId} onChange={(e) => setForm({ ...form, recipeId: e.target.value })}>
          <option value="">Brand default recipe</option>
          {recipes.map((r) => (
            <option key={r.id} value={r.id}>{r.name}</option>
          ))}
        </select>
        <div className="collab-row">
          <button className="btn sm" onClick={() => void save()}>Save</button>
          <button className="btn sm ghost" disabled={!yt?.settings.on} onClick={() => void checkNow()}>Check now</button>
          {yt?.settings.lastResult && <span className="sub">{yt.settings.lastResult}</span>}
        </div>
        {yt?.imports.map((i) => (
          <div key={i.id} className="cliplib-act" onClick={() => i.clipJobId && onOpen(i.clipJobId)}>
            <b>{i.status}</b> {i.title} {i.reason && <span className="sub">{i.reason}</span>}
          </div>
        ))}
      </div>
      <div className="glass-sm pnl-card">
        <b>Google Drive</b>
        <p className="sub">Paste a file or folder link shared as "Anyone with the link". Files import directly; folders list their videos.</p>
        <div className="collab-row">
          <input className="field-in" placeholder="https://drive.google.com/…" value={link} onChange={(e) => setLink(e.target.value)} />
          <button className="btn sm" disabled={!link.trim() || busy !== null} onClick={() => void listDrive()}>{busy === "list" ? "Reading..." : "Open"}</button>
        </div>
        {files?.length === 0 && <div className="empty">No videos in that folder.</div>}
        {files?.map((f) => (
          <div key={f.id} className="collab-row">
            <span style={{ flex: 1 }}>{f.name ?? f.id}{f.size ? ` · ${Math.round(f.size / 1e6)} MB` : ""}</span>
            <button className="btn sm" disabled={busy !== null} onClick={() => void importDrive(f)}>{busy === f.id ? "Importing..." : "Get clips"}</button>
          </div>
        ))}
      </div>
    </div>
  );
}
