import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { MiddlewareHandler } from 'hono';
import type { AppContext, AppEnv, Role, SessionUser, UserRow } from '../types';
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
  const value = c.req.header('CF-Connecting-IP');
  if (!value || value.length > 45) return 'local';
  // CF supplies this at the edge. Ignore spoofable X-Forwarded-For/Forwarded.
  // URL parsing canonicalizes equivalent IPv6 spellings into one limiter identity.
  if (value.includes(':')) {
    try { return new URL(`http://[${value}]/`).hostname.toLowerCase(); } catch { return 'local'; }
  }
  return /^(?:\d{1,3}\.){3}\d{1,3}$/.test(value) && value.split('.').every(n => Number(n) <= 255) ? value : 'local';
}

/**
 * Starts a session. With `remember` off the cookie lasts until the browser
 * closes (shared phones); the server-side expiry still applies.
 */
export async function createSession(c: AppContext, user: Pick<UserRow, 'id' | 'role' | 'auth_version' | 'password_hash'>, remember = true): Promise<void> {
  const token = newToken();
  const id = await sha256Hex(token);
  const now = Date.now();
  const ttl = isStaff(user.role) ? STAFF_TTL_MS : PLAYER_TTL_MS;
  const db = c.env.DB;
  const statements = [db.prepare(`INSERT INTO sessions (id,user_id,created_at,expires_at,last_seen_at,user_agent,auth_version)
    SELECT ?,id,?,?,?,?,auth_version FROM users
    WHERE id=? AND role=? AND status='active' AND auth_version=? AND password_hash=?`)
    .bind(id,now,now + ttl,now,(c.req.header('User-Agent') ?? '').slice(0,200),user.id,user.role,user.auth_version,user.password_hash)];
  const previous = c.get('user');
  if (previous) statements.push(db.prepare(`DELETE FROM sessions WHERE id=? AND EXISTS (SELECT 1 FROM sessions WHERE id=?)`)
    .bind(previous.session_id,id));
  const results = await db.batch(statements);
  if (!results[0]?.meta.changes) throw new ApiError(401,'INVALID_CREDENTIALS','Email or password is incorrect.');
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

type SessionJoin = SessionUser & { expires_at: number; last_seen_at: number; status: string; session_version: number };

/** Reads the session cookie and sets c.var.user (or null). Never throws for a bad cookie. */
export const loadSession: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set('user', null);
  const token = getCookie(c, SESSION_COOKIE);
  if (token && token.length >= 32 && token.length <= 128) {
    const id = await sha256Hex(token);
    const row = await c.env.DB.prepare(
      `SELECT s.id AS session_id, s.expires_at, s.last_seen_at, s.auth_version AS session_version, u.auth_version,
              u.id, u.email, u.name, u.phone, u.role, u.membership, u.member_code, u.member_until, u.status
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.id = ?`,
    )
      .bind(id)
      .first<SessionJoin>();
    const now = Date.now();
    if (row && row.expires_at > now && row.status === 'active' && row.session_version === row.auth_version) {
      const { expires_at, last_seen_at, status: _status, session_version: _version, ...user } = row;
      c.set('user', user);
      if (now - last_seen_at > TOUCH_EVERY_MS) {
        // Player sessions slide; staff sessions keep their 12-hour limit.
        const expires = isStaff(user.role) ? expires_at : now + PLAYER_TTL_MS;
        c.executionCtx.waitUntil(
          c.env.DB.prepare(`UPDATE sessions SET last_seen_at=?,expires_at=? WHERE id=? AND auth_version=? AND last_seen_at=? AND expires_at>?
            AND EXISTS (SELECT 1 FROM users WHERE id=sessions.user_id AND status='active' AND auth_version=?)`)
            .bind(now,expires,id,user.auth_version,last_seen_at,now,user.auth_version).run(),
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

/**
 * Each role has its own sign-in page and dashboard. Users (players) book at /,
 * staff run day-to-day operations at /staff/, admins use /admin/.
 * The role always comes from the users table, never from the request.
 */
export type Portal = 'user' | 'staff' | 'admin';
export const PORTAL_ROLE: Record<Portal, Role> = { user: 'player', staff: 'staff', admin: 'admin' };
const HOME: Record<Role, string> = { player: '/', staff: '/staff/', admin: '/admin/' };

export function homeFor(role: Role): string {
  return HOME[role];
}

/** 401 without a session, 403 (logged) when the signed-in role isn't one of `roles`. */
export function requireRole(c: AppContext, roles: readonly Role[], message: string): SessionUser {
  const user = requireUser(c);
  if (!roles.includes(user.role)) {
    c.executionCtx.waitUntil(audit(c, user.id, 'forbidden_access', 'route', `${c.req.method} ${c.req.path}`, user.role));
    throw forbidden(message);
  }
  return user;
}

/** Player-only: booking, paying, the player's inbox and booking chat. */
export function requirePlayer(c: AppContext): SessionUser {
  return requireRole(c, ['player'], 'This is a staff account. Sign in with a player account to book.');
}

/** Operations (bookings, payment verification, chat, facility, availability): staff and admins. */
export function requireStaff(c: AppContext): SessionUser {
  return requireRole(c, ['staff', 'admin'], 'Staff only.');
}

/** Admin-only: global settings, GCash, prices, alert recipients, the outbox. */
export function requireAdmin(c: AppContext): SessionUser {
  return requireRole(c, ['admin'], 'Only administrators can do this.');
}

/** Hono middleware form of requireRole, for whole route namespaces. */
export function roleGuard(check: (c: AppContext) => SessionUser): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    check(c);
    await next();
  };
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
