import { useCallback, useEffect, useState } from "react";
import { useToast } from "../Toasts";
import { openExternal } from "../../lib/external";
import { api, type BankCashflowView, type BankConnectionsView } from "../../lib/api";

/**
 * Read-only oversight of the agency's own bank.
 *
 * The bank login never happens here, and it never happens in this app at all.
 * The operator connects their bank on SimpleFIN's own site and pastes back a
 * one-time setup token. Nothing on this screen can move money, and with this
 * provider that is a property of the protocol rather than a rule this file
 * keeps: it has one endpoint and it is a GET.
 */

const SIMPLEFIN_URL = "https://bridge.simplefin.org/";

const money = (cents: number | null | undefined): string =>
  cents == null
    ? "-"
    : `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function BankSection() {
  const toast = useToast();
  const [view, setView] = useState<BankConnectionsView | null>(null);
  const [flow, setFlow] = useState<BankCashflowView | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [token, setToken] = useState("");

  const load = useCallback(async () => {
    try {
      const [v, f] = await Promise.all([
        api.get<BankConnectionsView>("/bank/connections"),
        api.get<BankCashflowView>("/bank/cashflow?months=6"),
      ]);
      setView(v);
      setFlow(f);
    } catch {
      // Additive section: a failure here must not take the rest of Financials
      // down with it.
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connect = async () => {
    const setupToken = token.trim();
    if (!setupToken) return;
    setBusy(true);
    try {
      await api.post("/bank/connect", { setupToken });
      setToken("");
      setAdding(false);
      await load();
      toast.success("Bank connected. Pulling your history now, this updates when it lands.");
      // The first pull walks a year in 90 day windows, so give it a moment.
      setTimeout(() => void load(), 8000);
    } catch (err) {
      toast.fail("Could not connect the bank", err);
    } finally {
      setBusy(false);
    }
  };

  const sync = async (id: string) => {
    setBusy(true);
    try {
      await api.post(`/bank/connections/${id}/sync`);
      toast.success("Pulling transactions. This section updates when it lands.");
      setTimeout(() => void load(), 6000);
    } catch (err) {
      toast.fail("Could not pull transactions", err);
    } finally {
      setBusy(false);
    }
  };

  const toggleAccount = async (id: string, next: boolean) => {
    try {
      await api.patch(`/bank/accounts/${id}`, { includeInCashFlow: next });
      await load();
    } catch (err) {
      toast.fail("Could not change that account", err);
    }
  };

  const disconnect = async (id: string) => {
    try {
      await api.del(`/bank/connections/${id}`);
      await load();
      toast.success("Bank disconnected and its transactions removed.");
    } catch (err) {
      toast.fail("Could not disconnect the bank", err);
    }
  };

  if (!view) return null;

  return (
    <div className="card glass" style={{ marginTop: 16 }}>
      <div className="rowhead">
        <div>
          <h3>Bank</h3>
          <div className="sub">
            Read-only. Balances and transactions only, nothing here can move money.
          </div>
        </div>
        <button className="cbtn" disabled={busy} onClick={() => setAdding((a) => !a)}>
          {adding ? "Cancel" : view.connections.length ? "Connect another" : "Connect a bank"}
        </button>
      </div>

      {adding && (
        <div className="glass-sm" style={{ marginTop: 12, padding: 14, borderRadius: 14 }}>
          <p style={{ fontSize: 12.5, color: "var(--txt-2)", lineHeight: 1.6 }}>
            Connect your bank at SimpleFIN, then paste the setup token it gives you. You log in
            at your bank on their site, never here, and the token can only read.
          </p>
          <button
            className="cbtn"
            style={{ marginTop: 8 }}
            onClick={() => void openExternal(SIMPLEFIN_URL)}
          >
            Open SimpleFIN
          </button>
          <label className="flabel" style={{ marginTop: 14 }}>
            Setup token
          </label>
          <textarea
            className="field-in"
            rows={3}
            placeholder="Paste the long token from SimpleFIN here"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            style={{ resize: "vertical", fontFamily: "monospace", fontSize: 12 }}
          />
          <button
            className="cbtn"
            style={{ marginTop: 10 }}
            disabled={busy || !token.trim()}
            onClick={() => void connect()}
          >
            {busy ? "Connecting…" : "Connect"}
          </button>
          <p style={{ fontSize: 11.5, color: "var(--txt-3)", marginTop: 8 }}>
            A setup token works once. If it fails, generate a new one.
          </p>
        </div>
      )}

      {flow && flow.totals.counted > 0 && (
        <div
          className="kpis stagger"
          style={{ gridTemplateColumns: "repeat(3,1fr)", marginTop: 14 }}
        >
          <div className="kpi glass-sm">
            <div className="lab">Money in</div>
            <div className="val">{money(flow.totals.inCents)}</div>
          </div>
          <div className="kpi glass-sm">
            <div className="lab">Money out</div>
            <div className="val">{money(flow.totals.outCents)}</div>
          </div>
          <div className="kpi glass-sm">
            <div className="lab">Net</div>
            <div className="val">{money(flow.totals.netCents)}</div>
          </div>
        </div>
      )}

      {view.connections.map((c) => (
        <div key={c.id} style={{ marginTop: 16 }}>
          <div className="rowhead">
            <div>
              <b style={{ fontSize: 13.5 }}>{c.institutionName ?? "Linked bank"}</b>
              <div className="sub">
                {c.status === "needs_reconnect"
                  ? "Needs connecting again at SimpleFIN"
                  : c.lastSyncedAt
                    ? `Last pulled ${new Date(c.lastSyncedAt).toLocaleString()}`
                    : "Not pulled yet"}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {/*
                One action, not two. While a connection needs remaking, pulling
                can only fail with the same message, so offering it is a trap.
              */}
              {c.status === "needs_reconnect" ? (
                <button className="cbtn" disabled={busy} onClick={() => setAdding(true)}>
                  Reconnect
                </button>
              ) : (
                <button className="cbtn" disabled={busy} onClick={() => void sync(c.id)}>
                  Pull transactions
                </button>
              )}
              <button className="dangerbtn" onClick={() => void disconnect(c.id)}>
                Disconnect
              </button>
            </div>
          </div>

          {c.error && <p className="insfailed">{c.error}</p>}

          {c.accounts.map((a) => (
            <div className="best" key={a.id}>
              <div className="l">
                <span
                  className={`revtoggle${a.includeInCashFlow ? " on" : ""}`}
                  title="Count this account towards money in and money out"
                  onClick={() => void toggleAccount(a.id, !a.includeInCashFlow)}
                >
                  {a.includeInCashFlow ? "Counted" : "Ignored"}
                </span>{" "}
                {a.name}
                {a.mask && <span style={{ color: "var(--txt-3)" }}> ····{a.mask}</span>}
              </div>
              <b>{money(a.currentCents)}</b>
            </div>
          ))}
        </div>
      ))}

      {view.connections.length === 0 && !adding && (
        <p className="insworking" style={{ marginTop: 12 }}>
          Connect your business account and the app can show money in and money out beside the
          figures you enter by hand. Every account starts counted, and you can ignore the ones
          that should not be in the total.
        </p>
      )}
    </div>
  );
}
