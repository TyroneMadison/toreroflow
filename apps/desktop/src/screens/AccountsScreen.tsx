import { useState } from "react";
import Pf from "../components/Pf";
import { useToast } from "../components/Toasts";
import { api } from "../lib/api";
import { clientAvatarUrl } from "../lib/avatar";
import { PF_ID } from "../lib/platforms";
import { useAppState } from "../state/AppState";

interface AccountsScreenProps {
  onOpenConnect(): void;
  onOpenInsights(clientId: string): void;
}

/** Compact follower count: 20.1K, 1.4M. */
function fmtCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const AVATAR_GRADIENTS = [
  "linear-gradient(135deg,#8b7bff,#4ea8ff)",
  "linear-gradient(135deg,#a07bff,#6a5bff)",
  "linear-gradient(135deg,#4ea8ff,#6a5bff)",
  "linear-gradient(135deg,#6a5bff,#4ea8ff)",
  "linear-gradient(135deg,#8b7bff,#5e9bff)",
];

export default function AccountsScreen({ onOpenConnect, onOpenInsights }: AccountsScreenProps) {
  const { clients, refreshClients, selectedClientId, selectClient } = useAppState();
  const toast = useToast();
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const totalProfiles = clients.reduce((n, c) => n + c.accounts.length, 0);

  const deleteClient = async (clientId: string) => {
    setDeletingId(clientId);
    try {
      await api.del(`/clients/${clientId}`);
      if (selectedClientId === clientId) selectClient(null);
      await refreshClients();
    } catch (err) {
      // The confirm state resets either way, so a failed delete otherwise looks
      // identical to one that worked.
      const name = clients.find((c) => c.id === clientId)?.name ?? "the brand";
      toast.fail(`Could not delete ${name}`, err);
    } finally {
      setDeletingId(null);
      setConfirmingId(null);
    }
  };

  return (
    <section className="screen active" data-screen="accounts">
      <div className="topbar">
        <div className="h">
          <h2>Accounts</h2>
          <p>
            {clients.length
              ? `${clients.length} ${clients.length === 1 ? "brand" : "brands"}, ${totalProfiles} connected ${totalProfiles === 1 ? "profile" : "profiles"}.`
              : "No brands enrolled yet."}
          </p>
        </div>
        <button className="btn" onClick={onOpenConnect}>
          <svg>
            <use href="#i-plus" />
          </svg>{" "}
          Add client
        </button>
      </div>
      <div className="stage">
        <div className="clients">
          {clients.map((client, i) => {
            const connected = client.accounts.filter((a) => a.status === "connected");
            const needsFix = client.accounts.some((a) => a.status !== "connected");
            const avatar = clientAvatarUrl(client);
            return (
              <div
                className="cc glass"
                key={client.id}
                onClick={() => onOpenInsights(client.id)}
              >
                <div className="top">
                  <div
                    className="avatar lg"
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 13,
                      fontSize: 15,
                      overflow: "hidden",
                      background: avatar
                        ? "var(--glass-2)"
                        : AVATAR_GRADIENTS[i % AVATAR_GRADIENTS.length],
                    }}
                  >
                    {avatar ? (
                      <img
                        src={avatar}
                        alt={client.name}
                        style={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                      />
                    ) : (
                      client.avatarSeed ?? client.name.slice(0, 2).toUpperCase()
                    )}
                  </div>
                  <div className="meta">
                    <b>{client.name}</b>
                    <span>
                      {client.plan ?? "No plan"}, {client.accounts.length}{" "}
                      {client.accounts.length === 1 ? "profile" : "profiles"}
                    </span>
                  </div>
                  <div
                    className="iconbtn"
                    style={{ marginLeft: "auto", width: 32, height: 32 }}
                    title={confirmingId === client.id ? "Click again to delete" : "Delete brand"}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirmingId === client.id) void deleteClient(client.id);
                      else {
                        setConfirmingId(client.id);
                        setTimeout(() => setConfirmingId((c) => (c === client.id ? null : c)), 3000);
                      }
                    }}
                  >
                    {deletingId === client.id ? (
                      <span style={{ fontSize: 10 }}>…</span>
                    ) : confirmingId === client.id ? (
                      <span style={{ fontSize: 10, color: "var(--red)", fontWeight: 700 }}>
                        SURE?
                      </span>
                    ) : (
                      <svg style={{ stroke: "var(--red)" }}>
                        <use href="#i-x" />
                      </svg>
                    )}
                  </div>
                </div>
                <div className="plat">
                  {connected.length ? (
                    connected.map((a) => <Pf key={a.id} p={PF_ID[a.platform]} />)
                  ) : (
                    <span style={{ fontSize: 11.5, color: "var(--txt-3)" }}>
                      No platforms connected - use Settings → Connected Accounts
                    </span>
                  )}
                </div>
                <div className="stat">
                  <div>
                    <div className="big">
                      {client.totalFollowers != null ? fmtCount(client.totalFollowers) : "-"}
                    </div>
                    <div className="lab">
                      {client.totalFollowers != null
                        ? "total followers"
                        : "followers not synced yet"}
                    </div>
                  </div>
                </div>
                <div className={`health ${needsFix ? "warn" : connected.length ? "ok" : "warn"}`}>
                  <span className="d" />{" "}
                  {needsFix
                    ? "Needs reconnect"
                    : connected.length
                      ? "All connected"
                      : "Not connected"}
                </div>
              </div>
            );
          })}
          <div className="add-cc" onClick={onOpenConnect}>
            <div className="plus">
              <svg>
                <use href="#i-plus" />
              </svg>
            </div>
            <div style={{ textAlign: "center" }}>
              <b style={{ fontSize: 14 }}>Add a new client</b>
              <div style={{ fontSize: 11.5, color: "var(--txt-3)", marginTop: 3 }}>
                Connect Instagram, TikTok, YouTube, Snapchat
              </div>
            </div>
          </div>
        </div>
        {clients.length > 0 && (
          <div className="note">Click a brand to open its analytics and AI growth suggestions.</div>
        )}
      </div>
    </section>
  );
}
