/**
 * The bank data provider, read-only.
 *
 * Deliberately hand-rolled over `fetch` rather than pulling in Plaid's SDK:
 * five endpoints are needed and the SDK brings a large dependency tree into a
 * service that already talks to four other APIs this way.
 *
 * Only read endpoints are wrapped. There is no transfer, payment or auth-debit
 * call in this file and there should never be one: the Financials module's
 * standing rule is that nothing in it can move money, and a bank link is
 * exactly where that rule matters most.
 */

const HOSTS: Record<string, string> = {
  sandbox: "https://sandbox.plaid.com",
  production: "https://production.plaid.com",
};

export class PlaidError extends Error {
  constructor(
    message: string,
    /** Plaid's own code, e.g. ITEM_LOGIN_REQUIRED, which callers branch on. */
    readonly code: string | null = null,
  ) {
    super(message);
  }
}

/** True when the bank wants the operator to log in again. */
export function needsReconnect(code: string | null): boolean {
  return code === "ITEM_LOGIN_REQUIRED" || code === "PENDING_EXPIRATION";
}

export interface PlaidAccount {
  account_id: string;
  name: string;
  official_name: string | null;
  mask: string | null;
  type: string | null;
  subtype: string | null;
  balances: { current: number | null; available: number | null; iso_currency_code: string | null };
}

export interface PlaidTransaction {
  transaction_id: string;
  account_id: string;
  /** Positive when money LEAVES the account. See packages/core/src/banking.ts. */
  amount: number;
  date: string;
  name: string;
  merchant_name: string | null;
  pending: boolean;
  personal_finance_category?: { primary?: string } | null;
}

export interface SyncPage {
  added: PlaidTransaction[];
  modified: PlaidTransaction[];
  removed: Array<{ transaction_id: string }>;
  next_cursor: string;
  has_more: boolean;
}

export class PlaidClient {
  private readonly host: string;

  constructor(
    private readonly clientId: string,
    private readonly secret: string,
    envName = "sandbox",
  ) {
    this.host = HOSTS[envName] ?? HOSTS.sandbox!;
  }

  private async call<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.host}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client_id: this.clientId, secret: this.secret, ...body }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // fall through to the status-based message
    }
    if (!res.ok) {
      const e = data as { error_code?: string; error_message?: string } | null;
      throw new PlaidError(
        e?.error_message ?? `bank request failed (${res.status})`,
        e?.error_code ?? null,
      );
    }
    return data as T;
  }

  /**
   * A short-lived token that opens the bank picker.
   *
   * No redirect_uri: on desktop, Link opens the bank's own page in a popup and
   * never needs one, which is what makes this work without a hosted HTTPS
   * endpoint. `transactions` only, so the token cannot be widened later into
   * something that moves money.
   */
  async createLinkToken(userId: string): Promise<string> {
    const r = await this.call<{ link_token: string }>("/link/token/create", {
      user: { client_user_id: userId },
      client_name: "Toreroflow",
      products: ["transactions"],
      country_codes: ["US"],
      language: "en",
    });
    return r.link_token;
  }

  /** Trades the one-time token Link returns for the long-lived access token. */
  async exchangePublicToken(
    publicToken: string,
  ): Promise<{ accessToken: string; itemId: string }> {
    const r = await this.call<{ access_token: string; item_id: string }>(
      "/item/public_token/exchange",
      { public_token: publicToken },
    );
    return { accessToken: r.access_token, itemId: r.item_id };
  }

  async accounts(accessToken: string): Promise<PlaidAccount[]> {
    const r = await this.call<{ accounts: PlaidAccount[] }>("/accounts/get", {
      access_token: accessToken,
    });
    return r.accounts;
  }

  /** Which bank this is, for showing something other than an opaque id. */
  async institutionName(accessToken: string): Promise<string | null> {
    try {
      const item = await this.call<{ item: { institution_id?: string | null } }>("/item/get", {
        access_token: accessToken,
      });
      const id = item.item?.institution_id;
      if (!id) return null;
      const inst = await this.call<{ institution: { name: string } }>("/institutions/get_by_id", {
        institution_id: id,
        country_codes: ["US"],
      });
      return inst.institution.name;
    } catch {
      // Cosmetic only: a missing name must not fail a connection.
      return null;
    }
  }

  /** One page of the incremental transaction feed. */
  async syncTransactions(accessToken: string, cursor: string | null): Promise<SyncPage> {
    return await this.call<SyncPage>("/transactions/sync", {
      access_token: accessToken,
      ...(cursor ? { cursor } : {}),
    });
  }
}
