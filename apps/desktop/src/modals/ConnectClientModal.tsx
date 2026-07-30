import { useCallback, useEffect, useRef, useState } from "react";
import Modal from "./Modal";
import Pf from "../components/Pf";
import { api } from "../lib/api";
import { openExternal } from "../lib/external";
import { PF_ID, PLATFORMS, PLATFORM_LABELS, SURFACE_LABEL, type Platform } from "../lib/platforms";
import { useAppState } from "../state/AppState";

interface ConnectClientModalProps {
  onClose: () => void;
}

/**
 * Enroll a brand, then connect its platforms. Connections use the dry-run
 * provider until a real publishing provider is configured.
 */
export default function ConnectClientModal({ onClose }: ConnectClientModalProps) {
  const { refreshClients, clients, selectClient } = useAppState();
  const [name, setName] = useState("");
  const [clientId, setClientId] = useState<string | null>(null);
  const [connected, setConnected] = useState<Set<Platform>>(new Set());
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [awaitingAuth, setAwaitingAuth] = useState(false);
  const [welcomeUrl, setWelcomeUrl] = useState<string | null>(null);

  // The focus listener and the manual button can both fire a sync; two
  // interleaved syncs can duplicate account rows server-side, so only one
  // runs at a time. A ref, not state: the callback would close over stale
  // state.
  const syncInFlight = useRef(false);

  // Keep the connected set in step with the server after every refresh/sync.
  useEffect(() => {
    if (!clientId) return;
    const current = clients.find((c) => c.id === clientId);
    if (current) {
      setConnected(
        new Set(
          current.accounts
            .filter((a) => a.status === "connected")
            .map((a) => a.platform),
        ),
      );
    }
  }, [clients, clientId]);

  /**
   * The link this client fills in themselves.
   *
   * Minted once and kept: it may already be sitting in their messages, and a
   * fresh one would break the link they were told to use. Only the link is
   * shown, because sending the link is the whole job here.
   */
  const getWelcomeLink = async () => {
    if (!clientId) return;
    setBusy("welcome");
    setError(null);
    try {
      const link = await api.post<{ url: string }>(`/clients/${clientId}/welcome-link`);
      setWelcomeUrl(link.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not make a welcome link");
    } finally {
      setBusy(null);
    }
  };

  const checkReplies = async () => {
    setBusy("replies");
    setError(null);
    try {
      const result = await api.post<{
        checked: number;
        applied: Array<{ client: string }>;
      }>("/onboarding/check");
      await refreshClients();
      setError(
        result.applied.length
          ? null
          : result.checked === 0
            ? "No replies yet."
            : "Replies found, but nothing new to fill in.",
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not check for replies");
    } finally {
      setBusy(null);
    }
  };

  const createClient = async () => {
    if (!name.trim()) return;
    setBusy("create");
    setError(null);
    try {
      const client = await api.post<{ id: string }>("/clients", { name: name.trim() });
      setClientId(client.id);
      await refreshClients();
      // A new brand becomes the active brand so the Create section lands on
      // its clean slate rather than staying on the previous brand.
      selectClient(client.id);
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
      const res = await api.post<{ authUrl?: string }>(
        `/clients/${clientId}/accounts/${platform}`,
        {},
      );
      if (res.authUrl) {
        await openExternal(res.authUrl);
        setAwaitingAuth(true);
      } else {
        setConnected((prev) => new Set(prev).add(platform));
        await refreshClients();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "could not connect");
    } finally {
      setBusy(null);
    }
  };

  const syncAccounts = useCallback(async () => {
    if (!clientId || syncInFlight.current) return;
    syncInFlight.current = true;
    setBusy("sync");
    setError(null);
    try {
      await api.post(`/clients/${clientId}/accounts/sync`, {});
      await refreshClients();
      setAwaitingAuth(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "sync failed");
    } finally {
      syncInFlight.current = false;
      setBusy(null);
    }
  }, [clientId, refreshClients]);

  // Finishing a platform login happens in the external browser; coming back
  // to this window is the natural moment the accounts are ready, so sync
  // then instead of waiting for a manual click. The button stays as a
  // backstop for a login completed without the window ever losing focus.
  useEffect(() => {
    if (!awaitingAuth) return;
    const onFocus = () => void syncAccounts();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [awaitingAuth, syncAccounts]);

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
          Welcome link
        </label>
        <p style={{ fontSize: 12, color: "var(--txt-3)", margin: "4px 0 8px" }}>
          Send this to the client so they can fill in their details and connect their own
          accounts from their phone, and it lands here.
        </p>
        {welcomeUrl ? (
          <div className="connect-row">
            <div className="cinfo" style={{ minWidth: 0 }}>
              <b style={{ wordBreak: "break-all", fontWeight: 500 }}>{welcomeUrl}</b>
            </div>
            <button
              className="cbtn"
              onClick={() => {
                void navigator.clipboard.writeText(welcomeUrl);
              }}
            >
              Copy
            </button>
          </div>
        ) : (
          <div className="connect-row" style={clientId ? undefined : { opacity: 0.5 }}>
            <div className="cinfo">
              <b>Their welcome link</b>
              <span>{clientId ? "One link, theirs for good" : "Enroll the client first"}</span>
            </div>
            <button
              className="cbtn"
              disabled={!clientId || busy === "welcome"}
              onClick={() => void getWelcomeLink()}
            >
              {busy === "welcome" ? "…" : "Get the link"}
            </button>
          </div>
        )}

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
        {/* The other half of the welcome link: replies are pulled when asked,
            because nothing can push to an API running on this machine. */}
        <button
          className="btn ghost"
          disabled={busy === "replies"}
          onClick={() => void checkReplies()}
        >
          {busy === "replies" ? "Checking…" : "Check for replies"}
        </button>
        {awaitingAuth && (
          <button
            className="btn ghost"
            disabled={busy === "sync"}
            onClick={() => void syncAccounts()}
          >
            {busy === "sync" ? "Syncing…" : "Sync connected"}
          </button>
        )}
        <button className="btn" onClick={onClose}>
          Done
        </button>
      </div>
    </Modal>
  );
}
