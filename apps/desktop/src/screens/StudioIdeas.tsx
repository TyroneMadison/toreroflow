import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Asset, RepurposeJob } from "@toreroflow/contracts";
import { api, fileUrl, videoLabel } from "../lib/api";
import {
  ASSET_ACCEPT,
  assetQuery,
  fmtDuration,
  googleFontsHref,
  HEX,
  logoBox,
  pickWeight,
  REPURPOSE_STEPS,
  repurposeProgress,
  stepStatus,
  type Sharing,
} from "../lib/ideas";
import { useAppState } from "../state/AppState";
import { useToast } from "../components/Toasts";
import { ErrorState, Loading } from "../components/states";
import Select from "../components/Select";
import { Badge, Lbl, Note } from "../components/ideas/IdeaBits";
import { useBrandKit, type KitView } from "../editor/brandKit";
import { useBrandVideos } from "./IdeaScreens";
import "./IdeaScreens.css";

/*
 * The Studio areas from the ideas set: the brand kit, the shared asset
 * library, and Repurpose on top of the editor. They render inside
 * EditScreen, under its area chips, so they share its header.
 */

interface FontFamily {
  family: string;
  category: string;
  weights: number[];
}

/** One <link> for the kit's Google Fonts, swapped when the families change. */
function useGoogleFonts(fonts: KitView["fonts"]) {
  const href = googleFontsHref(fonts);
  useEffect(() => {
    if (!href) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = href;
    document.head.appendChild(link);
    return () => link.remove();
  }, [href]);
}

const MAX_COLORS = 6;

// ------------------------------------------------------------- brand kit

export function BrandKitArea({ brandId, brandName }: { brandId: string; brandName: string }) {
  const toast = useToast();
  const loaded = useBrandKit(brandId);
  const [kit, setKit] = useState<KitView | null>(null);
  const [library, setLibrary] = useState<FontFamily[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [logoSize, setLogoSize] = useState<{ w: number; h: number } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => setKit(loaded), [loaded]);
  useEffect(() => {
    api
      .get<{ fonts: FontFamily[] }>("/brand-kit/fonts")
      .then((r) => setLibrary(r.fonts))
      .catch(() => setLibrary([]));
  }, []);
  useGoogleFonts(kit?.fonts ?? []);

  if (!kit || !library) return <Loading screen="brandkit" label="Loading the brand kit" />;

  const change = (next: Partial<KitView>) => {
    setKit({ ...kit, ...next });
    setSaved(false);
  };
  // Slot 0 is the headline font, slot 1 captions and body, like the mockup.
  const setFont = (slot: 0 | 1, family: string) => {
    const lib = library.find((f) => f.family === family);
    const fonts = [...kit.fonts];
    if (!lib) fonts.splice(slot, 1);
    else {
      const w = slot === 0 ? [pickWeight(lib.weights, "headline")] : [...new Set([pickWeight(lib.weights, "body"), ...lib.weights.filter((x) => x === 700)])];
      fonts[slot] = { family, weights: w };
    }
    change({ fonts: fonts.filter(Boolean) });
  };
  const fontOptions = [
    { value: "", label: "None" },
    ...library.map((f) => ({ value: f.family, label: f.family, hint: f.category })),
  ];
  const head = kit.fonts[0];
  const body = kit.fonts[1];

  const save = async () => {
    setBusy(true);
    try {
      const { logoUrl: _skip, ...body } = kit;
      setKit(await api.put<KitView>(`/brands/${brandId}/kit`, body));
      setSaved(true);
    } catch (err) {
      toast.fail("Could not save the brand kit", err);
    } finally {
      setBusy(false);
    }
  };

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setBusy(true);
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      const next = await api.postForm<KitView>(`/brands/${brandId}/kit/logo`, form);
      setKit({ ...kit, logoAssetId: next.logoAssetId, logoUrl: next.logoUrl });
      setLogoSize(null);
    } catch (err) {
      toast.fail("Could not upload the logo", err);
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  // The thumbnail preview is a 4:5 post cover; the logo sits where the thumbnail builder puts it.
  const box = logoSize ? logoBox(1080, 1350, logoSize.w, logoSize.h) : null;
  const main = kit.colors[0] ?? "#FF7A66";
  const dark = kit.colors.find((c, i) => i > 0) ?? "#111111";

  return (
    <div className="id-two" data-testid="brandkit">
      <div className="card glass id-card">
        <Lbl>Fonts</Lbl>
        <p className="id-fontrow" style={{ fontFamily: head ? `'${head.family}'` : undefined, fontWeight: head?.weights[0] }}>
          {head?.family ?? "No headline font"}
          <small>headlines</small>
        </p>
        <p className="id-fontrow" style={{ fontFamily: body ? `'${body.family}'` : undefined, fontSize: 16 }}>
          {body?.family ?? "No body font"}
          <small>captions and body</small>
        </p>
        <div className="id-filters">
          <label className="id-field">
            <span>Headline font</span>
            <Select aria-label="Headline font" value={head?.family ?? ""} options={fontOptions} onChange={(v) => setFont(0, v)} />
          </label>
          <label className="id-field">
            <span>Body font</span>
            <Select aria-label="Body font" value={body?.family ?? ""} options={fontOptions} onChange={(v) => setFont(1, v)} disabled={!head} />
          </label>
        </div>
        <p className="id-note">From the Google Fonts library. Free to use, no upload needed.</p>

        <Lbl>Colors</Lbl>
        <div className="id-swatches" role="group" aria-label={`${brandName} colors`}>
          {kit.colors.map((c, i) => (
            <span key={i} className="id-chip" style={{ paddingLeft: 6 }}>
              <label className="id-swatch" style={{ background: c }}>
                <span className="sr-only">Color {i + 1}, {c}</span>
                <input
                  type="color"
                  value={c.toLowerCase()}
                  onChange={(e) => change({ colors: kit.colors.map((x, j) => (j === i ? e.target.value.toUpperCase() : x)) })}
                />
              </label>
              <span className="id-mono">{c}</span>
              <button type="button" aria-label={`Remove ${c}`} onClick={() => change({ colors: kit.colors.filter((_, j) => j !== i) })}>
                ×
              </button>
            </span>
          ))}
          {kit.colors.length < MAX_COLORS && (
            <button type="button" className="btn ghost" style={{ minHeight: 44 }} onClick={() => change({ colors: [...kit.colors, "#FF7A66"] })}>
              Add color
            </button>
          )}
        </div>

        <Lbl>Logo</Lbl>
        <div className="id-acts">
          <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" className="sr-only" id="kit-logo" onChange={(e) => void upload(e.target.files?.[0])} />
          <label htmlFor="kit-logo" className="btn ghost" style={{ minHeight: 44, alignItems: "center", display: "inline-flex", cursor: "pointer" }}>
            {kit.logoUrl ? "Replace logo" : "Upload logo"}
          </label>
          {kit.logoUrl && <span className="id-note">PNG with a clear background works best.</span>}
        </div>
        <p className="id-note">PNG, JPEG or WebP, up to 5 MB. It goes on every thumbnail made for {brandName}.</p>

        <label className="id-field">
          <span>Caption voice notes</span>
          <textarea
            className="field-in"
            rows={3}
            maxLength={4000}
            value={kit.voiceNotes}
            placeholder="Short and direct. Price in first line. One emoji max."
            onChange={(e) => change({ voiceNotes: e.target.value })}
          />
        </label>
        <button
          type="button"
          className="btn pri id-full"
          disabled={busy || kit.colors.some((c) => !HEX.test(c))}
          onClick={() => void save()}
        >
          {busy ? "Saving..." : "Save brand kit"}
        </button>
        {saved && <Note tone="ok">Saved. The editor and new thumbnails use it now.</Note>}
      </div>

      <div className="card glass id-card" data-testid="brandkit.preview">
        <Lbl>Pulled into a thumbnail</Lbl>
        <div className="id-thumb" style={{ aspectRatio: "4 / 5", background: `linear-gradient(180deg, ${main}, ${dark})` }}>
          <b style={{ fontFamily: head ? `'${head.family}'` : undefined, fontWeight: head?.weights[0] ?? 800 }}>
            2021 M3,
            <br />
            $54,900
          </b>
          {kit.logoUrl && (
            <img
              src={fileUrl(kit.logoUrl) ?? undefined}
              alt={`${brandName} logo`}
              onLoad={(e) => setLogoSize({ w: e.currentTarget.naturalWidth || 1, h: e.currentTarget.naturalHeight || 1 })}
              style={
                box
                  ? { left: `${(box.x / 1080) * 100}%`, top: `${(box.y / 1350) * 100}%`, width: `${(box.w / 1080) * 100}%`, height: `${(box.h / 1350) * 100}%` }
                  : { visibility: "hidden" }
              }
            />
          )}
        </div>
        <Note tone="ok">
          {[head && "Font", kit.colors.length && "colors", kit.logoUrl && "logo", kit.voiceNotes.trim() && "voice"].filter(Boolean).join(", ") ||
            "Nothing"}{" "}
          applied from brand kit.
        </Note>
        <p className="id-note">In Studio, Edit, the kit colors lead every color picker and Caption style has Apply brand kit.</p>
      </div>
    </div>
  );
}

// --------------------------------------------------------- asset library

const TYPES: Asset["type"][] = ["logo", "video", "template", "audio", "image"];
const TYPE_LABEL: Record<Asset["type"], string> = { logo: "Logo", video: "Video", template: "Template", audio: "Audio", image: "Image" };
const SHARING: { id: Sharing; label: string }[] = [
  { id: "all", label: "All" },
  { id: "shared", label: "Shared" },
  { id: "brand", label: "Client only" },
];

function AssetPreview({ a }: { a: Asset }) {
  const src = fileUrl(a.url) ?? undefined;
  if (a.type === "logo" || a.type === "image") return <img src={src} alt="" loading="lazy" />;
  if (a.type === "video") return <video src={src} preload="metadata" muted aria-hidden="true" />;
  return <span aria-hidden="true">{TYPE_LABEL[a.type]}</span>;
}

export function AssetsArea() {
  const { clients, selectedClient } = useAppState();
  const toast = useToast();
  const [filter, setFilter] = useState<{ brandId: string; type: string; sharing: Sharing }>({ brandId: "", type: "", sharing: "all" });
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [up, setUp] = useState<{ type: Asset["type"]; owner: string; name: string }>({ type: "image", owner: selectedClient?.id ?? "", name: "" });
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    try {
      setAssets((await api.get<{ assets: Asset[] }>(assetQuery(filter))).assets);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not load assets");
    }
  }, [filter]);
  useEffect(() => {
    void load();
  }, [load]);

  const nameOf = (id: string | null) => (id ? (clients.find((c) => c.id === id)?.name ?? "Unknown brand") : "All");

  const upload = async () => {
    if (!file) return;
    setBusy(true);
    try {
      // Fields before the file: the API reads them off the multipart stream first.
      const form = new FormData();
      form.append("type", up.type);
      form.append("brandId", up.owner);
      if (up.name.trim()) form.append("name", up.name.trim());
      form.append("file", file, file.name);
      await api.postForm("/assets", form);
      setFile(null);
      setUp({ ...up, name: "" });
      if (fileRef.current) fileRef.current.value = "";
      await load();
    } catch (err) {
      toast.fail("Could not upload the asset", err);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    setConfirm(null);
    try {
      await api.del(`/assets/${id}`);
      setAssets((cur) => cur?.filter((a) => a.id !== id) ?? cur);
    } catch (err) {
      toast.fail("Could not delete that asset", err);
    }
  };

  const brandOptions = [{ value: "", label: "All clients" }, ...clients.map((c) => ({ value: c.id, label: c.name }))];

  return (
    <div data-testid="assets">
      <div className="card glass id-card">
        <div className="id-filters">
          <label className="id-field">
            <span>Client</span>
            <Select aria-label="Client" value={filter.brandId} options={brandOptions} onChange={(v) => setFilter({ ...filter, brandId: v })} />
          </label>
          <label className="id-field">
            <span>Type</span>
            <Select
              aria-label="Type"
              value={filter.type}
              options={[{ value: "", label: "All types" }, ...TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }))]}
              onChange={(v) => setFilter({ ...filter, type: v })}
            />
          </label>
        </div>
        <div className="id-seg" role="group" aria-label="Sharing">
          {SHARING.map((s) => (
            <button key={s.id} type="button" aria-pressed={filter.sharing === s.id} onClick={() => setFilter({ ...filter, sharing: s.id })}>
              {s.label}
            </button>
          ))}
        </div>
        {filter.brandId && <p className="id-note">Showing what {nameOf(filter.brandId)} can see: its own assets and the shared ones.</p>}
      </div>

      <div className="card glass id-card">
        {error ? (
          <ErrorState screen="assets" message={error} onRetry={() => void load()} />
        ) : assets === null ? (
          <Loading screen="assets" label="Loading assets" />
        ) : assets.length === 0 ? (
          <p className="id-note">No assets match these filters yet.</p>
        ) : (
          <ul className="id-grid" aria-label="Assets">
            {assets.map((a) => (
              <li className="id-tile" key={a.id}>
                <div className="id-th">
                  <AssetPreview a={a} />
                </div>
                <b title={a.name}>{a.name}</b>
                <small>
                  {nameOf(a.brandId)}, {TYPE_LABEL[a.type]}
                </small>
                <span>
                  <Badge tone={a.brandId ? "accent" : "flat"}>{a.brandId ? "Client only" : "Shared"}</Badge>
                </span>
                <button
                  type="button"
                  className="btn ghost"
                  aria-label={confirm === a.id ? `Press again to delete ${a.name}` : `Delete ${a.name}`}
                  onClick={() => {
                    if (confirm === a.id) void remove(a.id);
                    else {
                      setConfirm(a.id);
                      setTimeout(() => setConfirm((c) => (c === a.id ? null : c)), 3000);
                    }
                  }}
                >
                  {confirm === a.id ? "Sure?" : "Delete"}
                </button>
              </li>
            ))}
          </ul>
        )}

        <Lbl>Upload asset</Lbl>
        <div className="id-filters">
          <label className="id-field">
            <span>Type</span>
            <Select
              aria-label="Upload type"
              value={up.type}
              options={TYPES.map((t) => ({ value: t, label: TYPE_LABEL[t] }))}
              onChange={(v) => setUp({ ...up, type: v as Asset["type"] })}
            />
          </label>
          <label className="id-field">
            <span>Who can use it</span>
            <Select
              aria-label="Who can use it"
              value={up.owner}
              options={[{ value: "", label: "Shared, every client" }, ...clients.map((c) => ({ value: c.id, label: `${c.name} only` }))]}
              onChange={(v) => setUp({ ...up, owner: v })}
            />
          </label>
          <label className="id-field">
            <span>Name, optional</span>
            <input className="field-in" maxLength={200} value={up.name} placeholder="Whoosh SFX" onChange={(e) => setUp({ ...up, name: e.target.value })} />
          </label>
          <label className="id-field">
            <span>File</span>
            <input ref={fileRef} className="field-in" type="file" accept={ASSET_ACCEPT[up.type]} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
          </label>
        </div>
        <button type="button" className="btn pri id-full" disabled={busy || !file} onClick={() => void upload()}>
          {busy ? "Uploading..." : "Upload asset"}
        </button>
      </div>
    </div>
  );
}

// ------------------------------------------------------------- repurpose

/** No list route exists yet, so the brand's job ids live on this machine. */
const jobsKey = (brandId: string) => `toreroflow-repurpose-${brandId}`;
const STEP_TEXT: Record<ReturnType<typeof stepStatus>, string> = { done: "done", running: "running", queued: "next", failed: "failed", todo: "" };

export function RepurposeCard({ brandId }: { brandId: string }) {
  const toast = useToast();
  const videos = useBrandVideos(brandId);
  const kit = useBrandKit(brandId);
  const [picked, setPicked] = useState("");
  const [job, setJob] = useState<RepurposeJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const long = useMemo(() => (videos ?? []).slice().sort((a, b) => (b.durationSec ?? 0) - (a.durationSec ?? 0)), [videos]);
  const sourceId = job?.sourceVideoId ?? (picked || long[0]?.id || "");
  const source = videos?.find((v) => v.id === sourceId);

  const refresh = useCallback(async (id: string) => {
    try {
      setJob(await api.get<RepurposeJob>(`/repurpose/${id}`));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not load the job");
    }
  }, []);

  // The newest job for this brand, picked back up after a restart.
  useEffect(() => {
    const last = (JSON.parse(localStorage.getItem(jobsKey(brandId)) ?? "[]") as string[])[0];
    if (last) void refresh(last);
  }, [brandId, refresh]);

  // Poll while the worker has it.
  useEffect(() => {
    if (!job || job.state === "done" || job.state === "failed" || job.step === "review") return;
    const t = setInterval(() => void refresh(job.id), 5000);
    return () => clearInterval(t);
  }, [job, refresh]);

  const start = async () => {
    setBusy(true);
    try {
      const j = await api.post<RepurposeJob>("/repurpose", { sourceVideoId: sourceId });
      const ids = JSON.parse(localStorage.getItem(jobsKey(brandId)) ?? "[]") as string[];
      localStorage.setItem(jobsKey(brandId), JSON.stringify([j.id, ...ids].slice(0, 20)));
      setJob(j);
    } catch (err) {
      toast.fail("Could not start the repurpose job", err);
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    if (!job) return;
    setBusy(true);
    try {
      setJob(await api.post<RepurposeJob>(`/repurpose/${job.id}/retry`));
    } catch (err) {
      toast.fail("Retry did not go through", err);
    } finally {
      setBusy(false);
    }
  };

  const progress = job ? repurposeProgress(job) : 0;
  const current = job ? REPURPOSE_STEPS.find((s) => s.id === job.step)?.label : null;

  return (
    <div className="card glass id-card" data-testid="repurpose" style={{ marginBottom: 16 }}>
      <div className="id-cardhead">
        <div>
          <h3 className="id-h3">Repurpose</h3>
          <p className="id-note">One long video in. Clips, captions and thumbnails out in one run.</p>
        </div>
        {job && (
          <button type="button" className="btn ghost" style={{ minHeight: 44 }} onClick={() => setJob(null)}>
            New run
          </button>
        )}
      </div>
      <Lbl>Source</Lbl>
      {videos === null ? (
        <Loading screen="repurpose" />
      ) : !videos.length ? (
        <p className="id-note">Upload a long video in Upload & Schedule first.</p>
      ) : job ? (
        <p className="id-line">
          {source ? videoLabel(source) : "The source video"}
          {source?.durationSec ? `, ${fmtDuration(source.durationSec)}` : ""}
        </p>
      ) : (
        <div className="id-filters">
          <label className="id-field">
            <span>Long video</span>
            <Select
              aria-label="Long video"
              value={sourceId}
              options={long.map((v) => ({ value: v.id, label: videoLabel(v), hint: fmtDuration(v.durationSec) }))}
              onChange={setPicked}
            />
          </label>
          <div className="id-field">
            <span aria-hidden="true">&nbsp;</span>
            <button type="button" className="btn pri id-full" style={{ marginTop: 0 }} disabled={busy || !sourceId} onClick={() => void start()}>
              Start repurpose
            </button>
          </div>
        </div>
      )}
      {error && <Note tone="bad">{error}</Note>}
      {job && (
        <>
          <ol className="id-steps" aria-label="Steps">
            {REPURPOSE_STEPS.map((s) => {
              const st = stepStatus(job, s.id);
              return (
                <li key={s.id} className={`id-step ${st}`}>
                  {s.label}
                  {st === "done" ? " ✓" : ""}
                  {STEP_TEXT[st] && st !== "done" && <span className="sr-only">, {STEP_TEXT[st]}</span>}
                  {st === "done" && <span className="sr-only">, done</span>}
                </li>
              );
            })}
          </ol>
          <div className="id-bar" role="progressbar" aria-label="Repurpose progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
            <span style={{ width: `${progress * 100}%` }} />
          </div>
          {job.state === "failed" ? (
            <Note tone="bad">
              {current} failed. Finished steps are kept, so a retry picks up here.{" "}
              <button type="button" className="btn ghost" style={{ minHeight: 44, marginLeft: 8 }} disabled={busy} onClick={() => void retry()}>
                Retry {current}
              </button>
            </Note>
          ) : job.state === "done" ? (
            <Note tone="ok">Done. Kept clips are in Ready queue as drafts.</Note>
          ) : (
            <Note>
              {job.state === "queued" ? `Waiting to run ${current}.` : `${current} is running.`} The step runner is not connected on the server yet, so the job
              waits here and resumes where it stopped.
            </Note>
          )}
          <Lbl>Review</Lbl>
          <p className="id-note">
            Each clip shows here for Keep or Skip. Kept clips go to Ready queue as drafts and are never posted on their own.
            {kit?.logoUrl ? " Thumbnails carry the brand kit logo." : " Add a logo in Brand kit and the thumbnails carry it."}
          </p>
        </>
      )}
    </div>
  );
}
