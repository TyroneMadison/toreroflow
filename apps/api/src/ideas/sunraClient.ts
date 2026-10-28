import type { SunraCatalog, SunraGenerator, SunraJob } from "../routes/sunra";

/**
 * Sunra's multimodal REST API (https://docs.sunra.ai), as the catalog and
 * generator behind the carousel routes. Wired at startup only when
 * SUNRA_API_KEY is set; unset leaves the observed fallback list and the 503.
 *
 * Endpoints called, all on SUNRA_API_BASE (default https://api.sunra.ai):
 *   GET  /v1/models?limit=300                                     model ids and aliases
 *   GET  /v1/pricing?limit=10000                                  which models have text-to-image
 *   GET  /v1/pricing/model/{model_id}/endpoint/text-to-image      price rules for one model
 *   POST /v1/queue/{owner}/{model}/text-to-image                  submit one slide
 *   GET  /v1/queue/requests/{request_id}/status                   poll
 *   GET  /v1/queue/requests/{request_id}                          result: { images: [{ url }] }
 *   PUT  /v1/queue/requests/{request_id}/cancel                   on our own deadline
 * plus a plain GET of each returned image url.
 *
 * Sunra bills in USD. Quotes stay in credits, and a credit here is one US
 * cent: the docs define no other credit unit (their own "credits" in
 * INSUFFICIENT_CREDIT are USD), and cents keep the integer quote exact.
 */

export const SUNRA_DEFAULT_BASE = "https://api.sunra.ai";
export const CREDITS_PER_USD = 100;
const OPERATION = "text-to-image";

/** A Sunra call that did not give us what we asked for. Never carries the key. */
export class SunraError extends Error {
  constructor(
    message: string,
    /** HTTP status, absent for timeouts and failed predictions. */
    readonly status?: number,
    /** Sunra's error.code: an API request code or a prediction failure code. */
    readonly code?: string,
    /** Prediction failures only: Sunra's own word on whether retrying can help. */
    readonly retryable?: boolean,
  ) {
    super(message);
    this.name = "SunraError";
  }
}

export interface SunraClientOptions {
  apiKey: string;
  base?: string;
  /** Per HTTP call. */
  timeoutMs?: number;
  /** Poll backoff: starts at pollMs, x1.5 each time, capped at maxPollMs. */
  pollMs?: number;
  maxPollMs?: number;
  /** Longest one slide may take from submit to result before we cancel it. */
  slideDeadlineMs?: number;
}

type Json = Record<string, any>;

export function sunraClient(o: SunraClientOptions) {
  const base = (o.base || SUNRA_DEFAULT_BASE).replace(/\/+$/, "");
  const timeoutMs = o.timeoutMs ?? 30_000;
  const pollMs = o.pollMs ?? 1_000;
  const maxPollMs = o.maxPollMs ?? 10_000;
  const slideDeadlineMs = o.slideDeadlineMs ?? 5 * 60_000;

  async function call(method: string, path: string, body?: unknown): Promise<Json> {
    const url = `${base}${path}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers: { Authorization: `Key ${o.apiKey}`, ...(body ? { "Content-Type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      const timedOut = e instanceof Error && e.name === "TimeoutError";
      throw new SunraError(timedOut ? `Sunra ${method} ${path} timed out after ${timeoutMs} ms` : `Sunra ${method} ${path} failed: ${errText(e)}`);
    }
    const json = (await res.json().catch(() => ({}))) as Json;
    if (!res.ok) {
      const err = json.error ?? {};
      const d = err.details;
      throw new SunraError(
        `Sunra ${method} ${path} answered ${res.status}${err.code ? ` ${err.code}` : ""}: ${err.message ?? res.statusText}`,
        res.status,
        d?.code ?? err.code,
        d?.retryable,
      );
    }
    return json;
  }

  // Maps a model alias ("owner/model") to Sunra's model id, for the price call.
  const ids = new Map<string, string>();

  const catalog: SunraCatalog = {
    async listModels() {
      const [models, pricing] = await Promise.all([call("GET", "/v1/models?limit=300"), call("GET", "/v1/pricing?limit=10000")]);
      const t2i = new Set<string>((pricing.data ?? []).filter((p: Json) => p.model_endpoint === OPERATION).map((p: Json) => p.model_name));
      // ponytail: joined on the alias's name part, the only key both lists document; a name
      // shared by two owners lists both and the wrong one fails its price call.
      return (models.data ?? [])
        .filter((m: Json) => typeof m.alias === "string" && t2i.has(m.alias.split("/").pop()!))
        .map((m: Json) => {
          ids.set(m.alias, m.id);
          const [owner, name] = m.alias.split("/");
          return { kind: "image", id: m.alias, label: name ?? m.alias, provider: owner, supportedAspectRatios: [], supportedSizes: [], supportedResolutions: [], maxRefImages: 0 };
        });
    },
    async estimateCost(alias) {
      const id = ids.get(alias);
      if (!id) throw new SunraError(`Sunra model ${alias} is not in the model list`);
      const card = await call("GET", `/v1/pricing/model/${encodeURIComponent(id)}/endpoint/${OPERATION}`);
      // Rounded so 0.07 USD is 7 credits, not 7.000000000000001 (which the quote would ceil to 8).
      return Math.round(CREDITS_PER_USD * usdPerImage(card) * 1e6) / 1e6;
    },
  };

  async function oneSlide(job: SunraJob, prompt: string): Promise<Buffer> {
    const submitted = await call("POST", `/v1/queue/${job.modelId.split("/").map(encodeURIComponent).join("/")}/${OPERATION}`, {
      prompt,
      aspect_ratio: job.aspectRatio,
    });
    const rid = submitted.request_id;
    if (typeof rid !== "string" || !rid) throw new SunraError("Sunra accepted the request without a request_id");
    const req = `/v1/queue/requests/${encodeURIComponent(rid)}`;
    const deadline = Date.now() + slideDeadlineMs;
    for (let wait = pollMs; ; wait = Math.min(maxPollMs, wait * 1.5)) {
      if (Date.now() + wait > deadline) {
        await call("PUT", `${req}/cancel`).catch(() => undefined);
        throw new SunraError(`Sunra did not finish ${rid} within ${slideDeadlineMs} ms; cancelled`);
      }
      await new Promise((r) => setTimeout(r, wait));
      let s: Json;
      try {
        s = await call("GET", `${req}/status`);
      } catch (e) {
        // Rate limits and Sunra-side blips: keep polling until the deadline.
        if (e instanceof SunraError && (e.status === 429 || (e.status ?? 0) >= 500 || e.status === undefined)) continue;
        throw e;
      }
      if (s.status === "CANCELED") throw new SunraError(`Sunra request ${rid} was cancelled`);
      if (s.status !== "COMPLETED") continue;
      if (s.success === false) {
        throw new SunraError(`Sunra could not make the image: ${s.error?.message ?? "no reason given"}`, undefined, s.error?.code, s.error?.retryable);
      }
      break;
    }
    const result = await call("GET", req);
    const url = result.images?.[0]?.url;
    if (typeof url !== "string") throw new SunraError(`Sunra request ${rid} finished without an image`);
    let img: Response;
    try {
      img = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
      throw new SunraError(`Downloading Sunra image for ${rid} failed: ${errText(e)}`);
    }
    if (!img.ok) throw new SunraError(`Downloading Sunra image for ${rid} answered ${img.status}`, img.status);
    return Buffer.from(await img.arrayBuffer());
  }

  // ponytail: one slide at a time so a failure stops spending; parallel if build time matters.
  const generator: SunraGenerator = async (job) => {
    const out: Buffer[] = [];
    for (let i = 1; i <= job.slides; i++) {
      out.push(await oneSlide(job, job.slides > 1 ? `${job.prompt}\n\nSlide ${i} of ${job.slides}.` : job.prompt));
    }
    return out;
  };

  return { catalog, generator };
}

/**
 * The most one image can cost, in USD, from a price card: post_calculated
 * cards reserve freeze_amount, pre_defined ones charge one of their rows.
 * ponytail: the dearest row, not the row our payload matches; the quote is a ceiling.
 */
export function usdPerImage(card: Json): number {
  const freeze = Number(card.freeze_amount);
  if (card.type === "post_calculated" && freeze > 0) return freeze;
  const amounts = (card.prices ?? []).map((p: Json) => Number(p.unit_amount)).filter((n: number) => n > 0);
  if (!amounts.length) throw new SunraError(`Sunra has no price for ${card.model_name ?? "this model"}`);
  return Math.max(...amounts);
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
