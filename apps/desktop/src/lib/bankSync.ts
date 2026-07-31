import { api, API_URL, type BankConnectionsView } from "./api";

/**
 * Waiting for a bank pull to actually finish.
 *
 * A pull is queued, not done in the request, so the press returns long before
 * there is anything new to show. The old screen guessed with a fixed timer and
 * reloaded once; a first pull walks a year of history in 45 day windows and
 * routinely outlasts the guess, which is why pressing the button looked like
 * it did nothing at all.
 *
 * The API marks a connection "syncing" before it answers, so there is no gap
 * to poll into: if the request succeeded, the row already says a pull is
 * running. This waits for that to stop being true.
 */

const POLL_MS = 1500;
/** Long enough for a first pull of a year, which is nine windows over the wire. */
const TIMEOUT_MS = 3 * 60 * 1000;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Why a pull is still running after the deadline.
 *
 * Almost always one thing, and it is not the bank: the worker is the process
 * that does the pulling, and when it is not running a queued job sits there
 * forever. Saying so beats a timeout that reads as the bank being slow.
 */
async function stalledReason(): Promise<string> {
  try {
    const res = await fetch(`${API_URL}/health`);
    const data = (await res.json()) as { worker?: unknown };
    if (data?.worker === "down") {
      return "The background worker is not running, so nothing is pulling. Start it and press Refresh again.";
    }
  } catch {
    // The reason lookup failing is not the thing to report.
  }
  return "The bank is taking longer than usual. It keeps pulling in the background, so give it a minute and refresh again.";
}

/**
 * Resolves once no connection is mid-pull, with the connections as they now
 * stand. Rejects with a sentence to show if the deadline passes first.
 */
export async function waitForBankSync(): Promise<BankConnectionsView> {
  const deadline = Date.now() + TIMEOUT_MS;
  for (;;) {
    const view = await api.get<BankConnectionsView>("/bank/connections");
    if (!view.connections.some((c) => c.status === "syncing")) return view;
    if (Date.now() >= deadline) throw new Error(await stalledReason());
    await sleep(POLL_MS);
  }
}

/** The first thing a finished pull has to say for itself, if anything. */
export function syncComplaint(view: BankConnectionsView): string | null {
  const bad = view.connections.find((c) => c.error);
  return bad?.error ?? null;
}
