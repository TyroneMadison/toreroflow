import { useCallback, useEffect, useState } from "react";
import { formatCents } from "@toreroflow/core";
import { useToast } from "../Toasts";
import { openExternal } from "../../lib/external";
import { api, type BankCashflowView, type BankConnectionsView } from "../../lib/api";
import { syncComplaint, waitForBankSync } from "../../lib/bankSync";

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

const money = (cents: number | null | undefined): string => formatCents(cents ?? null);

export default function BankSection({ reloadKey = 0 }: { reloadKey?: number }) {
  const toast = useToast();
  const [view, setView] = useState<BankConnectionsView | null>(null);
  const [flow, setFlow] = useState<BankCashflowView | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [token, setToken] = useState("");
  /** What the pull is doing, or null when nothing is running. */
  const [pulling, setPulling] = useState<string | null>(null);
  const [unreadable, setUnreadable] = useState(false);

  const load = useCallback(async () => {
    try {
      const [v, f] = await Promise.all([
        api.get<BankConnectionsView>("/bank/connections"),
        api.get<BankCashflowView>("/bank/cashflow?months=6"),
      ]);
      setView(v);
      setFlow(f);
      setUnreadable(false);
    } catch {
      // Additive section: a failure here must not take the rest of Financials
      // down with it. It must not disappear either, which is what happened
      // while this was silent: no card, no Connect button, no reason given.
      setUnreadable(true);
    }
  }, []);

  // reloadKey is the screen's Refresh button: it has already waited for the
  // pull to land, so this only has to re-read.
  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  /**
   * Waits for the queued pull, then re-reads.
   *
   * Both entry points share this because both had the same failure: they fired
   * a job and reloaded on a timer, so a pull that took longer than the timer
   * looked like a button that did nothing.
   */
  const awaitPull = async (working: string) => {
    setPulling(working);
    try {
      const view = await waitForBankSync();
      setView(view);
      const f = await api.get<BankCashflowView>("/bank/cashflow?months=6").catch(() => null);
      if (f) setFlow(f);
      const complaint = syncComplaint(view);
      if (complaint) toast.fail("The bank pull finished with a problem", complaint);
      else toast.success("Bank up to date.");
    } catch (err) {
      toast.fail("The bank pull did not finish", err);
      await load();
    } finally {
      setPulling(null);
    }
  };

  const connect = async () => {
    const setupToken = token.trim();
    if (!setupToken) return;
    setBusy(true);
    try {
      await api.post("/bank/connect", { setupToken });
      setToken("");
      setAdding(false);
      await load();
      await awaitPull("Pulling a year of history…");
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
      await awaitPull("Pulling transactions…");
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

  if (!view) {
    if (!unreadable) return null;
    return (
      <div className="card glass">
        <div className="rowhead">
          <div>
            <h3>Bank</h3>
            <div className="sub">Could not read the bank just now. Nothing has been lost.</div>
          </div>
          <button className="cbtn" onClick={() => void load()}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="card glass">
      <div className="rowhead">
        <div>
          <h3>Bank</h3>
          <div className="sub">
            Read-only. Balances and transactions only, nothing here can move money.
          </div>
        </div>
        <button className="cbtn" disabled={busy} onClick={() => setAdding((a) => !a)}>
          {adding ? "Cancel" : view.connections.length ? "Reconnect" : "Connect a bank"}
        </button>
      </div>

      {adding && (
        <div className="glass-sm" style={{ marginTop: 12, padding: 14, borderRadius: 14 }}>
          <p style={{ fontSize: 12.5, color: "var(--txt-2)", lineHeight: 1.6 }}>
            Connect your bank at SimpleFIN, then paste the setup token it gives you. You log in at
            your bank on their site, never here, and the token can only read. Every bank you add at
            SimpleFIN comes through this one connection, so pasting a new token replaces the key
            rather than adding a second copy of your money.
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
            style={{
              resize: "vertical",
              fontFamily: "monospace",
              fontSize: 12,
            }}
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
            A setup token works once. If it is refused, someone else may have claimed it, so disable
            it at SimpleFIN before generating a new one.
          </p>
        </div>
      )}

      {flow && flow.totals.counted > 0 && (
        <>
          <div className="sub" style={{ marginTop: 14 }}>
            From the bank, last 6 months, posted transactions only. The figures above this card are
            for the month you picked.
          </div>
          <div
            className="kpis stagger"
            style={{ gridTemplateColumns: "repeat(3,1fr)", marginTop: 8 }}
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
        </>
      )}

      {view.connections.map((c) => {
        // `pulling` is this window waiting; the row's status covers a pull
        // started from the Refresh button or before this screen opened.
        const isPulling = pulling !== null || c.status === "syncing";
        return (
          <div key={c.id} style={{ marginTop: 16 }}>
            <div className="rowhead">
              <div>
                <b style={{ fontSize: 13.5 }}>{c.institutionName ?? "Linked bank"}</b>
                <div className="sub">
                  {c.status === "needs_reconnect"
                    ? "Needs connecting again at SimpleFIN"
                    : isPulling
                      ? (pulling ?? "Pulling transactions…")
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
                  <button
                    className="cbtn"
                    disabled={busy || isPulling}
                    onClick={() => void sync(c.id)}
                  >
                    {isPulling ? "Pulling…" : "Pull transactions"}
                  </button>
                )}
                <button className="dangerbtn" onClick={() => void disconnect(c.id)}>
                  Disconnect
                </button>
              </div>
            </div>

            {c.error &&
              (c.status === "error" || c.status === "needs_reconnect" ? (
                <p className="insfailed">{c.error}</p>
              ) : (
                // A note from a pull that worked. SimpleFIN says things like
                // "that date range is wider than we recommend" in the same
                // breath as real trouble, and red is a lie about both.
                <p className="warnline" style={{ marginTop: 8 }}>
                  {c.error}
                </p>
              ))}

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
        );
      })}

      {view.connections.length === 0 && !adding && (
        <p className="insworking" style={{ marginTop: 12 }}>
          Connect your business account and the app can show money in and money out beside the
          figures you enter by hand. Every account starts counted, and you can ignore the ones that
          should not be in the total.
        </p>
      )}
    </div>
  );
}
