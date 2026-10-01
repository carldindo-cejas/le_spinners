/** Sign-in helpers: fetch the account's salt, derive the clientHash on this device. */
import { api } from './api.js';
import { deriveClientHash, normalizeEmail, PASSWORD_SCHEME } from './password.js';

/**
 * Returns the clientHash to send to /api/auth/login (or as currentClientHash).
 * The salt response looks the same whether or not the account exists.
 */
export async function passwordProof(email, password) {
  const params = await api.post('/api/auth/salt', { email: normalizeEmail(email) }, { quiet401: true });
  if (!params || params.scheme !== PASSWORD_SCHEME) throw new Error('Unexpected sign-in parameters. Please reload the page and try again.');
  return deriveClientHash(password, params.salt, params.iterations);
}

export { newPasswordCredentials, normalizeEmail } from './password.js';
