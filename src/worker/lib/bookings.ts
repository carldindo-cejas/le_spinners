import type { Activity, Bindings, BookingRow, BookingStatus, ResourceRow, SessionUser } from '../types';
import { conflict, notFound, unprocessable } from './errors';
import { newId } from './crypto';
import { outboxStmt, resolveStaffStmt, staffNoticeStmt, userNoticeStmt, type Guard } from './notify';
import type { Settings } from './settings';
import {
  addDays,
  dateLabel,
  daysBetween,
  localNow,
  localToMs,
  minutesLabel,
  offsetMinutes,
  peso,
  weekdayOf,
} from './time';

/** SQL condition: booking row `b` currently occupies its slot. Bind `now` where `?NOW` appears. */
export const OCCUPYING = (alias: string, nowParam: string) =>
  `(${alias}.status IN ('PAYMENT_SUBMITTED', 'CONFIRMED') OR (${alias}.status IN ('TEMPORARY', 'REJECTED') AND ${alias}.hold_expires_at > ${nowParam}))`;

export const MAX_OPEN_HOLDS = 2;

export type BookingJoin = BookingRow & {
  resource_name: string;
  activity: Activity;
  user_name?: string;
  user_email?: string;
  user_phone?: string | null;
  user_membership?: string;
  confirmed_by_name?: string | null;
  rejected_by_name?: string | null;
};

export const BOOKING_SELECT = `
  SELECT b.*, r.name AS resource_name, r.activity AS activity,
         u.name AS user_name, u.email AS user_email, u.phone AS user_phone, u.membership AS user_membership,
         cu.name AS confirmed_by_name, ru.name AS rejected_by_name
    FROM bookings b
    JOIN resources r ON r.id = b.resource_id
    JOIN users u ON u.id = b.user_id
    LEFT JOIN users cu ON cu.id = b.confirmed_by
    LEFT JOIN users ru ON ru.id = b.rejected_by`;

export function effectiveStatus(b: Pick<BookingRow, 'status' | 'hold_expires_at'>, now: number): BookingStatus {
  if ((b.status === 'TEMPORARY' || b.status === 'REJECTED') && (b.hold_expires_at ?? 0) <= now) return 'EXPIRED';
  return b.status;
}

export function activityLabel(a: Activity): string {
  return a === 'pickleball' ? 'Pickleball' : 'Table Tennis';
}

export function slotLabel(b: Pick<BookingRow, 'start_min' | 'end_min'>): string {
  return `${minutesLabel(b.start_min)} – ${minutesLabel(b.end_min)}`;
}

export function bookingDTO(b: BookingJoin, now: number, settings: Settings, offsetMin: number, forStaff = false) {
  const status = effectiveStatus(b, now);
  const startsAt = localToMs(b.date, b.start_min, offsetMin);
  const cancelDeadline = startsAt - settings.cancelCutoffHours * 3_600_000;
  const holding = status === 'TEMPORARY' || status === 'REJECTED';
  const dto = {
    id: b.id,
    ref: b.ref,
    status,
    activity: b.activity,
    activityLabel: activityLabel(b.activity),
    resource: { id: b.resource_id, name: b.resource_name },
    date: b.date,
    dateLabel: dateLabel(b.date),
    start: b.start_min,
    end: b.end_min,
    timeLabel: slotLabel(b),
    startsAt,
    amountDue: b.amount_due,
    amountLabel: peso(b.amount_due),
    rate: b.rate,
    holdExpiresAt: holding ? b.hold_expires_at : null,
    submittedAt: b.submitted_at,
    confirmedAt: b.confirmed_at,
    rejectedAt: b.rejected_at,
    rejectReason: b.reject_reason,
    cancelledAt: b.cancelled_at,
    cancelReason: b.cancel_reason,
    createdAt: b.created_at,
    canSubmitProof: holding && (b.hold_expires_at ?? 0) > now,
    canRelease: holding && (b.hold_expires_at ?? 0) > now,
    canCancel: status === 'CONFIRMED' && now < cancelDeadline,
    cancelDeadline,
  };
  if (!forStaff) return dto;
  return {
    ...dto,
    user: {
      id: b.user_id,
      name: b.user_name ?? '',
      email: b.user_email ?? '',
      phone: b.user_phone ?? null,
      membership: b.user_membership ?? 'none',
    },
    confirmedBy: b.confirmed_by_name ?? null,
    rejectedBy: b.rejected_by_name ?? null,
  };
}

export async function getBooking(db: D1Database, id: string): Promise<BookingJoin> {
  const row = await db.prepare(`${BOOKING_SELECT} WHERE b.id = ?`).bind(id).first<BookingJoin>();
  if (!row) throw notFound('Booking not found.');
  return row;
}

// ── Statement builders ──────────────────────────────────────────────────────

export function eventStmt(
  db: D1Database,
  bookingId: string,
  type: string,
  actorId: string | null,
  actorRole: 'player' | 'staff' | 'system',
  note: string | null,
  now: number,
  guard?: Guard,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO booking_events (booking_id, type, actor_id, actor_role, note, created_at)
       SELECT ?, ?, ?, ?, ?, ?${guard ? ` WHERE ${guard.sql}` : ''}`,
    )
    .bind(bookingId, type, actorId, actorRole, note, now, ...(guard?.params ?? []));
}

export function systemMessageStmt(db: D1Database, bookingId: string, body: string, now: number, guard?: Guard): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO messages (id, booking_id, sender_id, sender_role, kind, body, created_at)
       SELECT ?, ?, NULL, 'system', 'system', ?, ?${guard ? ` WHERE ${guard.sql}` : ''}`,
    )
    .bind(newId('m_'), bookingId, body, now, ...(guard?.params ?? []));
}

/** Guard: the booking has `column` set to exactly `now` (set by the batch's first UPDATE). */
export function changedAt(bookingId: string, column: 'submitted_at' | 'confirmed_at' | 'rejected_at' | 'cancelled_at', now: number): Guard {
  return { sql: `EXISTS (SELECT 1 FROM bookings WHERE id = ? AND ${column} = ?)`, params: [bookingId, now] };
}

async function resourceNames(db: D1Database): Promise<Map<string, string>> {
  const { results } = await db.prepare('SELECT id, name FROM resources').all<{ id: string; name: string }>();
  return new Map(results.map((r) => [r.id, r.name]));
}

// ── Time-driven transitions (cron + lazily on reads) ───────────────────────

type ExpiredRow = { id: string; user_id: string; rejected_at: number | null; resource_id: string; date: string; start_min: number };

/** Expires unpaid holds and closed resubmit windows. Safe to call often; only acts on changed rows. */
export async function sweepExpired(env: Bindings, now = Date.now()): Promise<number> {
  const db = env.DB;
  const pending = await db
    .prepare(`SELECT 1 FROM bookings WHERE status IN ('TEMPORARY', 'REJECTED') AND hold_expires_at <= ? LIMIT 1`)
    .bind(now)
    .first();
  if (!pending) return 0;
  const { results } = await db
    .prepare(
      `UPDATE bookings SET status = 'EXPIRED', updated_at = ?1
        WHERE status IN ('TEMPORARY', 'REJECTED') AND hold_expires_at IS NOT NULL AND hold_expires_at <= ?1
       RETURNING id, user_id, rejected_at, resource_id, date, start_min`,
    )
    .bind(now)
    .all<ExpiredRow>();
  if (!results.length) return 0;
  const names = await resourceNames(db);
  const stmts: D1PreparedStatement[] = [];
  for (const b of results) {
    const wasRejected = b.rejected_at != null;
    const where = `${names.get(b.resource_id) ?? 'Your slot'} · ${dateLabel(b.date)} · ${minutesLabel(b.start_min)}`;
    stmts.push(
      eventStmt(db, b.id, 'expired', null, 'system', wasRejected ? 'No new proof before the resubmit window ended' : 'No payment proof before the hold ended', now),
      systemMessageStmt(db, b.id, wasRejected ? 'Resubmit window ended · booking expired' : 'Hold ended · booking expired', now),
      userNoticeStmt(db, b.user_id, { type: 'booking_expired', title: 'Booking expired', body: `${where} · the slot was released`, link: `/bookings/${b.id}`, bookingId: b.id }, now),
      resolveStaffStmt(db, b.id, ['new_booking', 'hold_expiring', 'proof_submitted'], now),
    );
  }
  await db.batch(stmts);
  return results.length;
}

/** One in-app warning when a hold has `warnMinutes` left. */
export async function warnExpiringHolds(env: Bindings, settings: Settings, now = Date.now()): Promise<number> {
  const db = env.DB;
  const { results } = await db
    .prepare(
      `UPDATE bookings SET warned_at = ?1
        WHERE status = 'TEMPORARY' AND warned_at IS NULL AND hold_expires_at > ?1 AND hold_expires_at <= ?1 + ?2
       RETURNING id, user_id, resource_id, date, start_min, hold_expires_at`,
    )
    .bind(now, settings.warnMinutes * 60_000)
    .all<ExpiredRow & { hold_expires_at: number }>();
  if (!results.length) return 0;
  const names = await resourceNames(db);
  const stmts: D1PreparedStatement[] = [];
  for (const b of results) {
    const name = names.get(b.resource_id) ?? 'your slot';
    stmts.push(
      userNoticeStmt(db, b.user_id, {
        type: 'hold_expiring',
        title: 'Your temporary reservation will expire soon',
        body: `Upload your payment proof in the next ${settings.warnMinutes} minutes to keep ${name}.`,
        link: `/bookings/${b.id}/pay`,
        bookingId: b.id,
      }, now),
      staffNoticeStmt(db, {
        type: 'hold_expiring',
        title: 'Payment window expiring',
        body: `${name} · ${dateLabel(b.date)} · ${minutesLabel(b.start_min)} · no proof yet`,
        link: `/admin/bookings/${b.id}`,
        bookingId: b.id,
      }, now),
    );
  }
  await db.batch(stmts);
  return results.length;
}

/** CONFIRMED bookings whose hour is over become COMPLETED. */
export async function completePast(env: Bindings, now = Date.now()): Promise<number> {
  const local = localNow(offsetMinutes(env.TZ_OFFSET_MINUTES), now);
  const { results } = await env.DB.prepare(
    `UPDATE bookings SET status = 'COMPLETED', updated_at = ?1
      WHERE status = 'CONFIRMED' AND (date < ?2 OR (date = ?2 AND end_min <= ?3))
     RETURNING id`,
  )
    .bind(now, local.date, local.minutes)
    .all<{ id: string }>();
  if (results.length) {
    await env.DB.batch(results.map((r) => eventStmt(env.DB, r.id, 'completed', null, 'system', null, now)));
  }
  return results.length;
}

// ── Creating a hold ────────────────────────────────────────────────────────

export function underMaintenance(r: Pick<ResourceRow, 'status' | 'maintenance_until'>, date: string): boolean {
  if (r.status !== 'maintenance') return false;
  return !r.maintenance_until || date < r.maintenance_until;
}

export type HoursRow = { weekday: number; is_open: number; open_min: number; close_min: number };
export type ClosureRow = { id: string; date: string; resource_id: string | null; start_min: number | null; end_min: number | null; reason: string | null };

export function closureCovers(c: ClosureRow, resourceId: string, start: number, end: number): boolean {
  if (c.resource_id && c.resource_id !== resourceId) return false;
  if (c.start_min == null || c.end_min == null) return true;
  return c.start_min < end && c.end_min > start;
}

export async function createHold(
  env: Bindings,
  settings: Settings,
  user: SessionUser,
  input: { resourceId: string; date: string; start: number },
  now = Date.now(),
) {
  const db = env.DB;
  const offset = offsetMinutes(env.TZ_OFFSET_MINUTES);
  const local = localNow(offset, now);
  const { resourceId, date, start } = input;

  const resource = await db.prepare('SELECT * FROM resources WHERE id = ?').bind(resourceId).first<ResourceRow>();
  if (!resource || resource.status === 'disabled') throw unprocessable('RESOURCE_UNAVAILABLE', 'That court or table is not available.');
  if (underMaintenance(resource, date)) {
    const until = resource.maintenance_until ? ` until ${dateLabel(resource.maintenance_until)}` : '';
    throw unprocessable('MAINTENANCE', `${resource.name} is under maintenance${until}.`);
  }

  const ahead = daysBetween(local.date, date);
  if (ahead < 0) throw unprocessable('DATE_PAST', 'That date has already passed.');
  if (ahead > settings.bookingWindowDays) {
    throw unprocessable('OUTSIDE_WINDOW', `Bookings open ${settings.bookingWindowDays} days ahead. You can book up to ${dateLabel(addDays(local.date, settings.bookingWindowDays))}.`);
  }

  const hours = await db.prepare('SELECT * FROM opening_hours WHERE weekday = ?').bind(weekdayOf(date)).first<HoursRow>();
  if (!hours || !hours.is_open) throw unprocessable('CLOSED', 'The facility is closed that day.');
  const slot = settings.slotMinutes;
  const end = start + slot;
  if (start < hours.open_min || end > hours.close_min || (start - hours.open_min) % slot !== 0) {
    throw unprocessable('INVALID_SLOT', 'Pick one of the listed times.');
  }
  if (ahead === 0 && start <= local.minutes) {
    throw unprocessable('TIME_STARTED', `${minutesLabel(start)} has already started. Pick a later time.`);
  }
  const { results: closures } = await db.prepare('SELECT * FROM closures WHERE date = ?').bind(date).all<ClosureRow>();
  const closure = closures.find((c) => closureCovers(c, resourceId, start, end));
  if (closure) throw unprocessable('CLOSED', closure.reason ? `Unavailable: ${closure.reason}.` : 'That time is unavailable.');

  // Release stale holds first so they can't trip the unique index.
  await sweepExpired(env, now);

  const rate = user.membership === 'member' ? 'member' : 'non_member';
  const amount = rate === 'member' ? resource.price_member : resource.price_non_member;
  const id = newId('b_');
  const holdUntil = now + settings.holdMinutes * 60_000;

  const insert = db
    .prepare(
      `INSERT INTO bookings (id, ref, user_id, resource_id, date, start_min, end_min, status, amount_due, rate, hold_expires_at, created_at, updated_at)
       SELECT ?1,
              'LS-' || replace(?4, '-', '') || '-' || printf('%03d', COALESCE((SELECT MAX(CAST(substr(ref, -3) AS INTEGER)) FROM bookings WHERE date = ?4), 0) + 1),
              ?2, ?3, ?4, ?5, ?6, 'TEMPORARY', ?7, ?8, ?9, ?10, ?10
        WHERE NOT EXISTS (
                SELECT 1 FROM bookings b WHERE b.resource_id = ?3 AND b.date = ?4 AND b.start_min < ?6 AND b.end_min > ?5
                   AND ${OCCUPYING('b', '?10')})
          AND NOT EXISTS (
                SELECT 1 FROM bookings b WHERE b.user_id = ?2 AND b.date = ?4 AND b.start_min < ?6 AND b.end_min > ?5
                   AND ${OCCUPYING('b', '?10')})
          AND (SELECT COUNT(*) FROM bookings b WHERE b.user_id = ?2 AND b.status = 'TEMPORARY' AND b.hold_expires_at > ?10) < ${MAX_OPEN_HOLDS}`,
    )
    .bind(id, user.id, resourceId, date, start, end, amount, rate, holdUntil, now);

  let changes = 0;
  try {
    const res = await insert.run();
    changes = res.meta.changes ?? 0;
  } catch (err) {
    if (!String(err).includes('UNIQUE')) throw err;
    changes = 0; // lost a race on the exact slot
  }

  if (changes === 0) {
    const own = await db
      .prepare(`SELECT id FROM bookings b WHERE b.user_id = ?1 AND b.date = ?2 AND b.start_min < ?4 AND b.end_min > ?3 AND ${OCCUPYING('b', '?5')} LIMIT 1`)
      .bind(user.id, date, start, end, now)
      .first<{ id: string }>();
    if (own) throw unprocessable('OVERLAP_OWN', 'You already have a booking at this time.', { bookingId: own.id });
    const holds = await db
      .prepare(`SELECT COUNT(*) AS n FROM bookings WHERE user_id = ? AND status = 'TEMPORARY' AND hold_expires_at > ?`)
      .bind(user.id, now)
      .first<{ n: number }>();
    if ((holds?.n ?? 0) >= MAX_OPEN_HOLDS) {
      throw unprocessable('TOO_MANY_HOLDS', `You already have ${MAX_OPEN_HOLDS} unpaid holds. Pay for or release one first.`);
    }
    throw conflict('SLOT_TAKEN', 'This slot was just taken by another player.');
  }

  const where = `${resource.name} · ${dateLabel(date)} · ${minutesLabel(start)}`;
  await db.batch([
    eventStmt(db, id, 'created', user.id, 'player', null, now),
    systemMessageStmt(db, id, 'Temporary booking created', now),
    userNoticeStmt(db, user.id, {
      type: 'hold_created',
      title: 'Slot held for you',
      body: `${where} · pay within ${settings.holdMinutes} minutes`,
      link: `/bookings/${id}/pay`,
      bookingId: id,
    }, now),
    staffNoticeStmt(db, {
      type: 'new_booking',
      title: 'New booking created',
      body: `${user.name} · ${where} · temporary hold`,
      link: `/admin/bookings/${id}`,
      bookingId: id,
    }, now),
  ]);
  return getBooking(db, id);
}

// ── Player actions ─────────────────────────────────────────────────────────

export async function releaseHold(env: Bindings, user: SessionUser, bookingId: string, now = Date.now()) {
  const db = env.DB;
  const g = changedAt(bookingId, 'cancelled_at', now);
  const [update] = await db.batch([
    db
      .prepare(
        `UPDATE bookings SET status = 'CANCELLED', cancelled_at = ?1, cancelled_by = ?2, cancel_reason = 'Released by player', hold_expires_at = NULL, updated_at = ?1
          WHERE id = ?3 AND user_id = ?2 AND status IN ('TEMPORARY', 'REJECTED') AND hold_expires_at > ?1`,
      )
      .bind(now, user.id, bookingId),
    eventStmt(db, bookingId, 'released', user.id, 'player', null, now, g),
    systemMessageStmt(db, bookingId, 'Hold released by the player', now, g),
    resolveStaffStmt(db, bookingId, ['new_booking', 'hold_expiring', 'proof_submitted'], now, g),
  ]);
  if (!update?.meta.changes) throw conflict('INVALID_STATUS', 'This hold has already ended.');
}

export async function cancelByPlayer(env: Bindings, settings: Settings, user: SessionUser, bookingId: string, reason: string | null, now = Date.now()) {
  const db = env.DB;
  const b = await getBooking(db, bookingId);
  if (b.user_id !== user.id) throw notFound('Booking not found.');
  const offset = offsetMinutes(env.TZ_OFFSET_MINUTES);
  const startsAt = localToMs(b.date, b.start_min, offset);
  if (b.status !== 'CONFIRMED') throw conflict('INVALID_STATUS', 'Only confirmed bookings can be cancelled here.');
  if (now >= startsAt - settings.cancelCutoffHours * 3_600_000) {
    throw unprocessable('CANCEL_WINDOW_CLOSED', `Bookings can be cancelled up to ${settings.cancelCutoffHours} hours before they start. Message staff in the booking chat for help.`);
  }
  const where = `${b.resource_name} · ${dateLabel(b.date)} · ${minutesLabel(b.start_min)}`;
  const g = changedAt(bookingId, 'cancelled_at', now);
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE bookings SET status = 'CANCELLED', cancelled_at = ?1, cancelled_by = ?2, cancel_reason = ?3, updated_at = ?1
          WHERE id = ?4 AND user_id = ?2 AND status = 'CONFIRMED'`,
      )
      .bind(now, user.id, reason ?? 'Cancelled by player', bookingId),
    eventStmt(db, bookingId, 'cancelled', user.id, 'player', reason, now, g),
    systemMessageStmt(db, bookingId, 'Booking cancelled by the player', now, g),
    userNoticeStmt(db, user.id, { type: 'booking_cancelled', title: 'Booking cancelled', body: `${where} · staff will follow up about your ${peso(b.amount_due)} in the booking chat`, link: `/bookings/${bookingId}`, bookingId }, now, g),
    staffNoticeStmt(db, { type: 'booking_cancelled', title: 'Booking cancelled by player', body: `${b.user_name} · ${where}${reason ? ` · ${reason}` : ''}`, link: `/admin/bookings/${bookingId}`, bookingId }, now, g),
  ];
  for (const email of settings.staffAlertEmails) {
    stmts.push(
      outboxStmt(db, 'email', email, 'Le Spinners — Booking cancelled',
        `${b.user_name} cancelled ${b.ref}.\n\n${where}\nAmount paid: ${peso(b.amount_due)}\nReason: ${reason ?? 'not given'}\n\nFollow up about a refund or credit in the booking chat:\n${env.APP_ORIGIN}/admin/messages/${bookingId}`,
        bookingId, now, g),
    );
  }
  const [update] = await db.batch(stmts);
  if (!update?.meta.changes) throw conflict('INVALID_STATUS', 'This booking changed. Refresh and try again.');
}

// ── Timeline ───────────────────────────────────────────────────────────────

const EVENT_LABELS: Record<string, string> = {
  created: 'Temporary booking created',
  proof_submitted: 'Payment proof submitted',
  approved: 'Payment verified · booking confirmed',
  rejected: 'Payment proof rejected',
  expired: 'Booking expired',
  released: 'Hold released',
  cancelled: 'Booking cancelled',
  completed: 'Booking completed',
};

type EventRow = { id: number; type: string; actor_id: string | null; actor_role: 'player' | 'staff' | 'system'; note: string | null; created_at: number; actor_name: string | null };

/** Booking history. Players see "Le Spinners" instead of individual staff names. */
export async function listEvents(db: D1Database, bookingId: string, forStaff: boolean) {
  const { results } = await db
    .prepare(
      `SELECT e.id, e.type, e.actor_id, e.actor_role, e.note, e.created_at, u.name AS actor_name
         FROM booking_events e LEFT JOIN users u ON u.id = e.actor_id
        WHERE e.booking_id = ? ORDER BY e.created_at, e.id`,
    )
    .bind(bookingId)
    .all<EventRow>();
  return results.map((e) => ({
    type: e.type,
    label: EVENT_LABELS[e.type] ?? e.type,
    at: e.created_at,
    note: e.note,
    actor:
      e.actor_role === 'system'
        ? null
        : forStaff
          ? e.actor_name ?? (e.actor_role === 'staff' ? 'Staff' : 'Player')
          : e.actor_role === 'staff'
            ? 'Le Spinners'
            : 'You',
  }));
}
