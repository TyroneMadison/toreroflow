import type { Platform } from "@toreroflow/core";

const BASE = "https://zernio.com/api/v1";

export class ZernioError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface ZernioAccount {
  _id: string;
  platform: string;
  username?: string;
  name?: string;
  displayName?: string;
  profileId?: string;
  profile?: string;
  status?: string;
}

/**
 * Zernio unified publishing provider (docs.zernio.com).
 * Model: one Zernio "profile" per Toreroflow client; accounts OAuth-connect to
 * that profile via a hosted authUrl; tokens live with Zernio, never with us.
 */
export class ZernioProvider {
  constructor(private readonly apiKey: string) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // non-JSON error body; keep raw text for the error message
    }
    if (!res.ok) {
      const message =
        typeof data === "object" && data !== null && "error" in data
          ? String((data as { error: unknown }).error)
          : text.slice(0, 200) || `zernio request failed (${res.status})`;
      throw new ZernioError(res.status, message);
    }
    return data as T;
  }

  /** Create the Zernio profile backing a Toreroflow client. Returns profile id. */
  async createProfile(name: string, description?: string): Promise<string> {
    const data = await this.request<Record<string, unknown>>("POST", "/profiles", {
      name,
      description: description ?? `Toreroflow client: ${name}`,
    });
    const profile = (data.profile ?? data) as { _id?: string; id?: string };
    const id = profile._id ?? profile.id;
    if (!id) throw new ZernioError(500, "zernio profile response missing id");
    return id;
  }

  /** Hosted OAuth page URL for connecting one platform to a profile. */
  async connectUrl(platform: Platform, profileId: string): Promise<string> {
    const data = await this.request<{ authUrl?: string; url?: string }>(
      "GET",
      `/connect/${platform}?profileId=${encodeURIComponent(profileId)}`,
    );
    const url = data.authUrl ?? data.url;
    if (!url) throw new ZernioError(500, "zernio connect response missing authUrl");
    return url;
  }

  /** All connected accounts visible to this API key. */
  async listAccounts(profileId?: string): Promise<ZernioAccount[]> {
    const query = profileId ? `?profileId=${encodeURIComponent(profileId)}` : "";
    const data = await this.request<Record<string, unknown>>("GET", `/accounts${query}`);
    const accounts = (data.accounts ?? data) as unknown;
    return Array.isArray(accounts) ? (accounts as ZernioAccount[]) : [];
  }

  /**
   * Accounts belonging to one profile. Uses the server-side filter when it
   * works; falls back to filtering on any profile field in the payload.
   */
  async accountsForProfile(profileId: string): Promise<ZernioAccount[]> {
    const accounts = await this.listAccounts(profileId);
    const tagged = accounts.filter(
      (a) => a.profileId === profileId || a.profile === profileId,
    );
    // If Zernio ignored the query param and items carry no profile field,
    // we cannot distinguish; return everything rather than nothing.
    if (tagged.length === 0 && accounts.some((a) => !a.profileId && !a.profile)) {
      return accounts;
    }
    return tagged;
  }
}
