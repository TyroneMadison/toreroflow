import { useRef, useState } from "react";
import type { EditDoc } from "@toreroflow/core";
import { api } from "../../lib/api";
import { useEditor, type EditAssetInfo } from "../StudioEditor";
import "./panels.css";

export type DrawerTab = "clips" | "audio" | "graphics";

/** Drag payload written on dragstart, read by the Timeline lanes. JSON {assetId, kind}. */
export const ASSET_DRAG_MIME = "application/x-toreroflow-asset";

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  /** Clicking a header tab asks the owner to show that drawer instead. */
  onTab?: (t: DrawerTab) => void;
}

export function ClipsDrawer(props: DrawerProps) {
  return <DrawerBase tab="clips" {...props} />;
}
export function AudioDrawer(props: DrawerProps) {
  return <DrawerBase tab="audio" {...props} />;
}
export function GraphicsDrawer(props: DrawerProps) {
  return <DrawerBase tab="graphics" {...props} />;
}

const KIND: Record<DrawerTab, "clip" | "audio" | "graphic"> = {
  clips: "clip",
  audio: "audio",
  graphics: "graphic",
};
const ACCEPT: Record<DrawerTab, string> = {
  clips: "video/*",
  audio: "audio/*",
  graphics: "image/*",
};
const DROP_TEXT: Record<DrawerTab, string> = {
  clips: "Drop video clips or click to browse",
  audio: "Drop audio files or click to browse",
  graphics: "Drop images or click to browse",
};

function fmtDur(sec: number | null): string {
  return sec === null ? "" : `${sec.toFixed(1)}s`;
}

/** Drop every doc reference to a deleted asset so nothing dangles. */
function stripAsset(d: EditDoc, assetId: string, kind: string): EditDoc {
  if (kind === "clip") {
    const cuts = { ...d.cuts };
    const splits = { ...d.splits };
    const wordEdits = { ...d.wordEdits };
    const clipFx = { ...d.clipFx };
    delete cuts[assetId];
    delete splits[assetId];
    delete wordEdits[assetId];
    delete clipFx[assetId];
    return {
      ...d,
      clips: d.clips.filter((c) => c.assetId !== assetId),
      cuts,
      splits,
      wordEdits,
      clipFx,
      broll: d.broll.filter((b) => b.assetId !== assetId),
    };
  }
  if (kind === "audio") return { ...d, audio: d.audio.filter((a) => a.assetId !== assetId) };
  return {
    ...d,
    graphics: d.graphics.filter((g) => g.assetId !== assetId),
    broll: d.broll.filter((b) => b.assetId !== assetId),
  };
}

function DrawerBase({ tab, open, onClose, onTab }: DrawerProps & { tab: DrawerTab }) {
  const { project, assets, refreshAssets, update, outputTime } = useEditor();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const kind = KIND[tab];
  const list = assets.filter((a) => a.kind === kind);
  const counts: Record<DrawerTab, number> = {
    clips: assets.filter((a) => a.kind === "clip").length,
    audio: assets.filter((a) => a.kind === "audio").length,
    graphics: assets.filter((a) => a.kind === "graphic").length,
  };

  const upload = async (files: FileList | File[]) => {
    setBusy(true);
    setErr(null);
    try {
      for (const file of Array.from(files)) {
        const form = new FormData();
        form.append("file", file, file.name);
        await api.postForm<EditAssetInfo>(
          `/edit-projects/${project.id}/assets?kind=${kind}`,
          form,
        );
      }
      await refreshAssets();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "upload failed");
    } finally {
      setBusy(false);
    }
  };

  const addAtPlayhead = (asset: EditAssetInfo) => {
    const at = outputTime;
    update((d) => {
      if (kind === "clip") return { ...d, clips: [...d.clips, { assetId: asset.id }] };
      if (kind === "audio") {
        return {
          ...d,
          audio: [
            ...d.audio,
            {
              id: crypto.randomUUID(),
              assetId: asset.id,
              at,
              dur: asset.durationSec ?? 5,
              volume: 100,
              kind: "music" as const,
            },
          ],
        };
      }
      return {
        ...d,
        graphics: [
          ...d.graphics,
          {
            id: crypto.randomUUID(),
            assetId: asset.id,
            at,
            dur: 4,
            x: 0,
            y: 0,
            scale: 1,
            rotate: 0,
            opacity: 100,
          },
        ],
      };
    });
  };

  const removeAsset = async (asset: EditAssetInfo) => {
    setErr(null);
    try {
      await api.del(`/edit-assets/${asset.id}`);
      update((d) => stripAsset(d, asset.id, asset.kind));
      await refreshAssets();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : "delete failed");
    }
  };

  return (
    <>
      <div className={`pnl-scrim${open ? " open" : ""}`} onClick={onClose} />
      <aside className={`glass pnl-drawer${open ? " open" : ""}`}>
        <div className="pnl-drawtabs">
          {(["clips", "audio", "graphics"] as const).map((t) => (
            <button
              key={t}
              className={`pnl-pill${t === tab ? " on" : ""}`}
              onClick={() => {
                if (t !== tab) onTab?.(t);
              }}
            >
              {t[0].toUpperCase() + t.slice(1)} {counts[t]}
            </button>
          ))}
        </div>

        {tab === "graphics" && (
          <div className="sub" style={{ fontSize: 12, color: "var(--txt-3)" }}>
            Add logos, overlays, screenshots, and visual callouts
          </div>
        )}

        <div
          className="drop"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            if (e.dataTransfer.files.length) void upload(e.dataTransfer.files);
          }}
          onClick={() => fileInput.current?.click()}
        >
          <input
            ref={fileInput}
            type="file"
            accept={ACCEPT[tab]}
            multiple
            style={{ display: "none" }}
            onChange={(e) => {
              if (e.target.files?.length) void upload(e.target.files);
              e.target.value = "";
            }}
          />
          <b>{DROP_TEXT[tab]}</b>
          {busy && <p>Uploading...</p>}
        </div>

        {tab === "audio" && <RecordRow onError={setErr} />}
        {err && <span className="pnl-err">{err}</span>}

        {list.length === 0 && !busy && (
          <div className="empty">
            <b>Nothing here yet</b>
            <p>Uploads land in this list.</p>
          </div>
        )}

        {list.map((a) => (
          <div
            key={a.id}
            className="glass-sm pnl-assetrow"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(
                ASSET_DRAG_MIME,
                JSON.stringify({ assetId: a.id, kind: a.kind }),
              );
              e.dataTransfer.effectAllowed = "copy";
              // The drawer and its scrim sit over the timeline; sliding them
              // away exposes the lanes so the drop can land.
              onClose();
            }}
          >
            <div className="meta">
              <b title={a.originalName}>{a.originalName}</b>
              <span>
                {fmtDur(a.durationSec)}
                {a.status !== "ready" ? ` ${a.status}` : ""}
              </span>
            </div>
            <button className="pnl-chip" onClick={() => addAtPlayhead(a)}>
              + Add at playhead
            </button>
            <button className="pnl-reset" onClick={() => void removeAsset(a)}>
              Delete
            </button>
          </div>
        ))}
      </aside>
    </>
  );
}

/**
 * Record voiceover row. Recording captures audio/webm through MediaRecorder;
 * stopping uploads the take as an audio asset and drops an AudioItem onto
 * the timeline at the playhead.
 */
function RecordRow({ onError }: { onError: (msg: string | null) => void }) {
  const { project, refreshAssets, update, outputTime } = useEditor();
  const [recording, setRecording] = useState(false);
  const rec = useRef<MediaRecorder | null>(null);
  const chunks = useRef<Blob[]>([]);
  const startedAt = useRef(0);

  const start = async () => {
    onError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const r = new MediaRecorder(stream, { mimeType: "audio/webm" });
      chunks.current = [];
      r.ondataavailable = (e) => {
        if (e.data.size) chunks.current.push(e.data);
      };
      r.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const dur = Math.max(0.5, (Date.now() - startedAt.current) / 1000);
        void finish(new Blob(chunks.current, { type: "audio/webm" }), dur);
      };
      startedAt.current = Date.now();
      r.start();
      rec.current = r;
      setRecording(true);
    } catch {
      onError("Microphone access was refused.");
    }
  };

  const finish = async (blob: Blob, dur: number) => {
    const at = outputTime;
    try {
      const form = new FormData();
      form.append("file", blob, "voiceover.webm");
      const asset = await api.postForm<EditAssetInfo>(
        `/edit-projects/${project.id}/assets?kind=audio`,
        form,
      );
      await refreshAssets();
      update((d) => ({
        ...d,
        audio: [
          ...d.audio,
          {
            id: crypto.randomUUID(),
            assetId: asset.id,
            at,
            dur,
            volume: 100,
            kind: "voiceover" as const,
          },
        ],
      }));
    } catch (e: unknown) {
      onError(e instanceof Error ? e.message : "could not save the recording");
    }
  };

  const stop = () => {
    rec.current?.stop();
    rec.current = null;
    setRecording(false);
  };

  return (
    <div className="glass-sm pnl-recrow">
      {recording && <span className="pnl-recdot" />}
      <div className="meta">
        <b>Record voiceover</b>
        <span>Drops onto the timeline at the playhead</span>
      </div>
      <button
        className={recording ? "dangerbtn" : "cbtn"}
        onClick={() => (recording ? stop() : void start())}
      >
        {recording ? "Stop" : "Record"}
      </button>
    </div>
  );
}
