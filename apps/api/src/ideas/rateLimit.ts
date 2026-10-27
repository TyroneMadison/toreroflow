/**
 * Per-key request limit for the public routes (request form, approval pages).
 * True when this hit is allowed.
 *
 * ponytail: in memory, per process, never shrinks below active keys; move to
 * the database if the API ever runs on more than one server.
 */
export function rateLimiter(windowMs: number, max: number) {
  const hits = new Map<string, number[]>();
  return (key: string, now = Date.now()): boolean => {
    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
    if (recent.length >= max) {
      hits.set(key, recent);
      return false;
    }
    hits.set(key, [...recent, now]);
    return true;
  };
}
