import { useEffect, useRef, useState } from "react";
import { addCut, fillerCuts, silenceCuts } from "@toreroflow/core";
import { api, fileUrl } from "../../lib/api";
import { useToast } from "../../components/Toasts";
import { useEditor } from "../StudioEditor";
import "./AutoCutStep.css";

/**
 * Step 1: intake. Drop clips in, order them, choose what auto cut removes,
 * then Continue applies the proposed cuts and moves to the Edit step.
 */

interface UploadRow {
  id: string;
  name: string;
  state: "waiting" | "uploading" | "failed";
  error?: string;
}

export default function AutoCutStep() {
  const { project, assets, refreshAssets, doc, update, setStep } = useEditor();
  const toast = useToast();

  const clipAssets = assets.filter((a) => a.kind === "clip");
  const byId = new Map(clipAssets.map((a) => [a.id, a]));

  /* ---- uploads, one file at a time ---- */

  const [uploads, setUploads] = useState<UploadRow[]>([]);
  const queue = useRef<Array<{ rowId: string; file: File }>>([]);
  const pumping = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const pump = async () => {
    if (pumping.current) return;
    pumping.current = true;
    for (;;) {
      const next = queue.current.shift();
      if (!next) break;
      setUploads((u) =>
        u.map((r) => (r.id === next.rowId ? { ...r, state: "uploading" } : r)),
      );
      try {
        const form = new FormData();
        form.append("file", next.file, next.file.name);
        const asset = await api.postForm<{ id: string }>(
          `/edit-projects/${project.id}/assets?kind=clip`,
          form,
        );
        update((d) => ({ ...d, clips: [...d.clips, { assetId: asset.id }] }));
        setUploads((u) => u.filter((r) => r.id !== next.rowId));
        await refreshAssets();
      } catch (err) {
        setUploads((u) =>
          u.map((r) =>
            r.id === next.rowId
              ? {
                  ...r,
                  state: "failed",
                  error: err instanceof Error ? err.message : "upload failed",
                }
              : r,
          ),
        );
      }
    }
    pumping.current = false;
  };

  const addFiles = (list: FileList | File[]) => {
    // Some containers (MOV) report an empty type; let the server judge those.
    const files = [...list].filter((f) => !f.type || f.type.startsWith("video/"));
    if (!files.length) return;
    const rows = files.map((f) => {
      const rowId = crypto.randomUUID();
      queue.current.push({ rowId, file: f });
      return { id: rowId, name: f.name, state: "waiting" as const };
    });
    setUploads((u) => [...u, ...rows]);
    void pump();
  };

  /* ---- poll while anything is still processing ---- */

  const processing = clipAssets.some(
    (a) => a.status === "uploaded" || a.status === "processing",
  );
  useEffect(() => {
    if (!processing) return;
    const t = setInterval(() => void refreshAssets(), 3000);
    return () => clearInterval(t);
  }, [processing, refreshAssets]);

  /* ---- order, mirrored from doc.clips, committed on drop ---- */

  const [order, setOrder] = useState<string[]>(doc.clips.map((c) => c.assetId));
  const orderRef = useRef(order);
  useEffect(() => {
    const ids = doc.clips.map((c) => c.assetId);
    orderRef.current = ids;
    setOrder(ids);
  }, [doc.clips]);

  const cardRefs = useRef(new Map<string, HTMLDivElement>());
  const drag = useRef<{
    id: string;
    startX: number;
    startY: number;
    dx: number;
    dy: number;
    lastX: number;
    lastT: number;
    tilt: number;
    active: boolean;
  } | null>(null);
  const [, forceRender] = useState(0);

  /**
   * FLIP: siblings glide to their new slots instead of teleporting. Rects are
   * recorded before the reorder, the inverted delta is applied as a transform,
   * and releasing it on the next frame lets the transition play. Transform
   * only, so the glass cards never re-blur mid-move.
   */
  const flip = (mutate: () => void) => {
    const before = new Map<string, DOMRect>();
    for (const [id, el] of cardRefs.current) before.set(id, el.getBoundingClientRect());
    mutate();
    requestAnimationFrame(() => {
      for (const [id, el] of cardRefs.current) {
        if (drag.current?.id === id) continue;
        const prev = before.get(id);
        if (!prev) continue;
        const now = el.getBoundingClientRect();
        const dx = prev.left - now.left;
        if (dx === 0) continue;
        el.style.transition = "none";
        el.style.transform = `translateX(${dx}px)`;
        requestAnimationFrame(() => {
          el.style.transition = "transform .28s cubic-bezier(.22,1,.36,1)";
          el.style.transform = "";
        });
      }
    });
  };

  const swap = (idx: number, other: number) => {
    const next = [...orderRef.current];
    [next[idx], next[other]] = [next[other]!, next[idx]!];
    orderRef.current = next;
    setOrder(next);
  };

  const onCardPointerDown = (e: React.PointerEvent, id: string) => {
    // Buttons on the card keep their own clicks.
    if ((e.target as HTMLElement).closest("button")) return;
    e.preventDefault();
    try {
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // Synthetic pointers (tests, automation) have no capturable id; the
      // drag still works from the move events alone.
    }
    drag.current = {
      id,
      startX: e.clientX,
      startY: e.clientY,
      dx: 0,
      dy: 0,
      lastX: e.clientX,
      lastT: performance.now(),
      tilt: 0,
      active: false,
    };
  };

  const onCardPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    d.dx = e.clientX - d.startX;
    d.dy = e.clientY - d.startY;
    // A click is not a drag until it has moved enough to mean it.
    if (!d.active && Math.hypot(d.dx, d.dy) > 6) d.active = true;
    if (!d.active) return;

    // The ragdoll tilt: rotation follows horizontal velocity and eases back.
    const now = performance.now();
    const vx = (e.clientX - d.lastX) / Math.max(1, now - d.lastT);
    d.tilt = Math.max(-11, Math.min(11, d.tilt * 0.8 + vx * 26));
    d.lastX = e.clientX;
    d.lastT = now;

    // Crossing a neighbour's midpoint swaps places, FLIP easing the rest.
    const el = cardRefs.current.get(d.id);
    if (el) {
      const mine = el.getBoundingClientRect();
      const center = mine.left + mine.width / 2;
      const idx = orderRef.current.indexOf(d.id);
      const left = idx > 0 ? cardRefs.current.get(orderRef.current[idx - 1]!) : null;
      const right =
        idx < orderRef.current.length - 1
          ? cardRefs.current.get(orderRef.current[idx + 1]!)
          : null;
      if (left) {
        const r = left.getBoundingClientRect();
        if (center < r.left + r.width / 2) {
          flip(() => {
            swap(idx, idx - 1);
            // The pickup point travels with the card across the swap.
            d.startX -= r.width;
            d.dx += r.width;
          });
        }
      }
      if (right) {
        const r = right.getBoundingClientRect();
        if (center > r.left + r.width / 2) {
          flip(() => {
            swap(idx, idx + 1);
            d.startX += r.width;
            d.dx -= r.width;
          });
        }
      }
    }
    forceRender((n) => n + 1);
  };

  const onCardPointerUp = () => {
    const d = drag.current;
    if (!d) return;
    drag.current = null;
    forceRender((n) => n + 1);
    if (!d.active) return;
    const ids = orderRef.current;
    update((doc2) => {
      const same =
        doc2.clips.length === ids.length &&
        doc2.clips.every((c, i) => c.assetId === ids[i]);
      return same ? doc2 : { ...doc2, clips: ids.map((assetId) => ({ assetId })) };
    });
  };

  /* ---- delete, two presses like everywhere else ---- */

  const [confirmId, setConfirmId] = useState<string | null>(null);
  const removeClip = async (id: string) => {
    setConfirmId(null);
    try {
      await api.del(`/edit-assets/${id}`);
      update((d) => {
        const cuts = { ...d.cuts };
        const splits = { ...d.splits };
        delete cuts[id];
        delete splits[id];
        return { ...d, clips: d.clips.filter((c) => c.assetId !== id), cuts, splits };
      });
      await refreshAssets();
    } catch (err) {
      toast.fail("Could not delete that clip", err);
    }
  };

  /* ---- auto cut on continue ---- */

  const [silences, setSilences] = useState(true);
  const [fillers, setFillers] = useState(true);

  const onContinue = () => {
    if (silences || fillers) {
      update((d) => {
        let next = d;
        for (const a of clipAssets) {
          if (a.status !== "ready" || !a.words) continue;
          const ranges = [
            ...(silences ? silenceCuts(a.words) : []),
            ...(fillers ? fillerCuts(a.words) : []),
          ];
          for (const r of ranges) next = addCut(next, a.id, r, a.durationSec ?? undefined);
        }
        return next;
      });
    }
    setStep(2);
  };

  /* ---- render ---- */

  const uploadsActive = uploads.some((r) => r.state !== "failed");
  const busy = processing || uploadsActive;
  const empty = doc.clips.length === 0 && uploads.length === 0;

  const totalSec = clipAssets.reduce((s, a) => s + (a.durationSec ?? 0), 0);
  const d = drag.current;

  const dropZone = (big: boolean) => (
    <div
      className={`drop${big ? " acs-drop-big" : " acs-drop"}`}
      style={dragOver ? { borderColor: "rgba(255,111,97,.65)" } : undefined}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
      }}
      onClick={() => fileInput.current?.click()}
    >
      <div className="ring">
        <svg>
          <use href="#i-up" />
        </svg>
      </div>
      <b>Drag your clips in, or click to browse</b>
      <p>MP4, MOV and other common formats. Up to 4GB each.</p>
    </div>
  );

  return (
    <div className="acs">
      <input
        ref={fileInput}
        type="file"
        accept="video/*"
        multiple
        style={{ display: "none" }}
        onChange={(e) => {
          if (e.target.files) addFiles(e.target.files);
          e.target.value = "";
        }}
      />

      {empty ? (
        <div className="acs-center">{dropZone(true)}</div>
      ) : (
        <>
          <div className="acs-head">
            <h3>Review your clips</h3>
            <div className="sub">
              {clipAssets.length} {clipAssets.length === 1 ? "clip" : "clips"} -{" "}
              {Math.round(totalSec)}s. Drag to set the order auto cut reads them.
            </div>
          </div>

          {dropZone(false)}

          {uploads.length > 0 && (
            <div className="acs-uprows">
              {uploads.map((r) => (
                <div className="acs-uprow" key={r.id}>
                  <span className="acs-upname">{r.name}</span>
                  {r.state === "failed" ? (
                    <>
                      <span className="acs-uperr">{r.error}</span>
                      <button
                        className="iconbtn acs-updismiss"
                        title="Dismiss"
                        onClick={() =>
                          setUploads((u) => u.filter((x) => x.id !== r.id))
                        }
                      >
                        <svg viewBox="0 0 24 24">
                          <use href="#i-x" />
                        </svg>
                      </button>
                    </>
                  ) : (
                    <>
                      <span className="mini">
                        {r.state === "uploading" ? "Uploading..." : "Waiting"}
                      </span>
                      <span className={`acs-upbar${r.state === "uploading" ? " skel" : ""}`} />
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="acs-cards">
            {order.map((id) => {
              const a = byId.get(id);
              if (!a) return null;
              const ready = a.status === "ready";
              const dragging = d?.active && d.id === id;
              const strip = ready ? fileUrl(a.stripUrl) : null;
              return (
                <div
                  key={id}
                  className={`acs-card${dragging ? " dragging" : ""}`}
                  ref={(el) => {
                    if (el) cardRefs.current.set(id, el);
                    else cardRefs.current.delete(id);
                  }}
                  style={
                    dragging
                      ? {
                          transform: `translate(${d!.dx}px, ${d!.dy}px) rotate(${d!.tilt.toFixed(1)}deg) scale(1.05)`,
                        }
                      : undefined
                  }
                  onPointerDown={(e) => onCardPointerDown(e, id)}
                  onPointerMove={onCardPointerMove}
                  onPointerUp={onCardPointerUp}
                >
                  <div
                    className={`acs-strip${!ready && a.status !== "failed" ? " skel" : ""}`}
                    style={strip ? { backgroundImage: `url(${strip})` } : undefined}
                  >
                    {a.durationSec != null && (
                      <span className="acs-dur">{Math.round(a.durationSec)}s</span>
                    )}
                    {!ready && a.status !== "failed" && (
                      <span className="mini acs-proc">Processing...</span>
                    )}
                    {a.status === "failed" && (
                      <span className="acs-failedtag">Failed</span>
                    )}
                  </div>
                  <div className="acs-cardrow">
                    <span className="acs-name" title={a.originalName}>
                      {a.originalName}
                    </span>
                    <button
                      className="dangerbtn acs-del"
                      title={
                        confirmId === id
                          ? "Click again to delete this clip"
                          : "Delete this clip"
                      }
                      onClick={() => {
                        if (confirmId === id) void removeClip(id);
                        else {
                          setConfirmId(id);
                          setTimeout(
                            () => setConfirmId((c) => (c === id ? null : c)),
                            3000,
                          );
                        }
                      }}
                    >
                      {confirmId === id ? "Sure?" : "Delete"}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div className="card glass acs-auto">
            <h3>Auto cut on continue</h3>
            <div className="acs-chips">
              <button
                className={`chip acs-toggle${silences ? " on" : ""}`}
                onClick={() => setSilences((v) => !v)}
              >
                Silences
              </button>
              <button
                className={`chip acs-toggle${fillers ? " on" : ""}`}
                onClick={() => setFillers((v) => !v)}
              >
                Filler words
              </button>
            </div>
            <div className="sub">
              The studio marks quiet gaps and filler words as removed. You can
              restore any of it in the next step.
            </div>
          </div>

          <div className="acs-actions">
            <button className="btn ghost" onClick={() => fileInput.current?.click()}>
              Add more clips
            </button>
            <button className="btn acs-continue" disabled={busy} onClick={onContinue}>
              {busy ? "Processing clips..." : "Continue"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
