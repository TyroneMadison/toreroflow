import { useState } from "react";
import Modal from "./Modal";
import GlassDateTime from "../components/GlassDateTime";
import Pf from "../components/Pf";
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
      });
      onScheduled();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "scheduling failed");
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
