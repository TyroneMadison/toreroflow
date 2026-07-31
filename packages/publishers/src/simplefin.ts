/**
 * The bank data provider, read-only.
 *
 * SimpleFIN has one endpoint. `GET {accessUrl}/accounts` returns every account
 * the operator connected, each with its balance and its transactions. There is
 * no write operation in the protocol at all, which makes "this cannot move
 * money" a property of the API rather than a promise this file is keeping.
 *
 * The operator connects their bank on SimpleFIN's own site and pastes a
 * one-time setup token in. That token is claimed once for an access URL with
 * credentials embedded in it, and the access URL is the only secret we hold.
 * Nothing here ever sees a banking login, and there is no app-level API key to
 * configure: the connection carries its own credential.
 */

export class BankError extends Error {
  constructor(
    message: string,
    /** True when the operator has to reconnect at SimpleFIN. */
    readonly needsReconnect = false,
  ) {
    super(message);
  }
}

export interface BankAccountRow {
  id: string;
  name: string;
  /** The bank's name, from the account's `org`. */
  orgName: string | null;
  currency: string;
  /** Dollars as the provider sent them, unparsed elsewhere. */
  balance: number | null;
  availableBalance: number | null;
  transactions: BankTransactionRow[];
}

export interface BankTransactionRow {
  id: string;
  /** Seconds since epoch. 0 while a transaction is pending. */
  posted: number;
  /**
   * Dollars, signed the intuitive way: positive is money arriving.
   *
   * Worth stating because the previous provider was the opposite. See
   * packages/core/src/banking.ts.
   */
  amount: number;
  description: string;
  pending: boolean;
}

export interface AccountsResult {
  accounts: BankAccountRow[];
  /** Per-account or per-connection problems the provider reported. */
  errors: string[];
}

/**
 * The access URL split into a request that fetch will actually accept.
 *
 * SimpleFIN hands back an address with the credentials embedded
 * (`https://user:pass@host/simplefin`), and `fetch` refuses any URL that
 * carries them: "Request cannot be constructed from a URL that includes
 * credentials". So they are moved into an Authorization header and the URL is
 * rebuilt without them.
 *
 * Exported and pure so the check can prove the credentials never survive into
 * the URL. They must not: a URL ends up in error messages, logs and query
 * strings, and this one is a live key to a bank feed.
 */
export function accountsRequest(
  accessUrl: string,
  startDate: Date,
  endDate: Date,
): { url: string; headers: Record<string, string> } {
  const parsed = new URL(`${accessUrl.replace(/\/+$/, "")}/accounts`);
  const user = decodeURIComponent(parsed.username);
  const pass = decodeURIComponent(parsed.password);
  parsed.username = "";
  parsed.password = "";
  parsed.searchParams.set("start-date", String(Math.floor(startDate.getTime() / 1000)));
  parsed.searchParams.set("end-date", String(Math.floor(endDate.getTime() / 1000)));
  parsed.searchParams.set("pending", "1");

  const headers: Record<string, string> = { Accept: "application/json" };
  if (user || pass) {
    headers.Authorization = `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  }
  return { url: parsed.toString(), headers };
}

/**
 * Anything that looks like a credential, taken out of text bound for a screen.
 *
 * An access URL reaching an error message is how a bank credential ends up
 * rendered in the app and stored in a database column, which is exactly what
 * happened the first time this ran.
 */
export function redactCredentials(text: string): string {
  return text.replace(/(https?:\/\/)[^/\s@]*@/gi, "$1<redacted>@");
}

/** A numeric string like "-33.24" to a number, or null if it is not one. */
function money(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/**
 * Claim a setup token for an access URL.
 *
 * The token is base64 of a claim URL and is single use: posting to it a second
 * time fails, so the result must be stored on the first attempt or the operator
 * has to generate a new token. That is why the caller writes the row before it
 * does anything else with it.
 */
export async function claimSetupToken(setupToken: string): Promise<string> {
  const trimmed = setupToken.trim();
  if (!trimmed) throw new BankError("Paste the setup token from SimpleFIN first.");

  let claimUrl: string;
  try {
    claimUrl = Buffer.from(trimmed, "base64").toString("utf8").trim();
  } catch {
    throw new BankError("That does not look like a SimpleFIN setup token.");
  }
  if (!/^https:\/\//i.test(claimUrl)) {
    throw new BankError(
      "That token did not contain a SimpleFIN address. Copy the whole token, it is one long line with no spaces.",
    );
  }

  let res: Response;
  try {
    res = await fetch(claimUrl, { method: "POST", signal: AbortSignal.timeout(60_000) });
  } catch {
    // A token clipped by a partial copy can still decode to something that
    // looks like an address, so this is reachable by an ordinary mistake and
    // deserves a sentence rather than "fetch failed".
    throw new BankError(
      "Could not reach the address in that token. Copy the whole token again, it is one long line with no spaces or line breaks.",
    );
  }
  const body = (await res.text()).trim();
  if (!res.ok) {
    // A token that was already used is the common case and is worth saying
    // plainly: the fix is a new token, not a retry.
    if (res.status === 403 || res.status === 409) {
      throw new BankError(
        "That setup token has already been used. Generate a new one at SimpleFIN and paste it again.",
      );
    }
    throw new BankError(`SimpleFIN refused the setup token (${res.status}).`);
  }
  if (!/^https:\/\//i.test(body)) {
    throw new BankError("SimpleFIN did not return an access address for that token.");
  }
  return body;
}

/**
 * Every account and its transactions in a date range.
 *
 * The range is required rather than optional: without one the provider decides
 * how far back to go, and a sync that silently covers a different span each
 * time makes a month total impossible to reason about. Ranges are capped at 90
 * days by the protocol, so the caller windows anything longer.
 */
export async function fetchAccounts(
  accessUrl: string,
  startDate: Date,
  endDate: Date,
): Promise<AccountsResult> {
  const { url, headers } = accountsRequest(accessUrl, startDate, endDate);

  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(120_000) });
  } catch (err) {
    // Redacted, because a failure here can quote the address it was given and
    // that address is a credential.
    throw new BankError(
      redactCredentials(`Could not reach the bank feed. ${err instanceof Error ? err.message : ""}`.trim()),
    );
  }
  const text = await res.text();

  if (res.status === 401 || res.status === 403) {
    throw new BankError(
      "SimpleFIN would not accept this connection any more. Reconnect the bank to keep the figures up to date.",
      true,
    );
  }
  if (!res.ok) {
    throw new BankError(redactCredentials(`The bank feed answered ${res.status}. ${text.slice(0, 200)}`.trim()));
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new BankError("The bank feed returned something that was not JSON.");
  }

  // The protocol calls this errlist; some servers send errors. Read both
  // rather than lose the one thing that says why an account came back empty.
  const rawErrors = [
    ...(Array.isArray(data.errlist) ? data.errlist : []),
    ...(Array.isArray(data.errors) ? data.errors : []),
  ];
  const errors = rawErrors
    .map((e) => (typeof e === "string" ? e : str((e as Record<string, unknown>)?.msg)))
    .filter((e): e is string => Boolean(e));

  const accounts: BankAccountRow[] = (Array.isArray(data.accounts) ? data.accounts : [])
    .filter((a): a is Record<string, unknown> => typeof a === "object" && a !== null)
    .map((a) => {
      const org = (a.org ?? {}) as Record<string, unknown>;
      const txns = Array.isArray(a.transactions) ? a.transactions : [];
      return {
        id: String(a.id ?? ""),
        name: str(a.name) ?? "Account",
        orgName: str(org.name) ?? str(org.domain),
        currency: str(a.currency) ?? "USD",
        balance: money(a.balance),
        availableBalance: money(a["available-balance"]),
        transactions: txns
          .filter((t): t is Record<string, unknown> => typeof t === "object" && t !== null)
          .map((t) => {
            const amount = money(t.amount);
            return {
              id: String(t.id ?? ""),
              posted: Number(t.posted) || Number(t.transacted_at) || 0,
              amount: amount ?? 0,
              description: str(t.description) ?? str(t.payee) ?? "",
              pending: t.pending === true || Number(t.posted) === 0,
            };
          })
          // A row with no id cannot be stored without duplicating on the next
          // sync, and one with no amount is not a transaction.
          .filter((t) => t.id && money(t.amount) !== null),
      };
    })
    .filter((a) => a.id);

  return { accounts, errors };
}
