const encoder = new TextEncoder();

export function toBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(value: string): Uint8Array {
  const b64 = value.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((value.length + 3) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

/** Opaque id for rows and object keys (22 url-safe chars, 128 bits). */
export function newId(prefix = ''): string {
  return prefix + toBase64Url(randomBytes(16));
}

/** Session token: 256 bits, url-safe. Only its hash is ever stored. */
export function newToken(): string {
  return toBase64Url(randomBytes(32));
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time comparison for equal-length byte arrays. */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

// ── Passwords ──
// The browser runs PBKDF2-SHA256 (600 000 iterations) and sends a 32-byte clientHash;
// the Worker only stores HMAC-SHA256(PASSWORD_PEPPER, clientHash), so auth stays cheap
// on CPU. Must match public/js/core/password.js.

export const PASSWORD_SCHEME = 'client_pbkdf2_hmac_v1';
export const PASSWORD_ITERATIONS = 600_000;

/** Stored for unknown accounts' comparisons, so both paths do the same work. */
const DUMMY_PASSWORD_HMAC = new Uint8Array(32);

/** HMAC-SHA256(pepper, clientHash) as base64url. */
export async function pepperHash(pepper: string, clientHash: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(pepper), fromBase64Url(clientHash));
  return toBase64Url(sig);
}

/**
 * Constant-time check of a clientHash against the stored HMAC. Pass null for an
 * unknown account: the same HMAC and comparison still run, and the result is false.
 */
export async function verifyClientHash(pepper: string, clientHash: string, stored: string | null): Promise<boolean> {
  const actual = fromBase64Url(await pepperHash(pepper, clientHash));
  let expected: Uint8Array = DUMMY_PASSWORD_HMAC;
  if (stored) {
    try {
      expected = fromBase64Url(stored);
    } catch {
      stored = null;
    }
  }
  return timingSafeEqual(actual, expected) && stored !== null;
}

/** Deterministic salt for emails with no account, so /api/auth/salt doesn't reveal accounts. */
export async function fakePasswordSalt(pepper: string, normalizedEmail: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(pepper), encoder.encode(`salt:${normalizedEmail}`));
  return toBase64Url(new Uint8Array(sig).slice(0, 16));
}

// ── HMAC for short-lived signed links ──

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

export async function signValue(secret: string, value: string): Promise<string> {
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), encoder.encode(value));
  return toBase64Url(sig);
}

export async function verifySignature(secret: string, value: string, signature: string): Promise<boolean> {
  try {
    return await crypto.subtle.verify('HMAC', await hmacKey(secret), fromBase64Url(signature), encoder.encode(value));
  } catch {
    return false;
  }
}
