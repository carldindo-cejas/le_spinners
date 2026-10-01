import type { Bindings, SessionUser } from '../types';
import { SEGMENTS_SQL, type BookingJoin } from './bookings';
import { newId } from './crypto';
import { resolveStaffStmt } from './notify';
import { proofLink } from './payments';

/**
 * Booking chat: one private thread per booking between its player and staff.
 * Callers must check access (owner or staff) before using these helpers.
 */

export type ChatSide = 'player' | 'staff';
export const MESSAGE_MAX_CHARS = 1000;

type MessageRow = {
  id: string;
  sender_id: string | null;
  sender_role: 'player' | 'staff' | 'system';
  kind: 'text' | 'system' | 'proof';
  body: string;
  proof_id: string | null;
  created_at: number;
  sender_name: string | null;
  proof_status: 'submitted' | 'approved' | 'rejected' | null;
};

function firstName(name: string | null): string {
  return (name ?? '').trim().split(/\s+/)[0] || 'Staff';
}

export async function listMessages(env: Bindings, bookingId: string, viewer: { side: ChatSide; userId: string }, now = Date.now()) {
  const { results } = await env.DB.prepare(
    `SELECT m.id, m.sender_id, m.sender_role, m.kind, m.body, m.proof_id, m.created_at,
            u.name AS sender_name, p.status AS proof_status
       FROM messages m
       LEFT JOIN users u ON u.id = m.sender_id
       LEFT JOIN payment_proofs p ON p.id = m.proof_id
      WHERE m.booking_id = ?
      ORDER BY m.created_at DESC, m.rowid DESC
      LIMIT 200`,
  )
    .bind(bookingId)
    .all<MessageRow>();
  results.reverse();

  const out = [];
  for (const m of results) {
    let senderName: string | null = null;
    if (m.sender_role === 'staff') senderName = viewer.side === 'player' ? `${firstName(m.sender_name)} · Le Spinners` : m.sender_name ?? 'Staff';
    else if (m.sender_role === 'player') senderName = viewer.side === 'player' ? 'You' : m.sender_name ?? 'Player';
    const dto: {
      id: string;
      kind: MessageRow['kind'];
      body: string;
      sender: MessageRow['sender_role'];
      senderName: string | null;
      mine: boolean;
      createdAt: number;
      proof?: { id: string; status: MessageRow['proof_status']; url: string; expiresAt: number };
    } = {
      id: m.id,
      kind: m.kind,
      body: m.body,
      sender: m.sender_role,
      senderName,
      mine: m.sender_id != null && m.sender_id === viewer.userId,
      createdAt: m.created_at,
    };
    if (m.kind === 'proof' && m.proof_id) {
      dto.proof = { id: m.proof_id, status: m.proof_status, ...(await proofLink(env, m.proof_id, now)) };
    }
    out.push(dto);
  }
  return out;
}

/** Moves the reader's marker up to the newest message from the other side. */
export async function markRead(env: Bindings, bookingId: string, side: ChatSide, userId: string, now = Date.now()) {
  const db = env.DB;
  const other: ChatSide = side === 'player' ? 'staff' : 'player';
  const row = await db
    .prepare(
      `SELECT (SELECT MAX(created_at) FROM messages WHERE booking_id = ?1 AND sender_role = ?2) AS latest,
              (SELECT last_read_at FROM message_reads WHERE booking_id = ?1 AND reader = ?3) AS read_at`,
    )
    .bind(bookingId, other, side)
    .first<{ latest: number | null; read_at: number | null }>();
  if (!row?.latest || (row.read_at ?? 0) >= row.latest) return;
  await db.batch([
    db
      .prepare(
        `INSERT INTO message_reads (booking_id, reader, last_read_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (booking_id, reader) DO UPDATE SET last_read_at = MAX(last_read_at, excluded.last_read_at)`,
      )
      .bind(bookingId, side, row.latest),
    side === 'player'
      ? db
          .prepare(`UPDATE notifications SET read_at = ? WHERE audience = 'user' AND user_id = ? AND booking_id = ? AND type = 'new_message' AND read_at IS NULL`)
          .bind(now, userId, bookingId)
      : resolveStaffStmt(db, bookingId, ['new_message'], now),
  ]);
}

/**
 * Adds a text message and notifies the other side. Repeated messages update one
 * pending notification instead of stacking a new one per message.
 */
export async function postMessage(env: Bindings, author: SessionUser, side: ChatSide, booking: BookingJoin, body: string, now = Date.now()) {
  const db = env.DB;
  const id = newId('m_');
  const preview = body.length > 90 ? `${body.slice(0, 87).trimEnd()}…` : body;
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(`INSERT INTO messages (id, booking_id, sender_id, sender_role, kind, body, created_at) VALUES (?, ?, ?, ?, 'text', ?, ?)`)
      .bind(id, booking.id, author.id, side, body, now),
    db
      .prepare(
        `INSERT INTO message_reads (booking_id, reader, last_read_at) VALUES (?1, ?2, ?3)
         ON CONFLICT (booking_id, reader) DO UPDATE SET last_read_at = MAX(last_read_at, excluded.last_read_at)`,
      )
      .bind(booking.id, side, now),
  ];

  if (side === 'player') {
    const title = `New message from ${author.name}`;
    const text = `“${preview}” · ${booking.ref}`;
    stmts.push(
      db
        .prepare(
          `UPDATE notifications SET title = ?1, body = ?2, created_at = ?3, read_at = NULL
            WHERE audience = 'staff' AND booking_id = ?4 AND type = 'new_message' AND resolved_at IS NULL`,
        )
        .bind(title, text, now, booking.id),
      db
        .prepare(
          `INSERT INTO notifications (id, audience, user_id, booking_id, type, title, body, link, created_at)
           SELECT ?1, 'staff', NULL, ?2, 'new_message', ?3, ?4, ?5, ?6
            WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE audience = 'staff' AND booking_id = ?2 AND type = 'new_message' AND resolved_at IS NULL)`,
        )
        .bind(newId('n_'), booking.id, title, text, `/admin/messages/${booking.id}`, now),
    );
  } else {
    const title = 'New message from Le Spinners';
    const text = `“${preview}” · ${booking.resource_name}`;
    stmts.push(
      db
        .prepare(
          `UPDATE notifications SET title = ?1, body = ?2, created_at = ?3
            WHERE audience = 'user' AND user_id = ?4 AND booking_id = ?5 AND type = 'new_message' AND read_at IS NULL`,
        )
        .bind(title, text, now, booking.user_id, booking.id),
      db
        .prepare(
          `INSERT INTO notifications (id, audience, user_id, booking_id, type, title, body, link, created_at)
           SELECT ?1, 'user', ?2, ?3, 'new_message', ?4, ?5, ?6, ?7
            WHERE NOT EXISTS (SELECT 1 FROM notifications WHERE audience = 'user' AND user_id = ?2 AND booking_id = ?3 AND type = 'new_message' AND read_at IS NULL)`,
        )
        .bind(newId('n_'), booking.user_id, booking.id, title, text, `/bookings/${booking.id}/chat`, now),
      resolveStaffStmt(db, booking.id, ['new_message'], now),
    );
  }
  await db.batch(stmts);
  return id;
}

/** Bookings of this player with staff messages they haven't opened. */
export async function playerUnreadChats(db: D1Database, userId: string): Promise<Map<string, number>> {
  const { results } = await db
    .prepare(
      `SELECT m.booking_id, COUNT(*) AS n
         FROM messages m
         JOIN bookings b ON b.id = m.booking_id
         LEFT JOIN message_reads r ON r.booking_id = m.booking_id AND r.reader = 'player'
        WHERE b.user_id = ? AND m.sender_role = 'staff' AND m.kind = 'text' AND m.created_at > COALESCE(r.last_read_at, 0)
        GROUP BY m.booking_id`,
    )
    .bind(userId)
    .all<{ booking_id: string; n: number }>();
  return new Map(results.map((r) => [r.booking_id, r.n]));
}

/** Conversations with player messages no staff member has opened yet. */
export async function staffUnreadChats(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(DISTINCT m.booking_id) AS n
         FROM messages m
         LEFT JOIN message_reads r ON r.booking_id = m.booking_id AND r.reader = 'staff'
        WHERE m.sender_role = 'player' AND m.kind = 'text' AND m.created_at > COALESCE(r.last_read_at, 0)`,
    )
    .first<{ n: number }>();
  return row?.n ?? 0;
}

type ConversationRow = {
  id: string;
  ref: string;
  status: string;
  hold_expires_at: number | null;
  date: string;
  start_min: number;
  end_min: number;
  segments_json: string | null;
  resource_name: string;
  activity: string;
  user_name: string;
  last_body: string;
  last_kind: string;
  last_sender: string;
  last_at: number;
  unread: number;
};

/** Staff inbox: every booking thread with at least one player or staff message. */
export async function staffConversations(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT b.id, b.ref, b.status, b.hold_expires_at, b.date, b.start_min, b.end_min, ${SEGMENTS_SQL('b')},
              r.name AS resource_name, r.activity, u.name AS user_name,
              lm.body AS last_body, lm.kind AS last_kind, lm.sender_role AS last_sender, lm.created_at AS last_at,
              (SELECT COUNT(*) FROM messages x
                WHERE x.booking_id = b.id AND x.sender_role = 'player' AND x.kind = 'text'
                  AND x.created_at > COALESCE(rd.last_read_at, 0)) AS unread
         FROM bookings b
         JOIN resources r ON r.id = b.resource_id
         JOIN users u ON u.id = b.user_id
         JOIN messages lm ON lm.id = (SELECT id FROM messages WHERE booking_id = b.id AND kind != 'system' ORDER BY created_at DESC, rowid DESC LIMIT 1)
         LEFT JOIN message_reads rd ON rd.booking_id = b.id AND rd.reader = 'staff'
        ORDER BY lm.created_at DESC
        LIMIT 100`,
    )
    .all<ConversationRow>();
  return results;
}
