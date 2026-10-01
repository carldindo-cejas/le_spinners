import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { MiddlewareHandler } from 'hono';
import type { AppContext, AppEnv, Role, SessionUser } from '../types';
import { ApiError, forbidden, tooMany, unauthorized } from './errors';
import { newToken, sha256Hex } from './crypto';

export const SESSION_COOKIE = 'ls_session';
const PLAYER_TTL_MS = 30 * 24 * 60 * 60 * 1000; // players: 30 days, sliding
const STAFF_TTL_MS = 12 * 60 * 60 * 1000; // staff: 12 hours from sign-in, never extended
const TOUCH_EVERY_MS = 60 * 60 * 1000; // record activity at most once an hour

function isHttps(c: AppContext): boolean {
  return new URL(c.req.url).protocol === 'https:';
}

const DEV_PEPPER_PREFIX = 'dev-only-';

/**
 * The PASSWORD_PEPPER secret. Fails closed when it is missing or too short, and
 * refuses the committed development pepper anywhere but localhost.
 */
export function passwordPepper(c: AppContext): string {
  const pepper = c.env.PASSWORD_PEPPER ?? '';
  const host = new URL(c.req.url).hostname;
  const local = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  if (pepper.length < 32 || (pepper.startsWith(DEV_PEPPER_PREFIX) && !local)) {
    console.error('PASSWORD_PEPPER is missing, too short, or the development value. Set it with: wrangler secret put PASSWORD_PEPPER');
    throw new ApiError(503, 'AUTH_UNAVAILABLE', 'Sign-in is temporarily unavailable. Please try again later.');
  }
  return pepper;
}

export function clientIp(c: AppContext): string {
  return c.req.header('CF-Connecting-IP') ?? 'local';
}

/**
 * Starts a session. With `remember` off the cookie lasts until the browser
 * closes (shared phones); the server-side expiry still applies.
 */
export async function createSession(c: AppContext, user: { id: string; role: Role }, remember = true): Promise<void> {
  const token = newToken();
  const id = await sha256Hex(token);
  const now = Date.now();
  const ttl = isStaff(user.role) ? STAFF_TTL_MS : PLAYER_TTL_MS;
  await c.env.DB.prepare(
    'INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
  )
    .bind(id, user.id, now, now + ttl, now, (c.req.header('User-Agent') ?? '').slice(0, 200))
    .run();
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isHttps(c),
    sameSite: 'Lax',
    path: '/',
    ...(remember ? { maxAge: ttl / 1000 } : {}),
  });
}

export async function destroySession(c: AppContext): Promise<void> {
  const user = c.get('user');
  if (user) await c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(user.session_id).run();
  deleteCookie(c, SESSION_COOKIE, { path: '/', secure: isHttps(c) });
}

type SessionJoin = SessionUser & { expires_at: number; last_seen_at: number; status: string };

/** Reads the session cookie and sets c.var.user (or null). Never throws for a bad cookie. */
export const loadSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('user', null);
  const token = getCookie(c, SESSION_COOKIE);
  if (token && token.length >= 32 && token.length <= 128) {
    const id = await sha256Hex(token);
    const row = await c.env.DB.prepare(
      `SELECT s.id AS session_id, s.expires_at, s.last_seen_at,
              u.id, u.email, u.name, u.phone, u.role, u.membership, u.member_code, u.member_until, u.status
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ?`,
    )
      .bind(id)
      .first<SessionJoin>();
    const now = Date.now();
    if (row && row.expires_at > now && row.status === 'active') {
      const { expires_at, last_seen_at, status: _status, ...user } = row;
      c.set('user', user);
      if (now - last_seen_at > TOUCH_EVERY_MS) {
        // Player sessions slide; staff sessions keep their 12-hour limit.
        const expires = isStaff(user.role) ? expires_at : now + PLAYER_TTL_MS;
        c.executionCtx.waitUntil(
          c.env.DB.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE id = ?').bind(now, expires, id).run(),
        );
      }
    } else if (row) {
      c.executionCtx.waitUntil(c.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run());
    }
  }
  await next();
};

export function requireUser(c: AppContext): SessionUser {
  const user = c.get('user');
  if (!user) throw unauthorized();
  return user;
}

export function isStaff(role: Role): boolean {
  return role === 'staff' || role === 'admin';
}

export function requireStaff(c: AppContext): SessionUser {
  const user = requireUser(c);
  if (!isStaff(user.role)) {
    c.executionCtx.waitUntil(audit(c, user.id, 'forbidden_admin_access', 'route', c.req.path));
    throw forbidden('Staff only.');
  }
  return user;
}

export function requireAdmin(c: AppContext): SessionUser {
  const user = requireStaff(c);
  if (user.role !== 'admin') throw forbidden('Only administrators can change this.');
  return user;
}

/** Fixed-window counter. Returns false when the limit is exceeded. */
export async function hitRateLimit(db: D1Database, key: string, limit: number, windowMs: number): Promise<boolean> {
  const now = Date.now();
  const row = await db
    .prepare(
      `INSERT INTO rate_limits (key, count, window_start) VALUES (?1, 1, ?2)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_start <= ?2 - ?3 THEN 1 ELSE rate_limits.count + 1 END,
         window_start = CASE WHEN rate_limits.window_start <= ?2 - ?3 THEN ?2 ELSE rate_limits.window_start END
       RETURNING count`,
    )
    .bind(key, now, windowMs)
    .first<{ count: number }>();
  return (row?.count ?? 0) <= limit;
}

export async function enforceRateLimit(db: D1Database, key: string, limit: number, windowMs: number): Promise<void> {
  if (!(await hitRateLimit(db, key, limit, windowMs))) throw tooMany();
}

export function audit(
  c: AppContext,
  actorId: string | null,
  action: string,
  entity?: string,
  entityId?: string,
  detail?: string,
): Promise<unknown> {
  return c.env.DB.prepare(
    'INSERT INTO audit_log (actor_id, action, entity, entity_id, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
  )
    .bind(actorId, action, entity ?? null, entityId ?? null, detail ?? null, clientIp(c), Date.now())
    .run()
    .catch((err) => console.error('audit failed', err));
}

export function userDTO(u: Pick<SessionUser, 'id' | 'email' | 'name' | 'phone' | 'role' | 'membership' | 'member_code' | 'member_until'>) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    phone: u.phone,
    role: u.role,
    membership: u.membership,
    memberCode: u.member_code,
    memberUntil: u.member_until,
  };
}
