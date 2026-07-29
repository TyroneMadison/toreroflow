import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Encryption for secrets that have to live in the database.
 *
 * The schema has promised this since M1 ("Encrypted blob (libsodium sealed
 * box / KMS). Never store plaintext tokens.") and never delivered it, which
 * has been survivable only because every stored value so far is the sentinel
 * "provider:zernio" and the real credentials live with the provider.
 *
 * A bank access token is not survivable that way. It is a long-lived key to
 * a business account's transaction history sitting in a Postgres column on a
 * developer machine, so it gets real encryption before it gets stored once.
 *
 * AES-256-GCM: authenticated, so a tampered blob fails to decrypt rather
 * than silently yielding wrong bytes. Lives in `packages/db` rather than
 * `packages/core` because core is bundled into the desktop app and must stay
 * free of node built-ins.
 */

/** Self-describing so the scheme can be changed without guessing later. */
const VERSION = "v1";
const ALGORITHM = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;

export class SecretError extends Error {}

/**
 * The key, read at call time rather than import time.
 *
 * Read late so a process that never touches secrets still starts without one,
 * and so a test can set it up before the first use.
 */
function key(): Buffer {
  const raw = process.env.TOKEN_ENCRYPTION_KEY ?? "";
  if (!raw) {
    throw new SecretError(
      "TOKEN_ENCRYPTION_KEY is not set. Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\" and put it in the repo .env.",
    );
  }
  const buf = Buffer.from(raw, "base64");
  if (buf.length !== KEY_BYTES) {
    throw new SecretError(
      `TOKEN_ENCRYPTION_KEY must be ${KEY_BYTES} bytes of base64, got ${buf.length}.`,
    );
  }
  return buf;
}

/** Whether a stored value is one of ours, rather than a legacy sentinel. */
export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(`${VERSION}.`) && value.split(".").length === 4;
}

/**
 * Encrypts a secret for storage.
 *
 * A fresh random IV every time, so encrypting the same token twice produces
 * different blobs and the column leaks nothing by comparison.
 */
export function encryptSecret(plaintext: string): string {
  if (typeof plaintext !== "string" || plaintext === "") {
    throw new SecretError("refusing to encrypt an empty secret");
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString("base64"), tag.toString("base64"), ct.toString("base64")].join(".");
}

/**
 * Reverses `encryptSecret`.
 *
 * Anything that is not a well-formed blob raises rather than being returned
 * as-is. Falling back to "maybe it was plaintext" is how a plaintext token
 * survives a migration unnoticed.
 */
export function decryptSecret(blob: string): string {
  if (!isEncrypted(blob)) {
    throw new SecretError("value is not an encrypted secret");
  }
  const [, ivB64, tagB64, ctB64] = blob.split(".");
  const iv = Buffer.from(ivB64!, "base64");
  const tag = Buffer.from(tagB64!, "base64");
  if (iv.length !== IV_BYTES || tag.length !== 16) {
    throw new SecretError("encrypted secret is malformed");
  }
  const decipher = createDecipheriv(ALGORITHM, key(), iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64!, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch {
    // GCM's tag check failed: wrong key, or the blob was altered.
    throw new SecretError("could not decrypt: wrong key, or the stored value was tampered with");
  }
}

/** Constant-time compare, for anywhere a secret is checked rather than read. */
export function secretsMatch(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}
