/**
 * Password derivation, done on the device so the Worker never runs the slow KDF.
 *
 *   password ──PBKDF2-SHA256 (600 000 iterations, 16-byte salt)──▶ clientHash (32 bytes)
 *   clientHash ──HTTPS──▶ Worker: HMAC-SHA256(PASSWORD_PEPPER, clientHash) ──▶ D1
 *
 * clientHash is a password-equivalent credential: send it only in a request body,
 * never store it (no localStorage, IndexedDB, URLs or logs).
 *
 * Pure module with no DOM access, shared by the browser and scripts/ (Node 20+).
 */

export const PASSWORD_SCHEME = 'client_pbkdf2_hmac_v1';
export const PASSWORD_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const HASH_BITS = 256;
// Refuse server-supplied parameters weaker than the current scheme (downgrade guard).
const MAX_ITERATIONS = 10_000_000;

export function normalizeEmail(email) {
  return String(email ?? '').trim().toLowerCase();
}

export function toBase64Url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value) {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function subtle() {
  const s = globalThis.crypto && globalThis.crypto.subtle;
  if (!s) {
    // Web Crypto only exists on secure origins (https:// or localhost).
    const err = new Error('Secure sign-in needs a secure connection. Open this site with https://.');
    err.code = 'INSECURE_CONTEXT';
    throw err;
  }
  return s;
}

/** A fresh random salt for a new or changed password (base64url, 16 bytes). */
export function newPasswordSalt() {
  subtle();
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(SALT_BYTES)));
}

/** PBKDF2-SHA256(password, salt, iterations) → 32-byte clientHash as base64url. */
export async function deriveClientHash(password, salt, iterations = PASSWORD_ITERATIONS) {
  if (!Number.isInteger(iterations) || iterations < PASSWORD_ITERATIONS || iterations > MAX_ITERATIONS) {
    throw new Error('Unexpected sign-in parameters. Please reload the page and try again.');
  }
  const s = subtle();
  // NFKC so the same password typed on different keyboards derives the same key.
  const key = await s.importKey('raw', new TextEncoder().encode(String(password).normalize('NFKC')), 'PBKDF2', false, ['deriveBits']);
  const bits = await s.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromBase64Url(salt), iterations }, key, HASH_BITS);
  return toBase64Url(new Uint8Array(bits));
}

/** Everything the server needs to store a new password: a new salt and its clientHash. */
export async function newPasswordCredentials(password) {
  const salt = newPasswordSalt();
  const clientHash = await deriveClientHash(password, salt, PASSWORD_ITERATIONS);
  return { scheme: PASSWORD_SCHEME, iterations: PASSWORD_ITERATIONS, salt, clientHash };
}
