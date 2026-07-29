import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { decryptSecret, encryptSecret, isEncrypted, SecretError, secretsMatch } from "./secrets";

/**
 * Runnable check: `pnpm --filter @toreroflow/db test`.
 *
 * This module exists to hold a bank access token, so the properties pinned
 * here are the ones whose failure would put a live credential somewhere it
 * should not be: no plaintext passthrough, no silent tamper, and no reuse of
 * an IV that would let two identical tokens be spotted in the column.
 */

process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");

const token = "access-sandbox-1a2b3c4d-5e6f-7890-abcd-ef1234567890";

/* Round trips exactly, including awkward characters. */
for (const secret of [token, "a", "with spaces and = signs +/", "unicode: café 🚗", "x".repeat(4000)]) {
  assert.equal(decryptSecret(encryptSecret(secret)), secret, `round trip failed for ${secret.slice(0, 20)}`);
}

/* The ciphertext never contains the plaintext. */
const blob = encryptSecret(token);
assert.equal(blob.includes(token), false, "the token leaked into its own ciphertext");
assert.equal(blob.startsWith("v1."), true, "blobs are versioned so the scheme can change");
assert.equal(blob.split(".").length, 4, "expected version.iv.tag.ciphertext");

/*
 * Encrypting the same secret twice must produce different blobs.
 *
 * A fixed IV would mean two clients with the same token show identical rows,
 * which leaks that fact to anyone who can read the table.
 */
assert.notEqual(encryptSecret(token), encryptSecret(token), "IV is being reused");

/* Both still decrypt to the same thing. */
assert.equal(decryptSecret(encryptSecret(token)), decryptSecret(encryptSecret(token)));

/* Tampering is caught rather than yielding wrong bytes. */
{
  const parts = encryptSecret(token).split(".");
  const ct = Buffer.from(parts[3]!, "base64");
  ct[0] = ct[0]! ^ 0xff;
  parts[3] = ct.toString("base64");
  assert.throws(() => decryptSecret(parts.join(".")), SecretError, "a flipped bit must fail the tag check");
}

/* A blob encrypted under a different key must not decrypt. */
{
  const other = encryptSecret(token);
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
  assert.throws(() => decryptSecret(other), SecretError, "decrypted under the wrong key");
  process.env.TOKEN_ENCRYPTION_KEY = randomBytes(32).toString("base64");
}

/*
 * Legacy and malformed values raise rather than passing through.
 *
 * Returning the input when it does not look encrypted is how a plaintext
 * token survives a migration without anyone noticing.
 */
for (const bad of ["provider:zernio", "", "v1.", "v1.a.b", "not-a-blob", "v2.a.b.c"]) {
  assert.equal(isEncrypted(bad), false, `${bad} should not read as encrypted`);
  assert.throws(() => decryptSecret(bad), SecretError, `${bad} should not decrypt`);
}
assert.equal(isEncrypted(null), false);
assert.equal(isEncrypted(undefined), false);
assert.equal(isEncrypted(encryptSecret(token)), true);

/* An empty secret is a bug at the call site, not something to store. */
assert.throws(() => encryptSecret(""), SecretError);

/* A missing key is a clear error, not a crash deep in node:crypto. */
{
  const saved = process.env.TOKEN_ENCRYPTION_KEY;
  delete process.env.TOKEN_ENCRYPTION_KEY;
  assert.throws(() => encryptSecret(token), /TOKEN_ENCRYPTION_KEY is not set/);
  process.env.TOKEN_ENCRYPTION_KEY = "too-short";
  assert.throws(() => encryptSecret(token), /must be 32 bytes/);
  process.env.TOKEN_ENCRYPTION_KEY = saved;
}

/* Constant-time compare behaves like equality. */
assert.equal(secretsMatch("abc", "abc"), true);
assert.equal(secretsMatch("abc", "abd"), false);
assert.equal(secretsMatch("abc", "abcd"), false);
assert.equal(secretsMatch("", ""), true);

console.log("secrets: all checks passed");
