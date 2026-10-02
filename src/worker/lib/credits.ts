import type { Bindings, SessionUser } from '../types';
import { conflict, notFound, unprocessable } from './errors';
import { newId } from './crypto';
import { outboxStmt, userNoticeStmt } from './notify';
import { dateLabel, peso } from './time';

/**
 * Booking credits (REBOOKING.md §5–§6): value Le Spinners owes a player after cancelling or
 * cutting short a paid booking, or that an admin issued by hand.
 *
 *   booking_credits      one row per credit: value issued, value left, origin, state
 *   credit_transactions  append-only ledger: issue +, redeem −, release +, void −, refund −
 *
 * `remaining` is never adjusted in place: every change appends ledger rows and then recomputes
 * `remaining` as SUM(amount) in the same batch. CHECK (remaining >= 0) therefore fails the whole
 * batch when two sessions try to spend the same value, and replaying a step can't drift.
 */

/** At most this many credits pay for one booking. */
export const MAX_CREDITS_PER_BOOKING = 10;
/** Upper bound for one manual credit (₱100,000). */
export const MAX_MANUAL_CREDIT = 10_000_000;

export type CreditRow = {
  id: string;
  user_id: string;
  origin: 'disruption' | 'manual';
  source_booking_id: string | null;
  disruption_id: string | null;
  amount: number;
  remaining: number;
  state: 'active' | 'expired' | 'voided';
  expires_at: number | null;
  reason: string;
  created_by: string | null;
  created_at: number;
  updated_at: number;
};

export type CreditJoin = CreditRow & {
  source_ref: string | null;
  source_date: string | null;
  source_resource: string | null;
  last_use_kind: string | null;
  reserved: number;
  user_name?: string;
  user_email?: string;
};

/** SQL expression for an id created inside a statement (ids are opaque; the prefix says what it is). */
export const SQL_ID = (prefix: string) => `'${prefix}' || lower(hex(randomblob(16)))`;

/** SQL condition: credit `alias` can be spent now. Bind `now` at `nowParam`. */
export const SPENDABLE = (alias: string, nowParam: string) =>
  `(${alias}.state = 'active' AND ${alias}.remaining > 0 AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > ${nowParam}))`;

/** SQL condition: booking `alias` still reserves the credit it used (hold running or proof waiting). */
export const RESERVING = (alias: string, nowParam: string) =>
  `(${alias}.status = 'PAYMENT_SUBMITTED' OR (${alias}.status IN ('TEMPORARY', 'REJECTED') AND ${alias}.hold_expires_at > ${nowParam}))`;

/** Credit columns plus where it came from, how it was last used and what is still reserved. Bind `now` as ?1. */
const CREDIT_SELECT = `
  SELECT c.*, sb.ref AS source_ref, sb.date AS source_date, sr.name AS source_resource,
         u.name AS user_name, u.email AS user_email,
         (SELECT t.kind FROM credit_transactions t WHERE t.credit_id = c.id AND t.kind IN ('redeem', 'refund')
           ORDER BY t.created_at DESC, t.rowid DESC LIMIT 1) AS last_use_kind,
         (SELECT COALESCE(SUM(-t.amount), 0) FROM credit_transactions t JOIN bookings rb ON rb.id = t.booking_id
           WHERE t.credit_id = c.id AND t.kind = 'redeem' AND ${RESERVING('rb', '?1')}
             AND NOT EXISTS (SELECT 1 FROM credit_transactions r WHERE r.related_txn_id = t.id AND r.kind = 'release')) AS reserved
    FROM booking_credits c
    JOIN users u ON u.id = c.user_id
    LEFT JOIN bookings sb ON sb.id = c.source_booking_id
    LEFT JOIN resources sr ON sr.id = sb.resource_id`;

const STATE_LABEL = {
  available: 'Available',
  partly_used: 'Partly used',
  used: 'Used',
  refunded: 'Refunded',
  expired: 'Expired',
  voided: 'Voided',
} as const;
type ShownState = keyof typeof STATE_LABEL;

/** What people see: available, partly used, used, refunded, expired or voided. */
function shownState(c: CreditJoin, now: number): ShownState {
  if (c.state === 'voided') return 'voided';
  if (c.state === 'expired' || (c.expires_at != null && c.expires_at <= now && c.remaining > 0)) return 'expired';
  if (c.remaining === 0) return c.last_use_kind === 'refund' ? 'refunded' : 'used';
  return c.remaining < c.amount ? 'partly_used' : 'available';
}

export function creditDTO(c: CreditJoin, now: number, forStaff = false) {
  const state = shownState(c, now);
  const dto = {
    id: c.id,
    origin: c.origin,
    amount: c.amount,
    amountLabel: peso(c.amount),
    remaining: c.remaining,
    remainingLabel: peso(c.remaining),
    /** Value a pending replacement hold is using; it comes back if that hold ends unpaid. */
    reserved: c.reserved ?? 0,
    reservedLabel: peso(c.reserved ?? 0),
    state,
    stateLabel: STATE_LABEL[state],
    spendable: state === 'available' || state === 'partly_used',
    reason: c.reason,
    source: c.source_booking_id
      ? {
          bookingId: c.source_booking_id,
          ref: c.source_ref,
          label: c.source_resource && c.source_date ? `${c.source_resource} · ${dateLabel(c.source_date)}` : null,
        }
      : null,
    issuedAt: c.created_at,
    expiresAt: c.expires_at,
  };
  if (!forStaff) return dto;
  return { ...dto, user: { id: c.user_id, name: c.user_name ?? '', email: c.user_email ?? '' }, disruptionId: c.disruption_id };
}

/** The player's credits that can be spent now: soonest-expiring first, then oldest. */
export async function spendableCredits(db: D1Database, userId: string, now: number): Promise<CreditJoin[]> {
  const { results } = await db
    .prepare(
      `${CREDIT_SELECT}
        WHERE c.user_id = ?2 AND ${SPENDABLE('c', '?1')}
        ORDER BY (c.expires_at IS NULL), c.expires_at, c.created_at, c.id`,
    )
    .bind(now, userId)
    .all<CreditJoin>();
  return results;
}

/** Total the player can spend now. */
export async function creditSummary(db: D1Database, userId: string, now: number) {
  const row = await db
    .prepare(`SELECT COALESCE(SUM(c.remaining), 0) AS total, COUNT(*) AS n FROM booking_credits c WHERE c.user_id = ?1 AND ${SPENDABLE('c', '?2')}`)
    .bind(userId, now)
    .first<{ total: number; n: number }>();
  const available = row?.total ?? 0;
  return { available, availableLabel: peso(available), count: row?.n ?? 0 };
}

/** Every credit of one player, newest first (the player's Booking credits screen). */
export async function listUserCredits(db: D1Database, userId: string, now: number) {
  const { results } = await db
    .prepare(`${CREDIT_SELECT} WHERE c.user_id = ?2 ORDER BY c.created_at DESC, c.id LIMIT 200`)
    .bind(now, userId)
    .all<CreditJoin>();
  return results;
}

/** Staff search: by player name or email, booking reference or credit id. */
export async function searchCredits(db: D1Database, q: { q?: string; state?: 'spendable' | 'all' }, now: number) {
  const where: string[] = [];
  const params: (string | number)[] = [now];
  if (q.q) {
    const like = `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    where.push(`(u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR sb.ref LIKE ? ESCAPE '\\' OR c.id = ?)`);
    params.push(like, like, like, q.q);
  }
  if (q.state === 'spendable') where.push(SPENDABLE('c', '?1'));
  const { results } = await db
    .prepare(`${CREDIT_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY c.created_at DESC, c.id LIMIT 200`)
    .bind(...params)
    .all<CreditJoin>();
  return results;
}

export async function getCredit(db: D1Database, id: string, now: number): Promise<CreditJoin> {
  const row = await db.prepare(`${CREDIT_SELECT} WHERE c.id = ?2`).bind(now, id).first<CreditJoin>();
  if (!row) throw notFound('Credit not found.');
  return row;
}

type LedgerRow = {
  id: string;
  kind: 'issue' | 'redeem' | 'release' | 'expire' | 'adjust' | 'void' | 'refund';
  amount: number;
  booking_id: string | null;
  note: string | null;
  created_at: number;
  actor_role: string;
  actor_name: string | null;
  booking_ref: string | null;
  booking_date: string | null;
  resource_name: string | null;
};

/** A credit's history, oldest first. Players see "Le Spinners" instead of staff names. */
export async function creditLedger(db: D1Database, creditId: string, forStaff: boolean) {
  const { results } = await db
    .prepare(
      `SELECT t.id, t.kind, t.amount, t.booking_id, t.note, t.created_at, t.actor_role, u.name AS actor_name,
              b.ref AS booking_ref, b.date AS booking_date, r.name AS resource_name
         FROM credit_transactions t
         LEFT JOIN users u ON u.id = t.actor_id
         LEFT JOIN bookings b ON b.id = t.booking_id
         LEFT JOIN resources r ON r.id = b.resource_id
        WHERE t.credit_id = ? ORDER BY t.created_at, t.rowid`,
    )
    .bind(creditId)
    .all<LedgerRow>();
  return results.map((t) => {
    const ref = t.booking_ref ?? '';
    const label = {
      issue: 'Credit issued',
      redeem: `Used for ${ref}`,
      release: `Returned · the hold on ${ref} ended`,
      expire: 'Expired',
      adjust: 'Adjusted',
      void: 'Voided',
      refund: 'Refund recorded',
    }[t.kind];
    return {
      id: t.id,
      kind: t.kind,
      label,
      amount: t.amount,
      amountLabel: `${t.amount < 0 ? '−' : '+'}${peso(Math.abs(t.amount))}`,
      booking: t.booking_id ? { id: t.booking_id, ref: t.booking_ref, label: t.resource_name && t.booking_date ? `${t.resource_name} · ${dateLabel(t.booking_date)}` : null } : null,
      // Void and refund notes are written for the player; staff also see who did it.
      note: t.note,
      actor: t.actor_role === 'staff' ? (forStaff ? t.actor_name ?? 'Staff' : 'Le Spinners') : t.actor_role === 'player' ? (forStaff ? 'Player' : 'You') : null,
      at: t.created_at,
    };
  });
}

export type CreditUse = { creditId: string; amount: number; sourceRef: string | null };

/** How much of each credit pays `price`: in the order given, at most MAX_CREDITS_PER_BOOKING credits. */
export function planCreditUse(credits: Pick<CreditJoin, 'id' | 'remaining' | 'source_ref'>[], price: number) {
  const uses: CreditUse[] = [];
  let left = price;
  for (const c of credits) {
    if (left <= 0 || uses.length >= MAX_CREDITS_PER_BOOKING) break;
    const take = Math.min(c.remaining, left);
    if (take > 0) {
      uses.push({ creditId: c.id, amount: take, sourceRef: c.source_ref });
      left -= take;
    }
  }
  return { uses, total: price - left };
}

/** "₱1,000 booking credit (from LS-20261003-004)". */
export function usesNote(uses: CreditUse[]): string {
  const total = uses.reduce((n, u) => n + u.amount, 0);
  const refs = [...new Set(uses.map((u) => u.sourceRef).filter(Boolean))];
  return `${peso(total)} booking credit${refs.length ? ` (from ${refs.join(', ')})` : ''}`;
}

/** D1 raises this when a statement in the batch would leave a credit below zero. */
export function isOverspend(err: unknown): boolean {
  const s = String(err);
  return s.includes('CHECK constraint failed') && s.includes('remaining');
}

// ── Statement builders (each runs inside the caller's batch) ──────────────

/** Recomputes `remaining` from the ledger for the credits `idsSql` selects (bind `params` for it). */
export function recomputeStmt(db: D1Database, idsSql: string, params: unknown[], now: number): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE booking_credits
          SET remaining = (SELECT COALESCE(SUM(t.amount), 0) FROM credit_transactions t WHERE t.credit_id = booking_credits.id),
              updated_at = ?
        WHERE id IN (${idsSql})`,
    )
    .bind(now, ...params);
}

/**
 * Spends credit on a booking inserted earlier in the same batch: one `redeem` row per credit,
 * then `remaining` recomputed. If another session spent the same value first, CHECK
 * (remaining >= 0) fails and the whole batch — booking included — rolls back.
 */
export function redeemStmts(db: D1Database, input: { bookingId: string; userId: string; uses: CreditUse[]; now: number }): D1PreparedStatement[] {
  if (!input.uses.length) return [];
  const json = JSON.stringify(input.uses.map((u) => ({ id: newId('ct_'), c: u.creditId, a: u.amount })));
  return [
    db
      .prepare(
        `INSERT INTO credit_transactions (id, credit_id, user_id, kind, amount, booking_id, actor_id, actor_role, created_at)
         SELECT json_extract(j.value, '$.id'), json_extract(j.value, '$.c'), ?2, 'redeem', -json_extract(j.value, '$.a'), ?3, ?2, 'player', ?4
           FROM json_each(?1) j
          WHERE EXISTS (SELECT 1 FROM bookings WHERE id = ?3)`,
      )
      .bind(json, input.userId, input.bookingId, input.now),
    recomputeStmt(db, `SELECT json_extract(value, '$.c') FROM json_each(?)`, [json], input.now),
  ];
}

/**
 * Returns the credit used by bookings that ended without being confirmed (hold expired, released,
 * cancelled, or the proof finally rejected). `guardSql` narrows the bookings (alias `b`, bind
 * `params`). One `release` row per `redeem` row — the unique index on related_txn_id makes a second
 * release impossible — then `remaining` recomputed, a timeline event and one player notice.
 * Safe to run any number of times; the cron runs it with no guard as a safety net.
 */
export function releaseStmts(db: D1Database, guardSql: string, params: unknown[], now: number): D1PreparedStatement[] {
  const ended = `b.confirmed_at IS NULL AND b.status IN ('EXPIRED', 'CANCELLED') AND (${guardSql})`;
  const releasedNow = `EXISTS (SELECT 1 FROM credit_transactions t WHERE t.booking_id = b.id AND t.kind = 'release' AND t.created_at = ?)`;
  return [
    db
      .prepare(
        `INSERT INTO credit_transactions (id, credit_id, user_id, kind, amount, booking_id, related_txn_id, actor_role, created_at)
         SELECT ${SQL_ID('ct_')}, t.credit_id, t.user_id, 'release', -t.amount, t.booking_id, t.id, 'system', ?
           FROM credit_transactions t JOIN bookings b ON b.id = t.booking_id
          WHERE t.kind = 'redeem' AND ${ended}
            AND NOT EXISTS (SELECT 1 FROM credit_transactions r WHERE r.related_txn_id = t.id AND r.kind = 'release')`,
      )
      .bind(now, ...params),
    recomputeStmt(
      db,
      `SELECT t.credit_id FROM credit_transactions t JOIN bookings b ON b.id = t.booking_id WHERE t.kind = 'release' AND t.created_at = ? AND ${ended}`,
      [now, ...params],
      now,
    ),
    db
      .prepare(
        `INSERT INTO booking_events (booking_id, type, actor_id, actor_role, note, created_at)
         SELECT b.id, 'credit_restored', NULL, 'system', 'Booking credit returned', ?
           FROM bookings b
          WHERE ${ended} AND ${releasedNow}
            AND NOT EXISTS (SELECT 1 FROM booking_events e WHERE e.booking_id = b.id AND e.type = 'credit_restored')`,
      )
      .bind(now, ...params, now),
    db
      .prepare(
        `INSERT INTO notifications (id, audience, user_id, booking_id, type, title, body, link, created_at)
         SELECT ${SQL_ID('n_')}, 'user', b.user_id, b.id, 'credit_restored', 'Your booking credit is back',
                b.ref || ' ended without payment, so the credit it used was returned. Use it for your next booking.', '/credits', ?
           FROM bookings b
          WHERE ${ended} AND ${releasedNow}
            AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.booking_id = b.id AND n.type = 'credit_restored')`,
      )
      .bind(now, ...params, now),
  ];
}

/** Cron safety net: returns credit for every ended, unconfirmed booking that still holds some. */
export async function reconcileCreditHolds(env: Bindings, now = Date.now()): Promise<number> {
  const db = env.DB;
  const pending = await db
    .prepare(
      `SELECT 1 FROM credit_transactions t JOIN bookings b ON b.id = t.booking_id
        WHERE t.kind = 'redeem' AND b.confirmed_at IS NULL AND b.status IN ('EXPIRED', 'CANCELLED')
          AND NOT EXISTS (SELECT 1 FROM credit_transactions r WHERE r.related_txn_id = t.id AND r.kind = 'release')
        LIMIT 1`,
    )
    .first();
  if (!pending) return 0;
  const [released] = await db.batch(releaseStmts(db, '1 = 1', [], now));
  return released?.meta.changes ?? 0;
}

// ── Admin actions ─────────────────────────────────────────────────────────

function creditNotice(db: D1Database, userId: string, title: string, body: string, now: number, guard: { sql: string; params: (string | number | null)[] }) {
  return userNoticeStmt(db, userId, { type: 'credit_changed', title, body, link: '/credits' }, now, guard);
}

/** An admin issues a credit by hand (goodwill, a legacy cancellation, a payment verified late). */
export async function issueManualCredit(
  env: Bindings,
  admin: SessionUser,
  input: { userId: string; amount: number; reason: string; sourceBookingId: string | null; idempotencyKey: string },
  now = Date.now(),
) {
  const db = env.DB;
  const existing = await db.prepare('SELECT id, user_id, amount FROM booking_credits WHERE idempotency_key = ?').bind(input.idempotencyKey).first<{ id: string; user_id: string; amount: number }>();
  if (existing) {
    if (existing.user_id !== input.userId || existing.amount !== input.amount) {
      throw conflict('IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different credit. Reload and try again.');
    }
    return existing.id;
  }
  const player = await db.prepare(`SELECT id, name, email, role FROM users WHERE id = ?`).bind(input.userId).first<{ id: string; name: string; email: string; role: string }>();
  if (!player || player.role !== 'player') throw notFound('Player not found.');
  if (input.sourceBookingId) {
    const b = await db.prepare('SELECT user_id FROM bookings WHERE id = ?').bind(input.sourceBookingId).first<{ user_id: string }>();
    if (!b || b.user_id !== input.userId) throw unprocessable('VALIDATION_ERROR', 'Please check the highlighted fields.', { sourceBookingId: ["That booking doesn't belong to this player."] });
  }
  const id = newId('cr_');
  const guard = { sql: 'EXISTS (SELECT 1 FROM booking_credits WHERE id = ?)', params: [id] };
  await db.batch([
    db
      .prepare(
        `INSERT INTO booking_credits (id, user_id, origin, source_booking_id, disruption_id, amount, remaining, state, expires_at, reason, created_by, idempotency_key, created_at, updated_at)
         VALUES (?1, ?2, 'manual', ?3, NULL, ?4, ?4, 'active', NULL, ?5, ?6, ?7, ?8, ?8)`,
      )
      .bind(id, input.userId, input.sourceBookingId, input.amount, input.reason, admin.id, input.idempotencyKey, now),
    db
      .prepare(
        `INSERT INTO credit_transactions (id, credit_id, user_id, kind, amount, booking_id, actor_id, actor_role, note, created_at)
         VALUES (?, ?, ?, 'issue', ?, ?, ?, 'staff', ?, ?)`,
      )
      .bind(newId('ct_'), id, input.userId, input.amount, input.sourceBookingId, admin.id, input.reason, now),
    creditNotice(db, input.userId, 'Booking credit added', `${peso(input.amount)} from Le Spinners · ${input.reason}`, now, guard),
    outboxStmt(db, 'email', player.email, `Le Spinners — ${peso(input.amount)} booking credit`,
      `Hi ${player.name},\n\nLe Spinners added a ${peso(input.amount)} booking credit to your account.\nReason: ${input.reason}\n\nIt isn't a cash refund. It's applied automatically the next time you book: ${env.APP_ORIGIN}/credits\n\nLe Spinners Recreational Hub`,
      input.sourceBookingId, now, guard),
    db
      .prepare(`INSERT INTO audit_log (actor_id, action, entity, entity_id, detail, ip, created_at) VALUES (?, 'credit_issued_manual', 'credit', ?, ?, NULL, ?)`)
      .bind(admin.id, id, JSON.stringify({ userId: input.userId, amount: input.amount, sourceBookingId: input.sourceBookingId }), now),
  ]);
  return id;
}

/** Void the unused balance of a credit. Refused while a pending replacement hold still uses part of it. */
export async function voidCredit(env: Bindings, admin: SessionUser, creditId: string, reason: string, now = Date.now()) {
  const db = env.DB;
  const c = await getCredit(db, creditId, now);
  const txn = newId('ct_');
  const notPending = `NOT EXISTS (SELECT 1 FROM credit_transactions t JOIN bookings rb ON rb.id = t.booking_id
                       WHERE t.credit_id = ?1 AND t.kind = 'redeem' AND ${RESERVING('rb', '?2')}
                         AND NOT EXISTS (SELECT 1 FROM credit_transactions r WHERE r.related_txn_id = t.id AND r.kind = 'release'))`;
  const guard = { sql: 'EXISTS (SELECT 1 FROM credit_transactions WHERE id = ?)', params: [txn] };
  const [ins] = await db.batch([
    db
      .prepare(
        `INSERT INTO credit_transactions (id, credit_id, user_id, kind, amount, actor_id, actor_role, note, created_at)
         SELECT ?3, c.id, c.user_id, 'void', -c.remaining, ?4, 'staff', ?5, ?2
           FROM booking_credits c
          WHERE c.id = ?1 AND c.state = 'active' AND c.remaining > 0 AND ${notPending}`,
      )
      .bind(creditId, now, txn, admin.id, reason),
    db.prepare(`UPDATE booking_credits SET state = 'voided', updated_at = ?2 WHERE id = ?1 AND EXISTS (SELECT 1 FROM credit_transactions WHERE id = ?3)`).bind(creditId, now, txn),
    recomputeStmt(db, 'SELECT ?', [creditId], now),
    creditNotice(db, c.user_id, 'Booking credit cancelled', `${peso(c.remaining)} credit removed by Le Spinners · ${reason}`, now, guard),
    db
      .prepare(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, detail, ip, created_at)
         SELECT ?, 'credit_voided', 'credit', ?, ?, NULL, ? WHERE EXISTS (SELECT 1 FROM credit_transactions WHERE id = ?)`,
      )
      .bind(admin.id, creditId, JSON.stringify({ amount: c.remaining, reason }), now, txn),
  ]);
  if (!ins?.meta.changes) {
    // A hold may have reserved all of it (remaining 0): that value comes back if the hold ends.
    const fresh = await getCredit(db, creditId, Date.now());
    if (fresh.state === 'active' && fresh.reserved > 0) {
      throw conflict('CREDIT_PENDING', 'A booking waiting for payment is using part of this credit. Wait until it is confirmed or ends, then try again.');
    }
    throw conflict('CREDIT_EMPTY', 'This credit has nothing left to void.');
  }
}

/**
 * Record a cash refund that staff paid outside the app (GCash or cash at the desk). It spends the
 * credit, so the same value can never be refunded and also used.
 */
export async function recordRefund(
  env: Bindings,
  admin: SessionUser,
  creditId: string,
  input: { amount: number; method: 'gcash' | 'cash'; reference: string | null; note: string | null },
  now = Date.now(),
) {
  const db = env.DB;
  const c = await getCredit(db, creditId, now);
  if (input.amount > c.remaining) {
    throw unprocessable('VALIDATION_ERROR', 'Please check the highlighted fields.', { amount: [`At most ${peso(c.remaining)} is left on this credit.`] });
  }
  const txn = newId('ct_');
  const how = input.method === 'gcash' ? `GCash${input.reference ? ` ref ${input.reference}` : ''}` : 'cash at the front desk';
  const note = `${how}${input.note ? ` · ${input.note}` : ''}`;
  const guard = { sql: 'EXISTS (SELECT 1 FROM credit_transactions WHERE id = ?)', params: [txn] };
  const [ins] = await db.batch([
    db
      .prepare(
        `INSERT INTO credit_transactions (id, credit_id, user_id, kind, amount, actor_id, actor_role, note, created_at)
         SELECT ?1, c.id, c.user_id, 'refund', -?2, ?3, 'staff', ?4, ?5
           FROM booking_credits c WHERE c.id = ?6 AND c.state = 'active' AND c.remaining >= ?2`,
      )
      .bind(txn, input.amount, admin.id, note, now, creditId),
    recomputeStmt(db, 'SELECT ?', [creditId], now),
    creditNotice(db, c.user_id, 'Refund recorded', `Le Spinners recorded a refund of ${peso(input.amount)} from your booking credit (${how}).`, now, guard),
    db
      .prepare(
        `INSERT INTO audit_log (actor_id, action, entity, entity_id, detail, ip, created_at)
         SELECT ?, 'refund_recorded', 'credit', ?, ?, NULL, ? WHERE EXISTS (SELECT 1 FROM credit_transactions WHERE id = ?)`,
      )
      .bind(admin.id, creditId, JSON.stringify({ amount: input.amount, method: input.method, reference: input.reference }), now, txn),
  ]);
  if (!ins?.meta.changes) throw conflict('CREDIT_CHANGED', 'This credit changed while you were recording the refund. Reload and try again.');
}
