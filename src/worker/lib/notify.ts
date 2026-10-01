import type { Bindings } from '../types';
import { newId } from './crypto';

/**
 * A guard makes a follow-up statement conditional on an earlier statement in the
 * same D1 batch having taken effect (e.g. "the booking is now CONFIRMED at this
 * exact timestamp"), so a status change and its side effects commit together.
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

type OutboxRow = { id: string; channel: 'email' | 'sms'; recipient: string; subject: string | null; body: string; attempts: number };

/**
 * Sends queued email through Resend when RESEND_API_KEY and EMAIL_FROM are set.
 * SMS stays queued until an SMS provider is connected (see README).
 */
export async function flushOutbox(env: Bindings): Promise<{ sent: number; failed: number }> {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return { sent: 0, failed: 0 };
  const { results } = await env.DB.prepare(
    `SELECT id, channel, recipient, subject, body, attempts FROM outbox
      WHERE status = 'queued' AND channel = 'email' AND attempts < 5
      ORDER BY created_at LIMIT 20`,
  ).all<OutboxRow>();
  let sent = 0;
  let failed = 0;
  for (const row of results) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: env.EMAIL_FROM, to: [row.recipient], subject: row.subject ?? 'Le Spinners', text: row.body }),
      });
      if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 200)}`);
      await env.DB.prepare(`UPDATE outbox SET status = 'sent', sent_at = ?, attempts = attempts + 1 WHERE id = ?`)
        .bind(Date.now(), row.id)
        .run();
      sent++;
    } catch (err) {
      failed++;
      const attempts = row.attempts + 1;
      await env.DB.prepare(`UPDATE outbox SET attempts = ?, last_error = ?, status = ? WHERE id = ?`)
        .bind(attempts, String(err).slice(0, 300), attempts >= 5 ? 'failed' : 'queued', row.id)
        .run();
    }
  }
  return { sent, failed };
}
