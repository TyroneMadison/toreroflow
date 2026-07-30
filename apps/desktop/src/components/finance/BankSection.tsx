import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "../Toasts";
import {
  api,
  type BankCashflowView,
  type BankConnectionsView,
} from "../../lib/api";

/**
 * Read-only oversight of the agency's own bank.
 *
 * The bank login never happens here. Pressing Connect loads the provider's
 * widget, which opens the bank's own page in a popup; this app only ever
 * receives a one-time token to hand back to the API. No banking credential
 * passes through Toreroflow, and nothing on this screen can move money.
 */

const LINK_SRC = "https://cdn.plaid.com/link/v2/stable/link-initialize.js";

interface PlaidHandler {
  open(): void;
  destroy(): void;
}
interface PlaidGlobal {
  create(opts: {
    token: string;
    onSuccess(publicToken: string): void;
    onExit(err: unknown): void;
  }): PlaidHandler;
}

/** Loads the widget script once, on first use rather than at app start. */
function loadLink(): Promise<PlaidGlobal> {
  const existing = (window as unknown as { Plaid?: PlaidGlobal }).Plaid;
  if (existing) return Promise.resolve(existing);
  return new Promise((resolve, reject) => {
    const tag = document.createElement("script");
    tag.src = LINK_SRC;
    tag.onload = () => {
      const g = (window as unknown as { Plaid?: PlaidGlobal }).Plaid;
      if (g) resolve(g);
      else reject(new Error("the bank connector loaded but did not start"));
    };
    tag.onerror = () => reject(new Error("could not reach the bank connector"));
    document.head.appendChild(tag);
  });
}

const money = (cents: number | null | undefined): string =>
  cents == null ? "-" : `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function BankSection() {
  const toast = useToast();
  const [view, setView] = useState<BankConnectionsView | null>(null);
  const [flow, setFlow] = useState<BankCashflowView | null>(null);
  const [busy, setBusy] = useState(false);
  const handler = useRef<PlaidHandler | null>(null);

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
    return () => handler.current?.destroy();
  }, [load]);

  const connect = async () => {
    setBusy(true);
    try {
      const { linkToken } = await api.post<{ linkToken: string }>("/bank/link-token");
      const Plaid = await loadLink();
      handler.current?.destroy();
      handler.current = Plaid.create({
        token: linkToken,
        onSuccess: (publicToken) => {
          void (async () => {
            try {
              await api.post("/bank/exchange", { publicToken });
              await load();
              toast.success("Bank connected. Pull transactions to see the figures.");
            } catch (err) {
              toast.fail("Could not finish connecting the bank", err);
            }
          })();
        },
        onExit: () => undefined,
      });
      handler.current.open();
    } catch (err) {
      toast.fail("Could not start the bank connection", err);
    } finally {
      setBusy(false);
    }
  };

  /**
   * Repairs a link the bank has expired, rather than making a new one.
   *
   * Connecting again from scratch would leave two links to the same bank and
   * double every figure, so this is the only route out of "needs you to log in
   * again". The stored history and the counted/ignored choices survive.
   */
  const reconnect = async (id: string) => {
    setBusy(true);
    try {
      const { linkToken } = await api.post<{ linkToken: string }>(
        `/bank/connections/${id}/relink`,
      );
      const Plaid = await loadLink();
      handler.current?.destroy();
      handler.current = Plaid.create({
        token: linkToken,
        onSuccess: () => {
          // Update mode keeps the existing token working, so there is nothing to
          // exchange. Pulling is what proves the repair took and clears the
          // warning, so it is started here rather than left as another button.
          void (async () => {
            try {
              await api.post(`/bank/connections/${id}/sync`);
              toast.success("Bank reconnected. Pulling transactions.");
              setTimeout(() => void load(), 6000);
            } catch (err) {
              toast.fail("Reconnected, but could not pull transactions", err);
            }
          })();
        },
        onExit: () => undefined,
      });
      handler.current.open();
    } catch (err) {
      toast.fail("Could not start the reconnection", err);
    } finally {
      setBusy(false);
    }
  };

  const sync = async (id: string) => {
    setBusy(true);
    try {
      await api.post(`/bank/connections/${id}/sync`);
      toast.success("Pulling transactions. This section updates when it lands.");
      // The pull runs on the worker, so give it a moment then refresh.
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
            {view.configured
              ? "Read-only. Balances and transactions only, nothing here can move money."
              : view.reason}
          </div>
        </div>
        {view.configured && (
          <button className="cbtn" disabled={busy} onClick={() => void connect()}>
            {view.connections.length ? "Connect another" : "Connect a bank"}
          </button>
        )}
      </div>

      {view.environment !== "production" && view.configured && (
        <p className="insworking" style={{ marginTop: 10 }}>
          Running against the provider's {view.environment} environment, so these are test
          banks rather than your real one.
        </p>
      )}

      {flow && flow.totals.counted > 0 && (
        <div className="kpis stagger" style={{ gridTemplateColumns: "repeat(3,1fr)", marginTop: 14 }}>
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
                  ? "Needs you to log in again"
                  : c.lastSyncedAt
                    ? `Last pulled ${new Date(c.lastSyncedAt).toLocaleString()}`
                    : "Not pulled yet"}
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {/*
                One action, not two. While a bank wants a fresh login, pulling
                can only fail with the same message, so offering it is a trap.
              */}
              {c.status === "needs_reconnect" ? (
                <button className="cbtn" disabled={busy} onClick={() => void reconnect(c.id)}>
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
                <span style={{ color: "var(--txt-3)" }}> · {a.subtype ?? a.type}</span>
              </div>
              <b>{money(a.currentCents)}</b>
            </div>
          ))}
        </div>
      ))}

      {view.configured && view.connections.length === 0 && (
        <p className="insworking" style={{ marginTop: 12 }}>
          Connect your business account and the app can show money in and money out beside the
          figures you enter by hand. You log in at your bank, never here.
        </p>
      )}
    </div>
  );
}
