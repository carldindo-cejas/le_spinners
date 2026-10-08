import * as z from 'zod';
import type { AppContext, SessionUser, UserRow } from '../types';
import { clientIp, enforceRateLimit, passwordPepper } from './auth';
import { zClientHash, zEmail, zName, zNewPassword } from './auth-validation';
import { authorizedBatch } from './authorized-mutations';
import { newId, PASSWORD_ITERATIONS, PASSWORD_SCHEME, pepperHash, verifyClientHash } from './crypto';
import { ApiError, conflict, notFound } from './errors';
import { afterPage, pageRequest, pageResult } from './pagination';

const zStatus = z.enum(['active', 'disabled']);
const stamp = {
  expectedAuthVersion: z.number().int().min(1),
  expectedUpdatedAt: z.number().int().nonnegative(),
};
export const staffCreateSchema = z.strictObject({ name: zName, email: zEmail, password: zNewPassword, status: zStatus.default('active') });
export const staffUpdateSchema = z.strictObject({ ...stamp, name: zName.optional(), email: zEmail.optional(), status: zStatus.optional() })
  .refine(body => body.name !== undefined || body.email !== undefined || body.status !== undefined, 'Supply a name, email or status change.');
export const staffResetSchema = z.strictObject({ ...stamp, currentClientHash: zClientHash, newPassword: zNewPassword });
export const staffListSchema = z.object({ q: z.string().trim().max(254).default(''), status: zStatus.optional(), limit: z.string().optional(), cursor: z.string().optional() });

type StaffRow = Pick<UserRow, 'id' | 'name' | 'email' | 'role' | 'status' | 'created_at' | 'updated_at' | 'auth_version'>;
const COLUMNS = 'id,name,email,role,status,created_at,updated_at,auth_version';
export function staffDTO(row: StaffRow) {
  return { id: row.id, name: row.name, email: row.email, role: row.role, status: row.status,
    createdAt: row.created_at, updatedAt: row.updated_at, authVersion: row.auth_version };
}
const emailTaken = () => conflict('EMAIL_TAKEN', 'An account with this email already exists.', { email: ['Already registered. Use a different email.'] });
function duplicate(error: unknown): never {
  if (/UNIQUE.*users\.email/i.test(String(error))) throw emailTaken();
  throw error;
}
const changed = () => conflict('ACCOUNT_CHANGED', 'This account changed. Refresh the list and try again.');
async function target(db: D1Database, id: string) {
  const row = await db.prepare("SELECT * FROM users WHERE id=? AND role='staff'").bind(id).first<UserRow>();
  if (!row) throw notFound('Staff account not found.');
  return row;
}
function checkStamp(row: UserRow, body: z.infer<typeof staffResetSchema> | z.infer<typeof staffUpdateSchema>) {
  if (row.auth_version !== body.expectedAuthVersion || row.updated_at !== body.expectedUpdatedAt) throw changed();
}
function auditStmt(c: AppContext, actor: SessionUser, action: string, id: string, changeId: string, now: number, detail: string | null = null) {
  return c.env.DB.prepare(`INSERT INTO audit_log(actor_id,action,entity,entity_id,detail,ip,created_at)
    SELECT ?,?,'user',?,?,?,? WHERE EXISTS (SELECT 1 FROM users WHERE id=? AND role='staff' AND auth_change_id=?)`)
    .bind(actor.id, action, id, detail, clientIp(c), now, id, changeId);
}
async function saved(db: D1Database, id: string) {
  const row = await db.prepare(`SELECT ${COLUMNS} FROM users WHERE id=? AND role='staff'`).bind(id).first<StaffRow>();
  if (!row) throw notFound('Staff account not found.');
  return staffDTO(row);
}

export async function listStaff(c: AppContext, actor: SessionUser, filters: z.infer<typeof staffListSchema>) {
  const db = c.env.DB;
  const page = pageRequest({ ...filters, limit: filters.limit ?? '25' }, JSON.stringify(['staff', actor.id, filters.q, filters.status ?? 'all']), ['number', 'string']);
  const after = afterPage(page, ['created_at', 'id']);
  const where = ["role='staff'", 'created_at<=?'];
  const params: (string | number)[] = [page.asOf];
  if (filters.status) { where.push('status=?'); params.push(filters.status); }
  if (filters.q) {
    where.push("(name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')");
    const term = '%' + filters.q.replace(/[\\%_]/g, '\\$&') + '%';
    params.push(term, term);
  }
  if (after.sql) { where.push(after.sql); params.push(...after.params); }
  const { results } = await db.prepare(`SELECT ${COLUMNS} FROM users WHERE ${where.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT ?`)
    .bind(...params, page.limit + 1).all<StaffRow>();
  const result = pageResult(results, page, row => [row.created_at, row.id]);
  return { staff: result.rows.map(staffDTO), page: result.page };
}

export async function createStaff(c: AppContext, actor: SessionUser, body: z.infer<typeof staffCreateSchema>) {
  const db = c.env.DB;
  await enforceRateLimit(db, `staff-create:${actor.id}`, 60, 60 * 60_000);
  const hash = await pepperHash(passwordPepper(c), body.password.clientHash);
  const id = newId('u_'), changeId = newId('auth_'), now = Date.now();
  try {
    await authorizedBatch(db, actor, [
      db.prepare(`INSERT INTO users(id,name,email,password_hash,password_salt,password_iterations,password_scheme,role,membership,status,auth_change_id,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,'staff','none',?,?,?,?)`)
        .bind(id, body.name, body.email, hash, body.password.salt, PASSWORD_ITERATIONS, PASSWORD_SCHEME, body.status, changeId, now, now),
      auditStmt(c, actor, 'staff_created', id, changeId, now),
    ], ['admin']);
  } catch (error) { duplicate(error); }
  return saved(db, id);
}

export async function updateStaff(c: AppContext, actor: SessionUser, id: string, body: z.infer<typeof staffUpdateSchema>) {
  const db = c.env.DB, row = await target(db, id);
  checkStamp(row, body);
  const revoke = (body.email !== undefined && body.email !== row.email) || (body.status !== undefined && body.status !== row.status);
  const now = Math.max(Date.now(), row.updated_at + 1), changeId = newId('auth_');
  const actions: string[] = [];
  if (body.name !== undefined || body.email !== undefined) actions.push('staff_updated');
  if (body.status !== undefined && body.status !== row.status) actions.push(body.status === 'active' ? 'staff_activated' : 'staff_deactivated');
  let results: D1Result[];
  try {
    results = await authorizedBatch(db, actor, [
      db.prepare(`UPDATE users SET name=COALESCE(?,name),email=COALESCE(?,email),status=COALESCE(?,status),auth_change_id=?,updated_at=?
        WHERE id=? AND role='staff' AND auth_version=? AND updated_at=?`)
        .bind(body.name ?? null, body.email ?? null, body.status ?? null, changeId, now, id, body.expectedAuthVersion, body.expectedUpdatedAt),
      ...(revoke ? [db.prepare(`DELETE FROM sessions WHERE user_id=? AND EXISTS (SELECT 1 FROM users WHERE id=? AND auth_change_id=?)`).bind(id, id, changeId)] : []),
      ...actions.map(action => auditStmt(c, actor, action, id, changeId, now)),
    ], ['admin']);
  } catch (error) { duplicate(error); }
  if (!results![0]?.meta.changes) throw changed();
  return saved(db, id);
}

export async function resetStaffPassword(c: AppContext, actor: SessionUser, id: string, body: z.infer<typeof staffResetSchema>) {
  const db = c.env.DB;
  await enforceRateLimit(db, `staff-reset:admin:${actor.id}`, 5, 15 * 60_000);
  await enforceRateLimit(db, `staff-reset:target:${id}`, 10, 15 * 60_000);
  const row = await target(db, id);
  checkStamp(row, body);
  const pepper = passwordPepper(c);
  const admin = await db.prepare("SELECT password_hash FROM users WHERE id=? AND role='admin' AND status='active' AND auth_version=?")
    .bind(actor.id, actor.auth_version).first<{ password_hash: string }>();
  if (!(await verifyClientHash(pepper, body.currentClientHash, admin?.password_hash ?? null))) {
    throw new ApiError(422, 'VALIDATION_ERROR', 'Please check the highlighted fields.', { currentPassword: ['Your administrator password is incorrect.'] });
  }
  if (body.newPassword.salt === row.password_salt) throw new ApiError(422, 'VALIDATION_ERROR', 'Please generate fresh password credentials.');
  const hash = await pepperHash(pepper, body.newPassword.clientHash);
  const now = Math.max(Date.now(), row.updated_at + 1), changeId = newId('auth_');
  const results = await authorizedBatch(db, actor, [
    db.prepare(`UPDATE users SET password_hash=?,password_salt=?,password_iterations=?,password_scheme=?,auth_change_id=?,updated_at=?
      WHERE id=? AND role='staff' AND auth_version=? AND updated_at=?`)
      .bind(hash, body.newPassword.salt, PASSWORD_ITERATIONS, PASSWORD_SCHEME, changeId, now, id, body.expectedAuthVersion, body.expectedUpdatedAt),
    db.prepare(`DELETE FROM sessions WHERE user_id=? AND EXISTS (SELECT 1 FROM users WHERE id=? AND auth_change_id=?)`).bind(id, id, changeId),
    auditStmt(c, actor, 'staff_password_reset', id, changeId, now),
  ], ['admin']);
  if (!results[0]?.meta.changes) throw changed();
  return saved(db, id);
}
