import { useState } from "react";
import Modal from "./Modal";
import Pf from "../components/Pf";
import { api } from "../lib/api";
import { PF_ID, PLATFORMS, PLATFORM_LABELS, SURFACE_LABEL, type Platform } from "../lib/platforms";
import { useAppState } from "../state/AppState";

interface ConnectClientModalProps {
  onClose: () => void;
}

/**
 * Enroll a brand, then connect its platforms. Connections use the dry-run
 * provider until a real publishing provider is configured (M1 decision).
 */
export default function ConnectClientModal({ onClose }: ConnectClientModalProps) {
  const { refreshClients, clients, selectClient } = useAppState();
  const [name, setName] = useState("");
  const [clientId, setClientId] = useState<string | null>(null);
  const [connected, setConnected] = useState<Set<Platform>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const createClient = async () => {
    if (!name.trim()) return;
    setBusy("create");
    setError(null);
    try {
      const client = await api.post<{ id: string }>("/clients", { name: name.trim() });
      setClientId(client.id);
      await refreshClients();
      // First brand auto-selects so the rest of the app comes alive.
      if (clients.length === 0) selectClient(client.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not create client");
    } finally {
      setBusy(null);
    }
  };

  const connect = async (platform: Platform) => {
    if (!clientId) return;
    setBusy(platform);
    setError(null);
    try {
      await api.post(`/clients/${clientId}/accounts/${platform}`, {});
      setConnected((prev) => new Set(prev).add(platform));
      await refreshClients();
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not connect");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal maxWidth={440} onClose={onClose}>
      <div className="modal-head">
        <div>
          <h3>Add a client</h3>
          <p>Name the brand, then connect their platforms.</p>
        </div>
        <div className="modal-x" onClick={onClose}>
          <svg>
            <use href="#i-x" />
          </svg>
        </div>
      </div>
      <div className="modal-body">
        <label className="flabel">Client name</label>
        <div style={{ display: "flex", gap: 10 }}>
          <input
            className="field-in"
            placeholder="e.g. Bella Napoli"
            value={name}
            disabled={clientId !== null}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !clientId) void createClient();
            }}
          />
          {!clientId && (
            <button
              className="cbtn"
              style={{ flex: "0 0 auto" }}
              disabled={busy === "create" || !name.trim()}
              onClick={() => void createClient()}
            >
              {busy === "create" ? "…" : "Enroll"}
            </button>
          )}
        </div>

        <label className="flabel" style={{ marginTop: 18 }}>
          Connect platforms
        </label>
        {!clientId && (
          <p style={{ fontSize: 12, color: "var(--txt-3)", margin: "4px 0 6px" }}>
            Enroll the client first, then connect each platform.
          </p>
        )}
        {PLATFORMS.map((platform) => {
          const isConnected = connected.has(platform);
          return (
            <div className="connect-row" key={platform} style={clientId ? undefined : { opacity: 0.5 }}>
              <Pf p={PF_ID[platform]} />
              <div className="cinfo">
                <b>{PLATFORM_LABELS[platform]}</b>
                <span>{SURFACE_LABEL[platform]}</span>
              </div>
              {isConnected ? (
                <button className="cbtn done">
                  <svg>
                    <use href="#i-check" />
                  </svg>{" "}
                  Connected
                </button>
              ) : (
                <button
                  className="cbtn"
                  disabled={!clientId || busy === platform}
                  onClick={() => void connect(platform)}
                >
                  {busy === platform ? "…" : "Connect"}
                </button>
              )}
            </div>
          );
        })}

        {error && <div className="autherr">{error}</div>}
      </div>
      <div className="modal-foot">
        <button className="btn" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}
