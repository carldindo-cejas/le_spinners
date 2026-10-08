import type { Role, SessionUser } from '../types';
import { ApiError, forbidden, unauthorized } from './errors';

/** Recheck the actor inside the same transaction as every dependent effect. */
export async function authorizedBatch(
  db: D1Database, actor: SessionUser, statements: D1PreparedStatement[],
  roles: readonly Role[] = ['staff', 'admin'],
): Promise<D1Result[]> {
  if (!roles.includes(actor.role)) throw forbidden();
  const assertion = db.prepare(`INSERT INTO mutation_authorization_guard(id,allowed)
    VALUES (1,CASE WHEN EXISTS (
      SELECT 1 FROM users u JOIN sessions s ON s.user_id=u.id
      WHERE u.id=? AND u.status='active' AND u.role=? AND u.auth_version=?
        AND s.id=? AND s.auth_version=u.auth_version AND s.expires_at>?
    ) THEN 1 ELSE 0 END)
    ON CONFLICT(id) DO UPDATE SET allowed=excluded.allowed`)
    .bind(actor.id, actor.role, actor.auth_version, actor.session_id, Date.now());
  try {
    const results = await db.batch([assertion, ...statements]);
    return results.slice(1);
  } catch (error) {
    if (String(error).includes('mutation_authorized')) throw unauthorized('Your account or session changed. Please sign in again.');
    if (/no such table:\s*(?:main\.)?mutation_authorization_guard\b/i.test(String(error))) {
      console.error(JSON.stringify({ msg: 'required mutation authorization migration missing', migration: '0021_staff_account_management.sql' }));
      throw new ApiError(503, 'OPERATIONS_UNAVAILABLE', 'Staff operations are temporarily unavailable. Please contact the administrator.');
    }
    throw error;
  }
}
