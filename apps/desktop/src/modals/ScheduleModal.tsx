import { useState } from "react";
import Modal from "./Modal";
import GlassDateTime from "../components/GlassDateTime";
import Pf from "../components/Pf";
import { useToast } from "../components/Toasts";
import { api, type MediaAssetInfo } from "../lib/api";
import { PF_ID, SURFACE_LABEL, type Platform } from "../lib/platforms";
import { useAppState } from "../state/AppState";

interface ScheduleModalProps {
  asset: MediaAssetInfo;
  onClose: () => void;
  onScheduled: () => void;
}

/** Local-time value for <input type="datetime-local">, minutes precision. */
function localInputValue(d: Date): string {
  const pad = (n: number) => n.toString().padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function ScheduleModal({ asset, onClose, onScheduled }: ScheduleModalProps) {
  const { selectedClient } = useAppState();
  const toast = useToast();
  const connected = (selectedClient?.accounts ?? []).filter(
    (a) => a.status === "connected",
  );
  const [platforms, setPlatforms] = useState<Platform[]>(
    connected.map((a) => a.platform),
  );
  const [when, setWhen] = useState(() =>
    localInputValue(new Date(Date.now() + 10 * 60_000)),
  );
  const [busy, setBusy] = useState<"schedule" | "now" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmNow, setConfirmNow] = useState(false);

  // Instagram-only options, applied to this scheduling action.
  const [igTrial, setIgTrial] = useState(false);
  const [igGraduate, setIgGraduate] = useState(false);
  const [igCollaborators, setIgCollaborators] = useState(["", "", ""]);
  const [igAudioName, setIgAudioName] = useState("");
  const [igShareToFeed, setIgShareToFeed] = useState(true);
  const [igFirstComment, setIgFirstComment] = useState("");
  const [igAiLabel, setIgAiLabel] = useState(false);

  const igSelected = platforms.includes("instagram");

  /** Only what was actually chosen; untouched controls send nothing. */
  const instagramBody = () => {
    if (!igSelected) return undefined;
    const collaborators = igCollaborators
      .map((c) => c.replace(/^@/, "").trim())
      .filter(Boolean);
    const body: Record<string, unknown> = {};
    if (igTrial) {
      body.trial = true;
      body.graduationStrategy = igGraduate ? "SS_PERFORMANCE" : "MANUAL";
    }
    if (collaborators.length) body.collaborators = collaborators;
    if (igAudioName.trim()) body.audioName = igAudioName.trim();
    if (!igShareToFeed) body.shareToFeed = false;
    if (igFirstComment.trim()) body.firstComment = igFirstComment.trim();
    if (igAiLabel) body.aiLabel = true;
    return Object.keys(body).length ? body : undefined;
  };

  const toggle = (p: Platform) =>
    setPlatforms((prev) =>
      prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p],
    );

  /**
   * Publishing immediately is the same call with the time set to now; the
   * API turns a non-future time into a zero delay on the publish job.
   */
  const submit = async (mode: "schedule" | "now") => {
    setBusy(mode);
    setError(null);
    try {
      await api.post(`/media/${asset.id}/schedule`, {
        platforms,
        scheduledAt: (mode === "now" ? new Date() : new Date(when)).toISOString(),
        instagram: instagramBody(),
      });
      onScheduled();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "scheduling failed");
      // The inline note carries a bare "Failed to fetch" on a dead API, which
      // reads as nothing at all next to an irreversible publish.
      toast.fail(
        mode === "now" ? "Could not publish the post" : "Could not schedule the post",
        err,
      );
      setConfirmNow(false);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal maxWidth={520} onClose={onClose}>
      <div className="modal-head">
        <div>
          <h3>Schedule post</h3>
          <p>{asset.name}</p>
        </div>
        <div className="modal-x" onClick={onClose}>
          <svg>
            <use href="#i-x" />
          </svg>
        </div>
      </div>
      <div className="modal-body">
        <label className="flabel">Platforms</label>
        {connected.length === 0 && (
          <p style={{ fontSize: 12.5, color: "var(--txt-3)" }}>
            No connected platforms. Connect them in Settings first.
          </p>
        )}
        <div className="toggles" style={{ marginTop: 6 }}>
          {connected.map((account) => {
            const on = platforms.includes(account.platform);
            return (
              <div
                key={account.id}
                className={`pt${on ? " on" : ""}`}
                onClick={() => toggle(account.platform)}
              >
                <Pf p={PF_ID[account.platform]} />
                <div className="info">
                  <b>{SURFACE_LABEL[account.platform]}</b>
                  <span>@{account.handle}</span>
                </div>
                <div className="switch" />
              </div>
            );
          })}
        </div>

        {igSelected && (
          <div className="igopts">
            <label className="flabel" style={{ marginTop: 18 }}>
              Instagram options
            </label>
            <div className="igrow">
              <span
                className={`revtoggle${igTrial ? " on" : ""}`}
                title="Show this reel to non-followers first; it will not appear on the profile unless it graduates"
                onClick={() => setIgTrial((v) => !v)}
              >
                Trial reel
              </span>
              {igTrial && (
                <span
                  className={`revtoggle${igGraduate ? " on" : ""}`}
                  title="Share to everyone automatically if the trial performs"
                  onClick={() => setIgGraduate((v) => !v)}
                >
                  Auto-share if it performs
                </span>
              )}
              <span
                className={`revtoggle${igShareToFeed ? " on" : ""}`}
                title="Also show the reel in the main feed"
                onClick={() => setIgShareToFeed((v) => !v)}
              >
                Share to feed
              </span>
              <span
                className={`revtoggle${igAiLabel ? " on" : ""}`}
                title="Label this post as AI-generated content"
                onClick={() => setIgAiLabel((v) => !v)}
              >
                AI label
              </span>
            </div>
            <label className="flabel" style={{ marginTop: 12 }}>
              Collaborators
              <span className="hint">up to 3 public business or creator accounts</span>
            </label>
            <div className="igcollabs">
              {igCollaborators.map((value, i) => (
                <input
                  key={i}
                  className="field-in"
                  placeholder={`@username ${i + 1}`}
                  value={value}
                  onChange={(e) =>
                    setIgCollaborators((prev) =>
                      prev.map((v, j) => (j === i ? e.target.value : v)),
                    )
                  }
                />
              ))}
            </div>
            <label className="flabel" style={{ marginTop: 12 }}>
              Rename audio
              <span className="hint">replaces "Original Audio"</span>
            </label>
            <input
              className="field-in"
              placeholder="e.g. Torerone Original"
              maxLength={120}
              value={igAudioName}
              onChange={(e) => setIgAudioName(e.target.value)}
            />
            <label className="flabel" style={{ marginTop: 12 }}>
              First comment
              <span className="hint">posted automatically right after the reel</span>
            </label>
            <input
              className="field-in"
              placeholder="e.g. the hashtags, or a question for the comments"
              maxLength={2200}
              value={igFirstComment}
              onChange={(e) => setIgFirstComment(e.target.value)}
            />
          </div>
        )}

        <label className="flabel" style={{ marginTop: 18 }}>
          Post at
        </label>
        <GlassDateTime value={when} onChange={setWhen} minDate={new Date()} />
        <p style={{ fontSize: 11.5, color: "var(--txt-3)", marginTop: 8 }}>
          Posts with the title saved on this video. Each platform publishes
          independently with automatic retries.
        </p>

        {error && <div className="autherr">{error}</div>}
      </div>
      <div className="modal-foot">
        <button className="btn ghost" onClick={onClose}>
          Cancel
        </button>
        {/* Publishing is irreversible, so Post now asks once before firing. */}
        <button
          className={`btn ${confirmNow ? "danger" : "ghost"}`}
          disabled={busy !== null || platforms.length === 0}
          onClick={() => {
            if (confirmNow) void submit("now");
            else {
              setConfirmNow(true);
              setTimeout(() => setConfirmNow(false), 4000);
            }
          }}
        >
          {busy === "now" ? "Publishing…" : confirmNow ? "Publish now?" : "Post now"}
        </button>
        <button
          className="btn"
          disabled={busy !== null || platforms.length === 0}
          onClick={() => void submit("schedule")}
        >
          <svg>
            <use href="#i-bolt" />
          </svg>{" "}
          {busy === "schedule" ? "Scheduling…" : "Schedule"}
        </button>
      </div>
    </Modal>
  );
}
