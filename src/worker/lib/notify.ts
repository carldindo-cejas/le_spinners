import type { Bindings } from '../types';
import { newId } from './crypto';

/**
 * A guard makes a follow-up statement conditional on an earlier statement in the
 * same D1 batch having taken effect (e.g. the booking carries this request's
 * unique transition identity), so state and its side effects commit together.
 */
export type Guard = { sql: string; params: (string | number | null)[] };

function where(guard?: Guard): string {
  return guard ? ` WHERE ${guard.sql}` : '';
}

export type NoticeInput = {
  type: string;
  title: string;
  body: string;
  link?: string | null;
  bookingId?: string | null;
};

/** In-app notification for one player. */
export function userNoticeStmt(db: D1Database, userId: string, n: NoticeInput, now: number, guard?: Guard): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO notifications (id, audience, user_id, booking_id, type, title, body, link, created_at)
       SELECT ?, 'user', ?, ?, ?, ?, ?, ?, ?${where(guard)}`,
    )
    .bind(newId('n_'), userId, n.bookingId ?? null, n.type, n.title, n.body, n.link ?? null, now, ...(guard?.params ?? []));
}

/** Shared staff notification center entry. */
export function staffNoticeStmt(db: D1Database, n: NoticeInput, now: number, guard?: Guard): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO notifications (id, audience, user_id, booking_id, type, title, body, link, created_at)
       SELECT ?, 'staff', NULL, ?, ?, ?, ?, ?, ?${where(guard)}`,
    )
    .bind(newId('n_'), n.bookingId ?? null, n.type, n.title, n.body, n.link ?? null, now, ...(guard?.params ?? []));
}

/** Marks staff notifications about a booking as handled (drops them from the unresolved count). */
export function resolveStaffStmt(db: D1Database, bookingId: string, types: string[], now: number, guard?: Guard): D1PreparedStatement {
  const placeholders = types.map(() => '?').join(', ');
  return db
    .prepare(
      `UPDATE notifications SET resolved_at = ?, read_at = COALESCE(read_at, ?)
        WHERE audience = 'staff' AND booking_id = ? AND resolved_at IS NULL AND type IN (${placeholders})${guard ? ` AND ${guard.sql}` : ''}`,
    )
    .bind(now, now, bookingId, ...types, ...(guard?.params ?? []));
}

export function outboxStmt(
  db: D1Database,
  channel: 'email' | 'sms',
  recipient: string,
  subject: string | null,
  body: string,
  bookingId: string | null,
  now: number,
  guard?: Guard,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO outbox (id, channel, recipient, subject, body, status, booking_id, created_at)
       SELECT ?, ?, ?, ?, ?, 'queued', ?, ?${where(guard)}`,
    )
    .bind(newId('o_'), channel, recipient, subject, body, bookingId, now, ...(guard?.params ?? []));
}

export { flushOutbox } from './outbox';
