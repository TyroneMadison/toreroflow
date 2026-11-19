import { useCallback, useEffect, useMemo, useState } from "react";
import Stat from "../components/glass/Stat";
import { Empty, ErrorState, Loading } from "../components/states";
import SignatureBuilder from "../components/signatures/SignatureBuilder";
import { RequestDetail } from "../components/signatures/SignatureCard";
import { useRequestActions } from "../components/signatures/useRequestActions";
import { useAppState } from "../state/AppState";
import { useToast } from "../components/Toasts";
import { api, type SignatureRequest } from "../lib/api";
import { daysLeft, progress, signedCount, statusLine, TONE, waitingOn } from "../lib/signatures";
import "../components/signatures/signatures.css";

/**
 * Every contract, on its own screen.
 *
 * The Overview card shows the six most recent for one glance. This is the page
 * that owns the feature: all of them, filterable, and reachable without
 * picking a brand first. That last part is the point rather than a convenience:
 * clientId is nullable on a signature request precisely so a contract can go
 * to someone who is not a client yet, and those are invisible from any
 * client's Overview.
 */

const FILTERS = [
  { id: "all", label: "All" },
  { id: "sent", label: "Out for signature" },
  { id: "completed", label: "Signed" },
  { id: "draft", label: "Drafts" },
  { id: "declined", label: "Declined" },
  { id: "voided", label: "Cancelled" },
] as const;
type FilterId = (typeof FILTERS)[number]["id"];

/** Everyone signed and no signed copy: completion threw after the last signature. */
const isStuck = (r: SignatureRequest) =>
  r.signers.length > 0 && r.signers.every((s) => s.status === "signed") && !r.signedUrl;

export default function ContractsScreen() {
  const { clients } = useAppState();
  const toast = useToast();
  const [all, setAll] = useState<SignatureRequest[] | null>(null);
  const [error, setError] = useState("");
  const [building, setBuilding] = useState(false);
  const [filter, setFilter] = useState<FilterId>("all");

  const load = useCallback(async () => {
    try {
      setError("");
      // The whole list, unfiltered. Filtering happens below, in memory: the
      // status query parameter exists but refetching to hide five rows would
      // make every chip a round trip.
      const { requests } = await api.get<{ requests: SignatureRequest[] }>("/signature-requests");
      setAll(requests);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // After the first load the list stays up, so a failed refresh has to say so.
      toast.fail("Could not refresh the contracts", err);
    }
  }, [toast]);

  useEffect(() => {
    void load();
  }, [load]);

  const { open, setOpen, openRequest, act, voidRequest } = useRequestActions(load);

  /*
   * Counted from the list in hand rather than from /signature-requests/summary.
   * Two sources for the same four numbers is two numbers that can disagree on
   * screen, and the list is already loaded. "Expiring soon" matches the
   * server's rule exactly: strictly inside three days.
   */
  const counts = useMemo(() => {
    const rows = all ?? [];
    return {
      sent: rows.filter((r) => r.status === "sent").length,
      completed: rows.filter((r) => r.status === "completed").length,
      drafts: rows.filter((r) => r.status === "draft").length,
      expiringSoon: rows.filter((r) => r.status === "sent" && daysLeft(r.expiresAt) < 3).length,
      stuck: rows.filter(isStuck).length,
    };
  }, [all]);

  const rows = useMemo(
    () => (all ?? []).filter((r) => filter === "all" || r.status === filter),
    [all, filter],
  );

  const nameOf = (clientId: string | null) =>
    clientId ? (clients.find((c) => c.id === clientId)?.name ?? null) : null;

  const state = error && !all ? "error" : all ? "ready" : "loading";

  return (
    <section className="screen active" data-screen="contracts" data-state={state}>
      <div className="topbar">
        <div className="h">
          <h2>Contracts</h2>
          <p>
            Send a document for signature, watch who has signed, and keep the signed copy with its
            certificate. Signing happens in the signer&apos;s browser, and they need no account.
          </p>
        </div>
        {state === "ready" && (
          <button type="button" className="btn" onClick={() => setBuilding(true)} data-testid="contracts.new">
            Send a contract
          </button>
        )}
      </div>

      <div className="stage sg-stage">
        {state === "error" && <ErrorState screen="contracts" message={error} onRetry={() => void load()} />}
        {state === "loading" && <Loading screen="contracts" label="Loading contracts" />}

        {state === "ready" && (
          <>
            <div className="sg-card-stats four" data-testid="contracts.stats">
              <Stat label="Out for signature" value={counts.sent} tone={counts.sent ? "info" : undefined} />
              <Stat label="Signed" value={counts.completed} tone={counts.completed ? "ok" : undefined} />
              <Stat label="Drafts" value={counts.drafts} />
              <Stat
                label="Expiring soon"
                value={counts.expiringSoon}
                sub="within 3 days"
                tone={counts.expiringSoon ? "bad" : undefined}
              />
            </div>

            {counts.stuck > 0 && (
              <p className="sg-note sg-stuck" data-testid="contracts.stuck">
                {counts.stuck === 1
                  ? "One contract is signed by everyone but has no signed copy. Open it and press Finish it."
                  : `${counts.stuck} contracts are signed by everyone but have no signed copy. Open each one and press Finish it.`}
              </p>
            )}

            <div className="sg-tools" data-testid="contracts.filters">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  type="button"
                  className={`sg-tool${filter === f.id ? " on" : ""}`}
                  onClick={() => setFilter(f.id)}
                  data-testid={`contracts.filter-${f.id}`}
                >
                  {f.label}
                  {f.id !== "all" && ` ${(all ?? []).filter((r) => r.status === f.id).length}`}
                </button>
              ))}
            </div>

            {!rows.length ? (
              <Empty
                screen="contracts"
                title={filter === "all" ? "No contracts yet" : "Nothing with that status"}
                hint={
                  filter === "all"
                    ? "Upload a PDF, drop the signature boxes where they go, say who signs it, and it goes out by email with a link of their own."
                    : "Try another filter."
                }
                action={
                  filter === "all" ? (
                    <button type="button" className="tf-btn glass-z1" onClick={() => setBuilding(true)}>
                      Send a contract
                    </button>
                  ) : undefined
                }
              />
            ) : (
              <ul className="sg-list" data-testid="contracts.list">
                {rows.map((r) => {
                  const waiting = waitingOn(r.signers);
                  return (
                    <li key={r.id}>
                      <button
                        type="button"
                        className="sg-item"
                        onClick={() => void openRequest(r.id)}
                        data-testid={`contracts.item-${r.id}`}
                      >
                        <span className="sg-item-txt">
                          <b>{r.title}</b>
                          <small>
                            {progress(signedCount(r.signers), r.signers.length)}
                            {nameOf(r.clientId) ? ` · ${nameOf(r.clientId)}` : ""}
                            {" · "}
                            {statusLine(r)}
                          </small>
                        </span>
                        {isStuck(r) && <span className="sg-badge warn phrase">needs finishing</span>}
                        {!isStuck(r) && r.status === "sent" && waiting.length > 0 && (
                          <span className="sg-badge info phrase">
                            waiting on {waiting.length === 1 ? (waiting[0]!.name || waiting[0]!.email) : `${waiting.length} people`}
                          </span>
                        )}
                        <span className={`sg-badge ${TONE[r.status] ?? ""}`}>{r.status}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </>
        )}

        {building && (
          <SignatureBuilder
            onClose={() => setBuilding(false)}
            onSent={(r) => {
              void load();
              // Straight into the detail view: a contract that just went out is
              // the one whose links the owner may need to copy by hand.
              setOpen(r);
              setBuilding(false);
            }}
          />
        )}

        {open && (
          <RequestDetail
            r={open}
            onClose={() => setOpen(null)}
            onVoid={() => void voidRequest(open.id)}
            onAction={(path, ok, fail) => void act(path, ok, fail)}
          />
        )}
      </div>
    </section>
  );
}
