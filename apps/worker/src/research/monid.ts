import type { ResearchPlatform } from "@toreroflow/core";

/**
 * The gateway Toreroflow buys public competitor data through.
 *
 * Nothing in this app talks to Instagram or TikTok. Every fetch happens on the
 * provider's own infrastructure, logged out, with no cookie, session or client
 * credential from us. That is the whole reason this file exists rather than a
 * scraper: a fetch made from here, or with a client's connected account, is
 * what gets that client's account rate limited and eventually banned, and
 * their account is their livelihood.
 *
 * Monid is a broker over other providers (its own docs demonstrate calling
 * Apify actors through it), so it solves billing and routing, not compliance.
 * Kept behind `ResearchProvider` so it can be replaced without touching the
 * schema, the storage or the screen.
 */

const API = "https://api.monid.ai";

/** Endpoints confirmed against the live catalogue on 2026-07-29. */
const ENDPOINTS = {
  instagram: {
    resolve: { provider: "tikhub", endpoint: "/api/v1/instagram/v1/fetch_user_info_by_username" },
    posts: { provider: "tikhub", endpoint: "/api/v1/instagram/v1/fetch_user_posts" },
  },
  tiktok: {
    resolve: { provider: "tikhub", endpoint: "/api/v1/tiktok/web/fetch_search_user" },
    posts: { provider: "tikhub", endpoint: "/api/v1/tiktok/web/fetch_user_post" },
  },
} as const;

export class ResearchError extends Error {
  constructor(
    message: string,
    /** True when the wallet is empty, which is an operator problem not a bug. */
    readonly outOfCredit = false,
  ) {
    super(message);
  }
}

export interface ResolvedAccount {
  externalId: string;
  displayName: string | null;
}

export interface FetchedPosts {
  raw: unknown;
  costCents: number;
}

export interface ResearchProvider {
  resolve(platform: ResearchPlatform, handle: string): Promise<ResolvedAccount>;
  fetchPosts(platform: ResearchPlatform, externalId: string, count: number): Promise<FetchedPosts>;
}

interface RunResult {
  runId?: string;
  status?: string;
  output?: unknown;
  cost?: { value?: number };
  error?: { message?: string };
  /**
   * The underlying provider's own answer.
   *
   * A gateway run reports COMPLETED whenever it managed to call the provider,
   * including when the provider itself answered 400. Without reading this, a
   * refused request looks like a successful one that happened to return
   * nothing, and an empty snapshot gets stored as fact.
   */
  providerResponse?: { httpStatus?: number; error?: unknown };
  resultCount?: number;
}

/** The provider's message, dug out of whatever shape it arrived in. */
function providerMessage(pr: RunResult["providerResponse"]): string | null {
  const err = pr?.error as { detail?: { message?: string }; message?: string } | undefined;
  return err?.detail?.message ?? err?.message ?? null;
}

/**
 * Statuses that mean the run has stopped, whatever the outcome.
 *
 * Compared case-insensitively because the API answers in upper case
 * ("RUNNING", then "COMPLETED"). Matching the documented lower-case spelling
 * meant no status ever counted as finished, so every run polled until it
 * timed out and reported the provider as slow rather than done.
 */
const TERMINAL = new Set(["completed", "succeeded", "success", "failed", "error", "cancelled", "timed_out"]);
const FAILED = new Set(["failed", "error", "cancelled", "timed_out"]);

const statusOf = (r: RunResult): string => String(r?.status ?? "").toLowerCase();
const isTerminal = (r: RunResult): boolean => !r?.status || TERMINAL.has(statusOf(r));

/** Pull a value out of a provider payload without knowing its exact shape. */
function findFirst(value: unknown, keys: string[], depth = 0): string | null {
  if (depth > 6 || value === null || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === "string" && v.trim()) return v;
    if (typeof v === "number" && Number.isFinite(v)) return String(v);
  }
  for (const v of Object.values(obj)) {
    const found = findFirst(v, keys, depth + 1);
    if (found) return found;
  }
  return null;
}

export class MonidProvider implements ResearchProvider {
  constructor(private readonly apiKey: string) {}

  private async call(path: string, body: unknown): Promise<unknown> {
    const res = await fetch(`${API}${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // Some errors answer with a bare string.
    }
    if (res.status === 402) {
      throw new ResearchError(
        "The research wallet is empty. Top up the Monid balance and run this again.",
        true,
      );
    }
    if (!res.ok && res.status !== 202) {
      const message =
        (data as { error?: { message?: string }; message?: string } | null)?.error?.message ??
        (data as { message?: string } | null)?.message ??
        text.slice(0, 200) ??
        `research request failed (${res.status})`;
      // The request id is the only thing support can act on.
      throw new ResearchError(`${message} (request ${res.headers.get("x-request-id") ?? "?"})`);
    }
    return data;
  }

  /**
   * Runs one endpoint and waits for its result.
   *
   * Runs are asynchronous: a 202 means it is still going and the result is
   * polled. A synchronous call can also time out with a 408, so polling is
   * the path that always works rather than the fallback.
   */
  private async run(
    provider: string,
    endpoint: string,
    input: Record<string, unknown>,
  ): Promise<{ output: unknown; costCents: number }> {
    let result = (await this.call("/v1/run", { provider, endpoint, input })) as RunResult;

    // A start answers 202 with status RUNNING and a runId to poll.
    if (result?.runId && !isTerminal(result)) {
      const deadline = Date.now() + 180_000;
      let delay = 1000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(delay * 1.4, 8000);
        const res = await fetch(`${API}/v1/runs/${result.runId}`, {
          headers: { Authorization: `Bearer ${this.apiKey}` },
          signal: AbortSignal.timeout(30_000),
        });
        result = (await res.json()) as RunResult;
        if (isTerminal(result)) break;
      }
      if (!isTerminal(result)) {
        throw new ResearchError("the research provider is still working after 3 minutes");
      }
    }

    if (FAILED.has(statusOf(result))) {
      throw new ResearchError(
        result.error?.message ?? `the research provider returned ${result.status}`,
      );
    }

    // A completed run whose provider refused the request is a failure, not an
    // empty result. Most often the account is private, deleted, or has no
    // public posts, which is worth saying plainly rather than storing nothing
    // and calling it research.
    const http = result.providerResponse?.httpStatus;
    if (typeof http === "number" && (http < 200 || http >= 300)) {
      // The source's own wording is developer boilerplate telling you to
      // check your parameters, which is neither true nor useful on a screen
      // the operator reads. In practice a refusal here means the account is
      // private, renamed, or has nothing public, so say that instead and
      // keep their text only when it is genuinely specific.
      const theirs = providerMessage(result.providerResponse);
      const useful = theirs && !/verify your parameters|please retry/i.test(theirs) ? ` (${theirs})` : "";
      throw new ResearchError(
        `This account could not be read. It is usually private, renamed, or has no public posts.${useful}`,
      );
    }
    if (result.output === null || result.output === undefined) {
      throw new ResearchError("the source returned nothing for this account");
    }

    // Charged in dollars; stored in cents so the ceiling is exact.
    const dollars = typeof result?.cost?.value === "number" ? result.cost.value : 0;
    return { output: result.output, costCents: Math.ceil(dollars * 100) };
  }

  async resolve(platform: ResearchPlatform, handle: string): Promise<ResolvedAccount> {
    const { provider, endpoint } = ENDPOINTS[platform].resolve;
    const input =
      platform === "instagram"
        ? { queryParams: { username: handle } }
        : { queryParams: { keyword: handle, count: 10 } };

    const { output } = await this.run(provider, endpoint, input);

    // Instagram identifies accounts by a numeric user id, TikTok by a secUid.
    // Neither posts endpoint accepts a handle, which is why this call exists
    // at all and why its answer is stored rather than re-fetched.
    const externalId =
      platform === "instagram"
        ? findFirst(output, ["pk", "id", "user_id", "pk_id"])
        : findFirst(output, ["sec_uid", "secUid"]);

    if (!externalId) {
      throw new ResearchError(`could not find @${handle} on ${platform}`);
    }
    return {
      externalId,
      displayName: findFirst(output, ["full_name", "nickname", "fullName"]),
    };
  }

  async fetchPosts(
    platform: ResearchPlatform,
    externalId: string,
    count: number,
  ): Promise<FetchedPosts> {
    const { provider, endpoint } = ENDPOINTS[platform].posts;
    const input =
      platform === "instagram"
        ? { queryParams: { user_id: externalId, count } }
        : { queryParams: { secUid: externalId, count } };

    const { output, costCents } = await this.run(provider, endpoint, input);
    // Stored verbatim: every fetch costs money, so discarding fields we did
    // not think to parse means paying twice the first time a later phase
    // wants something new.
    return { raw: output, costCents };
  }
}
