import { createHash } from "node:crypto";

/**
 * Publishes report pages to a Netlify site without disturbing what is
 * already there.
 *
 * Netlify deploys are atomic whole-site replacements: a deploy declares
 * every file the site should contain, and anything omitted is deleted. So
 * adding one page means re-declaring the existing ones. That is safe because
 * files are addressed by content hash, and Netlify only asks for uploads of
 * hashes it does not already hold, meaning existing assets (including large
 * video) are reused rather than re-sent.
 */

const API = "https://api.netlify.com/api/v1";

export class NetlifyError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface NetlifyFile {
  path: string;
  sha: string;
}

export interface PublishResult {
  deployId: string;
  state: string;
  uploaded: number;
  preserved: number;
  url: string;
}

const sha1 = (buf: Buffer | string): string =>
  createHash("sha1").update(buf).digest("hex");

export class NetlifyPublisher {
  constructor(private readonly token: string) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    contentType = "application/json",
  ): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.token}` };
    let payload: string | Buffer | undefined;
    if (body !== undefined) {
      headers["Content-Type"] = contentType;
      payload = contentType === "application/json" ? JSON.stringify(body) : (body as Buffer);
    }
    const res = await fetch(`${API}${path}`, { method, headers, body: payload });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      // some endpoints answer with a bare string
    }
    if (!res.ok) {
      const message =
        data && typeof data === "object" && "message" in data
          ? String((data as { message: unknown }).message)
          : text.slice(0, 200) || `netlify request failed (${res.status})`;
      throw new NetlifyError(res.status, message);
    }
    return data as T;
  }

  async listSites(): Promise<Array<{ id: string; name: string; ssl_url: string; url: string; custom_domain: string | null }>> {
    return await this.request("GET", "/sites?per_page=50");
  }

  /**
   * The site's public address, preferring the custom domain.
   *
   * `ssl_url` already reflects the primary custom domain once one is
   * attached, so a report link becomes `https://torerone.com/<slug>` rather
   * than the netlify.app subdomain without any extra configuration here.
   */
  async siteUrl(siteId: string): Promise<string> {
    const site = await this.request<{ ssl_url?: string; url?: string; name?: string }>(
      "GET",
      `/sites/${siteId}`,
    );
    return site.ssl_url ?? site.url ?? `https://${site.name ?? siteId}.netlify.app`;
  }

  /** Every file in the site's current live deploy, with its content hash. */
  async currentFiles(siteId: string): Promise<NetlifyFile[]> {
    const site = await this.request<{ published_deploy?: { id?: string } }>(
      "GET",
      `/sites/${siteId}`,
    );
    const deployId = site.published_deploy?.id;
    if (!deployId) return [];
    const files = await this.request<Array<{ id: string; path: string; sha: string }>>(
      "GET",
      `/deploys/${deployId}/files`,
    );
    return files.map((f) => ({ path: f.path, sha: f.sha }));
  }

  /**
   * Adds or replaces `additions` on the site, keeping everything else.
   *
   * Keys of `additions` are site-absolute paths ("/caleb-report/index.html").
   */
  async publish(
    siteId: string,
    additions: Record<string, string>,
  ): Promise<PublishResult> {
    const existing = await this.currentFiles(siteId);

    const newShas = new Map<string, { sha: string; body: string }>();
    for (const [path, content] of Object.entries(additions)) {
      newShas.set(path, { sha: sha1(content), body: content });
    }

    // Existing files first, then ours, so a report path replaces rather than
    // duplicates a previous version of itself.
    const manifest: Record<string, string> = {};
    for (const f of existing) manifest[f.path] = f.sha;
    for (const [path, v] of newShas) manifest[path] = v.sha;

    const deploy = await this.request<{ id: string; state: string; required?: string[] }>(
      "POST",
      `/sites/${siteId}/deploys`,
      { files: manifest, async: false },
    );

    // Netlify replies with only the hashes it does not already store.
    const required = new Set(deploy.required ?? []);
    let uploaded = 0;
    for (const [path, v] of newShas) {
      if (required.size > 0 && !required.has(v.sha)) continue;
      await this.request(
        "PUT",
        `/deploys/${deploy.id}/files${path}`,
        Buffer.from(v.body, "utf8"),
        "application/octet-stream",
      );
      uploaded += 1;
    }

    const final = await this.waitForReady(deploy.id);

    return {
      deployId: deploy.id,
      state: final.state,
      uploaded,
      preserved: existing.length,
      url: final.ssl_url ?? final.url ?? "",
    };
  }

  /**
   * Waits for a deploy to actually go live.
   *
   * A deploy is not servable the moment its files finish uploading; it moves
   * through processing states first. Returning early would hand the operator
   * a link that 404s for the first few seconds, which is exactly when they
   * paste it to a client. An error state is raised rather than reported as a
   * successful publish.
   */
  async waitForReady(
    deployId: string,
    timeoutMs = 60_000,
  ): Promise<{ id: string; state: string; ssl_url?: string; url?: string }> {
    const started = Date.now();
    let delay = 500;
    for (;;) {
      const deploy = await this.request<{
        id: string;
        state: string;
        ssl_url?: string;
        url?: string;
        error_message?: string;
      }>("GET", `/deploys/${deployId}`);

      if (deploy.state === "ready") return deploy;
      if (deploy.state === "error") {
        throw new NetlifyError(502, deploy.error_message ?? "netlify deploy failed");
      }
      if (Date.now() - started > timeoutMs) {
        // Not a failure: the deploy is still working and will very likely
        // finish. Say so plainly rather than claiming either outcome.
        throw new NetlifyError(
          504,
          `deploy is taking longer than expected (still "${deploy.state}"); check Netlify before sending the link`,
        );
      }
      await new Promise((r) => setTimeout(r, delay));
      delay = Math.min(delay * 1.5, 4000);
    }
  }
}
