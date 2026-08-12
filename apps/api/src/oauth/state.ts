import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The `state` parameter, which is the only thing authenticating an OAuth
 * callback.
 *
 * Every other route in this API is behind an operator JWT. This one cannot be:
 * the request arrives as a browser redirect from Google, in whatever browser
 * the channel owner happened to click the link in, carrying no header we ever
 * set. What it does carry is the state we put on the consent URL and Google
 * hands back untouched.
 *
 * So the state has to say, provably, which account this authorization was
 * started for. Unsigned, the callback would bind any refresh token to any
 * account id a stranger cared to type, which for a URL that is about to be sent
 * to clients is not a theoretical concern.
 *
 * Signed and short-lived, in the shape fileSigning.ts already uses for the same
 * class of problem: a credential that has to survive a round trip through a
 * browser address bar.
 */

/**
 * Long enough for a client to find the right Google account, read a consent
 * screen and click past the unverified-app warning. Short enough that a URL
 * left in a browser history is not a standing key.
 */
export const STATE_TTL_MS = 15 * 60 * 1000;

export interface OAuthState {
  /** The workspace the authorization belongs to. */
  agencyId: string;
  /** The account the credential will be attached to. */
  socialAccountId: string;
}

interface StatePayload extends OAuthState {
  /** Epoch milliseconds. */
  exp: number;
}

function mac(body: string, secret: string): string {
  return createHmac("sha256", secret).update(body).digest("base64url");
}

/** A state token for one authorization attempt. */
export function signState(
  state: OAuthState,
  secret: string,
  now: number = Date.now(),
): string {
  const payload: StatePayload = { ...state, exp: now + STATE_TTL_MS };
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${body}.${mac(body, secret)}`;
}

export type StateVerdict =
  | { ok: true; state: OAuthState }
  | { ok: false; reason: "malformed" | "bad-signature" | "expired" };

/**
 * Whether a returned state is one we issued, and still current.
 *
 * The signature is checked before the payload is trusted for anything at all,
 * including its own expiry, so a forged token cannot claim to be valid forever.
 * Constant-time, for the same reason the file links are.
 */
export function verifyState(
  token: unknown,
  secret: string,
  now: number = Date.now(),
): StateVerdict {
  if (typeof token !== "string" || !token) return { ok: false, reason: "malformed" };
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return { ok: false, reason: "malformed" };
  const body = token.slice(0, dot);
  const provided = token.slice(dot + 1);

  const expected = mac(body, secret);
  const a = Buffer.from(expected);
  const b = Buffer.from(provided);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad-signature" };
  }

  let payload: StatePayload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as StatePayload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (
    typeof payload?.agencyId !== "string" ||
    typeof payload?.socialAccountId !== "string" ||
    typeof payload?.exp !== "number"
  ) {
    return { ok: false, reason: "malformed" };
  }
  if (now > payload.exp) return { ok: false, reason: "expired" };
  return { ok: true, state: { agencyId: payload.agencyId, socialAccountId: payload.socialAccountId } };
}
