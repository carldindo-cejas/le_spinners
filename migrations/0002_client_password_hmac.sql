-- Passwords move to browser-side PBKDF2 + Worker-side HMAC (scheme client_pbkdf2_hmac_v1).
--   password_hash        HMAC-SHA256(PASSWORD_PEPPER, clientHash), base64url
--   password_salt        16-byte salt the browser uses for PBKDF2, base64url
--   password_iterations  PBKDF2 iterations the browser runs (600 000)
--   password_scheme      'client_pbkdf2_hmac_v1'; anything else cannot sign in
--
-- The old server-side PBKDF2 scheme is dropped outright (no production users yet).
-- Any account left over from it is marked 'reset_required' and needs a password reset
-- (e.g. npm run create-admin for staff); server-side PBKDF2 is never brought back.

ALTER TABLE users ADD COLUMN password_salt TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN password_iterations INTEGER NOT NULL DEFAULT 600000;
ALTER TABLE users ADD COLUMN password_scheme TEXT NOT NULL DEFAULT 'reset_required';

UPDATE users SET password_hash = '', password_salt = '', password_scheme = 'reset_required';
DELETE FROM sessions;
