/**
 * Query values that are credentials, blanked in the request log: a stream
 * ticket, a file link signature, the webhook verify token Meta sends on its
 * handshake, an OAuth code. The log outlives every one of them.
 */
const SECRET_PARAMS = ["ticket", "s", "hub.verify_token", "hub_verify_token", "code"];
export function redactUrl(url: string): string {
  const q = url.indexOf("?");
  if (q < 0) return url;
  const params = new URLSearchParams(url.slice(q + 1));
  let hit = false;
  for (const k of SECRET_PARAMS) if (params.has(k)) (params.set(k, "redacted"), (hit = true));
  return hit ? `${url.slice(0, q)}?${params}` : url;
}
export const logReq = (req: { method: string; url: string; host?: string; ip?: string; socket?: { remotePort?: number } }) => ({
  method: req.method,
  url: redactUrl(req.url),
  host: req.host,
  remoteAddress: req.ip,
  remotePort: req.socket?.remotePort,
});
