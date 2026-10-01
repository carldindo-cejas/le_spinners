import { Hono } from 'hono';
import * as z from 'zod';
import type { AppEnv, UserRow } from '../types';
import { audit, clientIp, createSession, destroySession, enforceRateLimit, hitRateLimit, passwordPepper, requireUser, userDTO } from '../lib/auth';
import { fakePasswordSalt, newId, PASSWORD_ITERATIONS, PASSWORD_SCHEME, pepperHash, verifyClientHash } from '../lib/crypto';
import { ApiError, conflict, forbidden, tooMany } from '../lib/errors';
import { jsonBody } from '../lib/validate';

const MINUTE = 60_000;
const RELOAD = 'Please reload the page and try again.';

// Passwords never reach the Worker: the browser sends PBKDF2 output (see public/js/core/password.js).
const zSalt = z.string().regex(/^[A-Za-z0-9_-]{22}$/, RELOAD); // 16 bytes, base64url
const zClientHash = z.string().regex(/^[A-Za-z0-9_-]{43}$/, RELOAD); // 32 bytes, base64url
const zNewPassword = z.object({
  scheme: z.literal(PASSWORD_SCHEME, { error: RELOAD }),
  iterations: z.literal(PASSWORD_ITERATIONS, { error: RELOAD }),
  salt: zSalt,
  clientHash: zClientHash,
});

type PasswordRow = { password_hash: string; password_salt: string; password_iterations: number; password_scheme: string };
const usable = (row: PasswordRow | null | undefined) => !!row && row.password_scheme === PASSWORD_SCHEME && !!row.password_hash;

export const zEmail = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'That email is too long.')
  .pipe(z.email('Enter a valid email address.'));
const zName = z.string().trim().min(2, 'Enter your full name.').max(80, 'Use at most 80 characters.');
const zPhone = z
  .string()
  .trim()
  .max(20, 'Enter a valid mobile number.')
  .regex(/^(\+?[0-9][0-9 ()-]{6,19})?$/, 'Enter a valid mobile number.')
  .transform((v) => v || null);

const registerSchema = z.object({
  name: zName,
  email: zEmail,
  phone: zPhone.optional(),
  password: zNewPassword,
  memberCode: z
    .string()
    .trim()
    .max(20)
    .regex(/^[A-Za-z0-9-]*$/, 'Use letters, numbers and dashes only.')
    .transform((v) => (v ? v.toUpperCase() : null))
    .optional(),
});

const loginSchema = z.object({
  email: zEmail,
  clientHash: zClientHash,
  remember: z.boolean().optional(),
});

export const authRoutes = new Hono<AppEnv>();

/**
 * Step 1 of sign-in: the PBKDF2 parameters for an email. Unknown emails get a
 * deterministic fake salt with the same shape, so accounts can't be discovered here.
 */
authRoutes.post('/salt', async (c) => {
  const db = c.env.DB;
  const pepper = passwordPepper(c);
  const { email } = await jsonBody(c, z.object({ email: zEmail }));
  const ipOk = await hitRateLimit(db, `salt:ip:${clientIp(c)}`, 60, 15 * MINUTE);
  const emailOk = await hitRateLimit(db, `salt:email:${email}`, 20, 15 * MINUTE);
  if (!ipOk || !emailOk) throw tooMany('Too many sign-in attempts. Please wait 15 minutes and try again.');

  const row = await db
    .prepare('SELECT password_hash, password_salt, password_iterations, password_scheme FROM users WHERE email = ?')
    .bind(email)
    .first<PasswordRow>();
  const fake = await fakePasswordSalt(pepper, email); // computed either way for even timing
  const real = usable(row) ? row : null;
  return c.json({
    scheme: PASSWORD_SCHEME,
    iterations: real?.password_iterations ?? PASSWORD_ITERATIONS,
    salt: real?.password_salt ?? fake,
  });
});

authRoutes.post('/register', async (c) => {
  const db = c.env.DB;
  const pepper = passwordPepper(c);
  await enforceRateLimit(db, `register:ip:${clientIp(c)}`, 5, 60 * MINUTE);
  const body = await jsonBody(c, registerSchema);
  const exists = await db.prepare('SELECT 1 FROM users WHERE email = ?').bind(body.email).first();
  if (exists) throw conflict('EMAIL_TAKEN', 'An account with this email already exists. Sign in instead.', { email: ['Already registered.'] });

  const id = newId('u_');
  const now = Date.now();
  const hash = await pepperHash(pepper, body.password.clientHash);
  // A member code is recorded for staff to confirm; the member rate applies once confirmed.
  const membership = body.memberCode ? 'pending' : 'none';
  try {
    await db
      .prepare(
        `INSERT INTO users (id, email, name, phone, password_hash, password_salt, password_iterations, password_scheme,
                            role, membership, member_code, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'player', ?, ?, 'active', ?, ?)`,
      )
      .bind(
        id, body.email, body.name, body.phone ?? null,
        hash, body.password.salt, PASSWORD_ITERATIONS, PASSWORD_SCHEME,
        membership, body.memberCode ?? null, now, now,
      )
      .run();
  } catch (err) {
    if (String(err).includes('UNIQUE')) throw conflict('EMAIL_TAKEN', 'An account with this email already exists. Sign in instead.');
    throw err;
  }
  await createSession(c, { id, role: 'player' });
  c.executionCtx.waitUntil(audit(c, id, 'register', 'user', id));
  const user = await db.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
  return c.json({ user: user ? userDTO(user) : null }, 201);
});

authRoutes.post('/login', async (c) => {
  const db = c.env.DB;
  const pepper = passwordPepper(c);
  const body = await jsonBody(c, loginSchema);
  const ip = clientIp(c);
  const ipOk = await hitRateLimit(db, `login:ip:${ip}`, 30, 15 * MINUTE);
  const emailOk = await hitRateLimit(db, `login:email:${body.email}`, 8, 15 * MINUTE);
  if (!ipOk || !emailOk) {
    c.executionCtx.waitUntil(audit(c, null, 'login_throttled', 'email', body.email));
    throw tooMany('Too many sign-in attempts. Please wait 15 minutes and try again.');
  }

  const found = await db.prepare('SELECT * FROM users WHERE email = ?').bind(body.email).first<UserRow>();
  const user = usable(found) ? found : null;
  // Unknown accounts run the same HMAC + comparison, so timing doesn't reveal them.
  const valid = await verifyClientHash(pepper, body.clientHash, user?.password_hash ?? null);
  if (!user || !valid) {
    c.executionCtx.waitUntil(audit(c, user?.id ?? null, 'login_failed', 'email', body.email));
    throw new ApiError(401, 'INVALID_CREDENTIALS', 'Email or password is incorrect.');
  }
  if (user.status !== 'active') throw forbidden('This account is disabled. Please contact Le Spinners.');

  if (c.get('user')) await destroySession(c); // never reuse a previous session
  await createSession(c, user, body.remember ?? true);
  await db.prepare('DELETE FROM rate_limits WHERE key = ?').bind(`login:email:${body.email}`).run();
  c.executionCtx.waitUntil(audit(c, user.id, 'login', 'user', user.id));
  return c.json({ user: userDTO(user) });
});

authRoutes.post('/logout', async (c) => {
  const user = c.get('user');
  await destroySession(c);
  if (user) c.executionCtx.waitUntil(audit(c, user.id, 'logout', 'user', user.id));
  return c.json({ ok: true });
});

authRoutes.get('/me', (c) => {
  const user = c.get('user');
  return c.json({ user: user ? userDTO(user) : null });
});

// ── Profile (/api/me) ───────────────────────────────────────────────────────

export const meRoutes = new Hono<AppEnv>();

meRoutes.get('/', (c) => c.json({ user: userDTO(requireUser(c)) }));

meRoutes.patch('/', async (c) => {
  const user = requireUser(c);
  const body = await jsonBody(c, z.object({ name: zName.optional(), phone: zPhone.optional() }));
  const name = body.name ?? user.name;
  const phone = body.phone === undefined ? user.phone : body.phone;
  await c.env.DB.prepare('UPDATE users SET name = ?, phone = ?, updated_at = ? WHERE id = ?').bind(name, phone, Date.now(), user.id).run();
  return c.json({ user: userDTO({ ...user, name, phone }) });
});

meRoutes.post('/password', async (c) => {
  const user = requireUser(c);
  const db = c.env.DB;
  await enforceRateLimit(db, `password:user:${user.id}`, 5, 15 * MINUTE);
  const pepper = passwordPepper(c);
  // currentClientHash is derived with the account's salt from /api/auth/salt, like sign-in.
  const body = await jsonBody(c, z.object({ currentClientHash: zClientHash, newPassword: zNewPassword }));
  const row = await db
    .prepare('SELECT password_hash, password_salt, password_iterations, password_scheme FROM users WHERE id = ?')
    .bind(user.id)
    .first<PasswordRow>();
  const current = usable(row) ? row : null;
  if (!(await verifyClientHash(pepper, body.currentClientHash, current?.password_hash ?? null))) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Please check the highlighted fields.', { currentPassword: ['That password is incorrect.'] });
  }
  if (body.newPassword.salt === current?.password_salt) throw new ApiError(422, 'VALIDATION_ERROR', RELOAD);
  const hash = await pepperHash(pepper, body.newPassword.clientHash);
  await db.batch([
    db
      .prepare(
        `UPDATE users SET password_hash = ?, password_salt = ?, password_iterations = ?, password_scheme = ?, updated_at = ?
          WHERE id = ?`,
      )
      .bind(hash, body.newPassword.salt, PASSWORD_ITERATIONS, PASSWORD_SCHEME, Date.now(), user.id),
    // Sign out everywhere else.
    db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').bind(user.id, user.session_id),
  ]);
  c.executionCtx.waitUntil(audit(c, user.id, 'password_changed', 'user', user.id));
  return c.json({ ok: true });
});
