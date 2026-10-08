import * as z from 'zod';
import type { Activity, Bindings, BookingRow, BookingSource, BookingStatus, PaymentMethod, ResourceRow, SessionUser } from '../types';
import { conflict, notFound, unprocessable } from './errors';
import { newId } from './crypto';
import { bookingOperation } from './booking-operations';
import { MAINTENANCE_BATCH_SIZE } from './limits';
import { isOverspend, planCreditUse, redeemStmts, releaseStmts, spendableCredits, usesNote, type CreditUse } from './credits';
import { outboxStmt, resolveStaffStmt, staffNoticeStmt, userNoticeStmt, type Guard } from './notify';
import type { Settings } from './settings';
import { bookingConfigurationBatch, bookingConfigurationVersion } from './schedule';
import {
  addDays,
  dateLabel,
  daysBetween,
  isValidDate,
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
/**
 * A booking holds any number of slots on one court or table on one day, gaps allowed.
 * There is no business limit; this only bounds a request (a whole day of 15-minute slots).
 */
export const MAX_SLOTS = 96;

export type BookingJoin = BookingRow & {
  resource_name: string;
  activity: Activity;
  user_name?: string;
  user_email?: string;
  user_phone?: string | null;
  user_membership?: string;
  confirmed_by_name?: string | null;
  rejected_by_name?: string | null;
  created_by_name?: string | null;
  /** JSON [[start, end], …] from booking_times (SEGMENTS_SQL); see segmentsOf. */
  segments_json?: string | null;
  /** Booking credit issued because Le Spinners cancelled or cut short this booking. */
  credit_issued?: number;
};

const zMinute = z.number().int().min(0).max(1439);

/**
 * Request fields for the slots to book: `starts` (any slots on the chosen court that day,
 * gaps allowed), or a single `start`. `slots` is what clients from before gaps were
 * allowed send: that many slots in a row from `start`.
 */
export const zSlotPick = {
  start: zMinute.optional(),
  starts: z.array(zMinute).min(1, 'Pick at least one time.').max(MAX_SLOTS, `Pick at most ${MAX_SLOTS} times.`).optional(),
  slots: z.number().int().min(1).max(MAX_SLOTS).optional(),
};

/** zod refine for zSlotPick: at least one time was picked. Use as `.refine(hasSlotPick, PICK_A_TIME)`. */
export const hasSlotPick = (b: { start?: number; starts?: number[] }) => Boolean(b.starts?.length) || b.start != null;
export const PICK_A_TIME: { message: string; path: string[] } = { message: 'Pick at least one time.', path: ['starts'] };

/** The slot starts a request asked for (see zSlotPick). */
export function requestedStarts(b: { start?: number; starts?: number[]; slots?: number }, slotMinutes: number): number[] {
  if (b.starts?.length) return b.starts;
  if (b.start == null) return [];
  const first = b.start;
  return Array.from({ length: b.slots ?? 1 }, (_, k) => first + k * slotMinutes);
}

/** One continuous stretch of booked time, in minutes from local midnight. */
export type Segment = { start: number; end: number };

/** SQL column: a booking's times as JSON [[start, end], …], earliest first. `alias` is the bookings table alias. */
export const SEGMENTS_SQL = (alias: string) =>
  `(SELECT json_group_array(json_array(t.start_min, t.end_min))
      FROM (SELECT start_min, end_min FROM booking_times WHERE booking_id = ${alias}.id ORDER BY start_min) t) AS segments_json`;

export const BOOKING_SELECT = `
  SELECT b.*, r.name AS resource_name, r.activity AS activity,
         u.name AS user_name, u.email AS user_email, u.phone AS user_phone, u.membership AS user_membership,
         cu.name AS confirmed_by_name, ru.name AS rejected_by_name, bu.name AS created_by_name,
         ${SEGMENTS_SQL('b')},
         (SELECT COALESCE(SUM(c.amount), 0) FROM booking_credits c WHERE c.source_booking_id = b.id) AS credit_issued
    FROM bookings b
    JOIN resources r ON r.id = b.resource_id
    JOIN users u ON u.id = b.user_id
    LEFT JOIN users cu ON cu.id = b.confirmed_by
    LEFT JOIN users ru ON ru.id = b.rejected_by
    LEFT JOIN users bu ON bu.id = b.created_by`;

export function effectiveStatus(b: Pick<BookingRow, 'status' | 'hold_expires_at'>, now: number): BookingStatus {
  if ((b.status === 'TEMPORARY' || b.status === 'REJECTED') && (b.hold_expires_at ?? 0) <= now) return 'EXPIRED';
  return b.status;
}

export function activityLabel(a: Activity): string {
  return a === 'pickleball' ? 'Pickleball' : 'Table Tennis';
}

type Timed = Pick<BookingRow, 'start_min' | 'end_min'> & { segments_json?: string | null };

/** Slot starts merged into continuous segments: [960, 1020, 1140] with 60-minute slots → 4–6 PM, 7–8 PM. */
export function mergeSlots(starts: number[], slotMinutes: number): Segment[] {
  const out: Segment[] = [];
  for (const s of [...new Set(starts)].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && last.end === s) last.end = s + slotMinutes;
    else out.push({ start: s, end: s + slotMinutes });
  }
  return out;
}

/** A booking's times (from segments_json), or its start–end block when they weren't selected. */
export function segmentsOf(b: Timed): Segment[] {
  if (b.segments_json) {
    try {
      const segs = (JSON.parse(b.segments_json) as unknown[])
        .filter((x): x is [number, number] => Array.isArray(x) && Number.isInteger(x[0]) && Number.isInteger(x[1]))
        .map(([start, end]) => ({ start, end }))
        .sort((x, y) => x.start - y.start);
      if (segs.length) return segs;
    } catch {
      // fall through to the block
    }
  }
  return [{ start: b.start_min, end: b.end_min }];
}

/** "6:00 PM – 7:00 PM", or with gaps "4:00 PM – 5:00 PM, 7:00 PM – 8:00 PM". */
export function slotLabel(b: Timed): string {
  return segmentsOf(b).map((s) => `${minutesLabel(s.start)} – ${minutesLabel(s.end)}`).join(', ');
}

/** Minutes actually booked (gaps between segments don't count). */
export function bookedMinutes(b: Timed): number {
  return segmentsOf(b).reduce((n, s) => n + s.end - s.start, 0);
}

/** "1 hour", "2 hours", "90 min". */
export function durationLabel(minutes: number): string {
  if (minutes % 60 === 0) return `${minutes / 60} hour${minutes === 60 ? '' : 's'}`;
  return `${minutes} min`;
}

const SOURCE_LABEL: Record<BookingSource, string> = { online: 'Online', staff: 'Staff', admin: 'Admin' };
const METHOD_LABEL: Record<PaymentMethod, string> = { gcash: 'GCash', on_site: 'Paid on site', none: 'No charge' };

/**
 * How a booking was paid. `payment_method` is how the cash part was paid; credit is separate:
 * 'none' + credit = "Paid with credit", 'gcash' + credit = "GCash + credit".
 */
export function paymentMethodLabel(m: PaymentMethod, creditApplied = 0, name?: string | null): string {
  const label = name || METHOD_LABEL[m];
  if (creditApplied > 0) return m === 'none' ? 'Paid with credit' : `${label} + credit`;
  return label;
}

export function bookingDTO(b: BookingJoin, now: number, settings: Settings, offsetMin: number, forStaff = false) {
  const status = effectiveStatus(b, now);
  const startsAt = localToMs(b.date, b.start_min, offsetMin);
  const cancelDeadline = startsAt - settings.cancelCutoffHours * 3_600_000;
  const holding = status === 'TEMPORARY' || status === 'REJECTED';
  const segments = segmentsOf(b);
  const minutes = segments.reduce((n, s) => n + s.end - s.start, 0);
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
    /** The booked times, earliest first. More than one when the booking has gaps. */
    segments: segments.map((s) => ({ start: s.start, end: s.end })),
    timeLabel: slotLabel(b),
    durationMin: minutes,
    durationLabel: durationLabel(minutes),
    startsAt,
    /** The final occupied end, in facility time; gaps do not shorten this envelope. */
    endsAt: localToMs(b.date, b.end_min, offsetMin),
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
    canCancel: false, // players never cancel; Le Spinners cancels and issues a credit (REBOOKING.md)
    cancelDeadline,
    /** Who ended a CANCELLED booking: the player releasing a hold, or Le Spinners. */
    cancelledBy: status === 'CANCELLED' ? (b.cancelled_by && b.cancelled_by === b.user_id ? 'player' : 'staff') : null,
    /** Le Spinners cancelled it or cut it short (a disruption). */
    disrupted: Boolean(b.disruption_id),
    source: b.source,
    paymentMethod: b.payment_method,
    paymentMethodId: b.payment_method_id ?? null,
    paymentMethodName: b.payment_method_name ?? METHOD_LABEL[b.payment_method],
    paymentMethodLabel: paymentMethodLabel(b.payment_method, b.credit_applied ?? 0, b.payment_method_name),
    /** Credit used to pay; amountDue above is the cash part. */
    creditApplied: b.credit_applied ?? 0,
    creditAppliedLabel: peso(b.credit_applied ?? 0),
    totalValue: b.amount_due + (b.credit_applied ?? 0),
    totalLabel: peso(b.amount_due + (b.credit_applied ?? 0)),
    /** Credit issued back because Le Spinners cancelled or cut short this booking. */
    creditIssued: b.credit_issued ?? 0,
    creditIssuedLabel: peso(b.credit_issued ?? 0),
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
    /** Console bookings: who it's for (user is the staff account it's booked under). */
    bookerName: b.booker_name ?? null,
    confirmedBy: b.confirmed_by_name ?? null,
    rejectedBy: b.rejected_by_name ?? null,
    // "Online", or "Staff · Ana Reyes" / "Admin · Ana Reyes" for console bookings.
    bookedBy: {
      source: b.source,
      label: SOURCE_LABEL[b.source],
      name: b.source === 'online' ? null : b.created_by_name ?? null,
    },
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

/** The winning UPDATE stores this request's random identity in the same batch as its effects. */
export function bookingTransition(bookingId: string): Guard & { id: string } {
  const id = newId('tr_');
  return { id, sql: 'EXISTS (SELECT 1 FROM bookings WHERE id = ? AND transition_id = ?)', params: [bookingId, id] };
}

// Time-driven transitions use a bounded candidate list and one atomic batch.
// Recheck eligibility in UPDATE; only rows carrying this pass's token get effects.
type MaintenanceRow = { id: string; user_id: string; rejected_at: number | null; resource_name: string; date: string; start_min: number };
function passGuard(id: string, token: string): Guard {
  return { sql: 'EXISTS (SELECT 1 FROM bookings WHERE id = ? AND transition_id = ?)', params: [id, token] };
}

/** Expires at most eight unpaid holds, including their credit and complete effects. */
export async function sweepExpired(env: Bindings, now = Date.now(), scope?: { resourceId: string; date: string; startMin?: number }): Promise<number> {
  const db = env.DB;
  const { results } = await db.prepare(`SELECT b.id, b.user_id, b.rejected_at, r.name AS resource_name, b.date, b.start_min
    FROM bookings b JOIN resources r ON r.id = b.resource_id
    WHERE b.status IN ('TEMPORARY', 'REJECTED') AND b.hold_expires_at <= ?
      ${scope ? 'AND b.resource_id = ? AND b.date = ?' : ''}
    ORDER BY ${scope?.startMin != null ? 'CASE WHEN b.start_min = ? THEN 0 ELSE 1 END, ' : ''}b.hold_expires_at, b.id LIMIT ?`)
    .bind(now, ...(scope ? [scope.resourceId, scope.date] : []), ...(scope?.startMin != null ? [scope.startMin] : []), MAINTENANCE_BATCH_SIZE).all<MaintenanceRow>();
  if (!results.length) return 0;
  const token = newId('tr_');
  const statements = [db.prepare(`UPDATE bookings SET status = 'EXPIRED', updated_at = ?1, transition_id = ?2
    WHERE id IN (SELECT value FROM json_each(?3)) AND status IN ('TEMPORARY', 'REJECTED') AND hold_expires_at <= ?1`)
    .bind(now, token, JSON.stringify(results.map(b => b.id))),
    ...releaseStmts(db, 'b.id IN (SELECT value FROM json_each(?)) AND b.transition_id = ?', [JSON.stringify(results.map(b => b.id)), token], now)];
  for (const b of results) {
    const guard = passGuard(b.id, token);
    const wasRejected = b.rejected_at != null;
    const where = `${b.resource_name} · ${dateLabel(b.date)} · ${minutesLabel(b.start_min)}`;
    statements.push(
      eventStmt(db, b.id, 'expired', null, 'system', wasRejected ? 'No new proof before the resubmit window ended' : 'No payment proof before the hold ended', now, guard),
      systemMessageStmt(db, b.id, wasRejected ? 'Resubmit window ended · booking expired' : 'Hold ended · booking expired', now, guard),
      userNoticeStmt(db, b.user_id, { type: 'booking_expired', title: 'Booking expired', body: `${where} · the slot was released`, link: `/bookings/${b.id}`, bookingId: b.id }, now, guard),
      resolveStaffStmt(db, b.id, ['new_booking', 'hold_expiring', 'proof_submitted'], now, guard),
    );
  }
  const [updated] = await db.batch(statements);
  return updated?.meta.changes ?? 0;
}

/** One warning per hold, committed with the durable warned checkpoint. */
export async function warnExpiringHolds(env: Bindings, settings: Settings, now = Date.now()): Promise<number> {
  const db = env.DB;
  const window = settings.warnMinutes * 60_000;
  const { results } = await db.prepare(`SELECT b.id, b.user_id, r.name AS resource_name, b.date, b.start_min
    FROM bookings b JOIN resources r ON r.id = b.resource_id
    WHERE b.status = 'TEMPORARY' AND b.warned_at IS NULL AND b.hold_expires_at > ? AND b.hold_expires_at <= ?
    ORDER BY b.hold_expires_at, b.id LIMIT ?`).bind(now, now + window, MAINTENANCE_BATCH_SIZE).all<MaintenanceRow>();
  if (!results.length) return 0;
  const token = newId('tr_');
  const statements = [db.prepare(`UPDATE bookings SET warned_at = ?1, transition_id = ?2
    WHERE id IN (SELECT value FROM json_each(?3)) AND status = 'TEMPORARY' AND warned_at IS NULL
      AND hold_expires_at > ?1 AND hold_expires_at <= ?4`).bind(now, token, JSON.stringify(results.map(b => b.id)), now + window)];
  for (const b of results) {
    const guard = passGuard(b.id, token);
    statements.push(
      userNoticeStmt(db, b.user_id, {
        type: 'hold_expiring', title: 'Your temporary reservation will expire soon',
        body: `Upload your payment proof in the next ${settings.warnMinutes} minutes to keep ${b.resource_name}.`,
        link: `/bookings/${b.id}/pay`, bookingId: b.id,
      }, now, guard),
      staffNoticeStmt(db, {
        type: 'hold_expiring', title: 'Payment window expiring',
        body: `${b.resource_name} · ${dateLabel(b.date)} · ${minutesLabel(b.start_min)} · no proof yet`,
        link: `/admin/bookings/${b.id}`, bookingId: b.id,
      }, now, guard),
    );
  }
  const [updated] = await db.batch(statements);
  return updated?.meta.changes ?? 0;
}

/** Completes at most eight ended bookings with their timeline entries. */
export async function completePast(env: Bindings, now = Date.now()): Promise<number> {
  const db = env.DB;
  const local = localNow(offsetMinutes(env.TZ_OFFSET_MINUTES), now);
  const { results } = await db.prepare(`SELECT id FROM bookings
    WHERE status = 'CONFIRMED' AND (date < ? OR (date = ? AND end_min <= ?))
    ORDER BY date, end_min, id LIMIT ?`).bind(local.date, local.date, local.minutes, MAINTENANCE_BATCH_SIZE).all<{ id: string }>();
  if (!results.length) return 0;
  const token = newId('tr_');
  const [updated] = await db.batch([
    db.prepare(`UPDATE bookings SET status = 'COMPLETED', updated_at = ?1, transition_id = ?2
      WHERE id IN (SELECT value FROM json_each(?3)) AND status = 'CONFIRMED'
        AND (date < ?4 OR (date = ?4 AND end_min <= ?5))`)
      .bind(now, token, JSON.stringify(results.map(b => b.id)), local.date, local.minutes),
    ...results.map(b => eventStmt(db, b.id, 'completed', null, 'system', null, now, passGuard(b.id, token))),
  ]);
  return updated?.meta.changes ?? 0;
}

// ── Creating a hold ────────────────────────────────────────────────────────

export function underMaintenance(r: Pick<ResourceRow, 'status' | 'maintenance_until'>, date: string): boolean {
  if (r.status !== 'maintenance') return false;
  return !r.maintenance_until || date < r.maintenance_until;
}

/** In service but free for all: players see it, nobody can book it. */
export function isOpenPlay(r: Pick<ResourceRow, 'status' | 'open_play'>): boolean {
  return r.status === 'active' && Boolean(r.open_play);
}

/** The status the API reports: 'active' | 'open_play' | 'maintenance' | 'disabled'. */
export function resourceStatus(r: Pick<ResourceRow, 'status' | 'open_play'>) {
  return isOpenPlay(r) ? ('open_play' as const) : r.status;
}

export type HoursRow = { weekday: number; is_open: number; open_min: number; close_min: number };
export type ClosureRow = { id: string; date: string; resource_id: string | null; start_min: number | null; end_min: number | null; reason: string | null };

export function closureCovers(c: ClosureRow, resourceId: string, start: number, end: number): boolean {
  if (c.resource_id && c.resource_id !== resourceId) return false;
  if (c.start_min == null || c.end_min == null) return true;
  return c.start_min < end && c.end_min > start;
}

type SlotInput = { resourceId: string; date: string; starts: number[] };

/**
 * Checks that every slot in `starts` can be booked: one court or table, one day, any
 * number of slots, gaps allowed. Returns the resource and the slots merged into
 * continuous segments (4–5 PM + 5–6 PM → 4–6 PM).
 */
async function checkSlots(env: Bindings, settings: Settings, input: SlotInput, now: number) {
  const db = env.DB;
  const local = localNow(offsetMinutes(env.TZ_OFFSET_MINUTES), now);
  const { resourceId, date } = input;
  if (!isValidDate(date)) throw unprocessable('VALIDATION_ERROR', 'Use a real date (YYYY-MM-DD).', { date: ['Invalid date.'] });
  const starts = [...new Set(input.starts)].sort((a, b) => a - b);
  if (!starts.length || starts.length > MAX_SLOTS || starts.some((s) => !Number.isInteger(s))) {
    throw unprocessable('INVALID_SLOT', 'Pick one or more of the listed times.');
  }
  // Release expired inventory first. Occupancy is rechecked by the atomic INSERT;
  // only resource/hour/closure changes invalidate the configuration read below.
  // Prioritize the exact-start backstop's expired row even behind a large backlog.
  await sweepExpired(env, now, { resourceId, date, startMin: starts[0]! });
  const version = await bookingConfigurationVersion(db);

  const resource = await db.prepare('SELECT * FROM resources WHERE id = ?').bind(resourceId).first<ResourceRow>();
  if (!resource || resource.status === 'disabled') throw unprocessable('RESOURCE_UNAVAILABLE', 'That court or table is not available.');
  if (underMaintenance(resource, date)) {
    const until = resource.maintenance_until ? ` until ${dateLabel(resource.maintenance_until)}` : '';
    throw unprocessable('MAINTENANCE', `${resource.name} is under maintenance${until}.`);
  }
  if (isOpenPlay(resource)) {
    throw unprocessable('OPEN_PLAY', `${resource.name} is open play: free for all, so it can't be booked.`);
  }

  const ahead = daysBetween(local.date, date);
  if (ahead < 0) throw unprocessable('DATE_PAST', 'That date has already passed.');
  if (ahead > settings.bookingWindowDays) {
    throw unprocessable('OUTSIDE_WINDOW', `Bookings open ${settings.bookingWindowDays} days ahead. You can book up to ${dateLabel(addDays(local.date, settings.bookingWindowDays))}.`);
  }

  const hours = await db.prepare('SELECT * FROM opening_hours WHERE weekday = ?').bind(weekdayOf(date)).first<HoursRow>();
  if (!hours || !hours.is_open) throw unprocessable('CLOSED', 'The facility is closed that day.');
  const slot = settings.slotMinutes;
  if (starts.some((s) => s < hours.open_min || s + slot > hours.close_min || (s - hours.open_min) % slot !== 0)) {
    throw unprocessable('INVALID_SLOT', 'Pick one of the listed times.');
  }
  const first = starts[0]!;
  if (ahead === 0 && first <= local.minutes) {
    throw unprocessable('TIME_STARTED', `${minutesLabel(first)} has already started. Pick a later time.`);
  }
  const segments = mergeSlots(starts, slot);
  const { results: closures } = await db.prepare('SELECT * FROM closures WHERE date = ?').bind(date).all<ClosureRow>();
  const closure = closures.find((c) => segments.some((s) => closureCovers(c, resourceId, s.start, s.end)));
  if (closure) throw unprocessable('CLOSED', closure.reason ? `Unavailable: ${closure.reason}.` : 'That time is unavailable.');

  return { resource, segments, slots: starts.length, version };
}

type NewBooking = {
  scheduleVersion: number;
  id: string;
  userId: string;
  resourceId: string;
  date: string;
  segments: Segment[];
  status: 'TEMPORARY' | 'CONFIRMED';
  /** Cash part (amount_due). */
  amount: number;
  /** Credit part; the booking's price is amount + creditApplied. */
  creditApplied: number;
  rate: 'member' | 'non_member';
  holdUntil: number | null;
  source: BookingSource;
  createdBy: string;
  /** Console bookings: who it's for, as typed by staff. */
  bookerName: string | null;
  paymentMethod: PaymentMethod;
  submittedAt: number | null;
  confirmedAt: number | null;
  confirmedBy: string | null;
};

/** SQL: some held, verifying or confirmed booking matching `who` has a time overlapping one of the JSON segments in `segsParam`. */
function clashSql(who: string, dateParam: string, segsParam: string, nowParam: string): string {
  return `EXISTS (
    SELECT 1 FROM booking_times t JOIN bookings b ON b.id = t.booking_id, json_each(${segsParam}) n
     WHERE ${who} AND t.date = ${dateParam}
       AND t.start_min < json_extract(n.value, '$[1]') AND t.end_min > json_extract(n.value, '$[0]')
       AND ${OCCUPYING('b', nowParam)})`;
}

/**
 * Inserts the booking and its times in one transaction. The booking row is inserted only
 * if none of its times overlap another active booking on the resource, or another active
 * booking of the same user, or a closure, and the court is still bookable (INSERT … WHERE
 * NOT EXISTS, evaluated atomically, so a closure or maintenance saved a moment earlier still
 * wins); the times are inserted only if the booking was. `extra` statements (spending booking
 * credit) run in the same batch: if one fails, nothing is booked. Returns rows inserted (0 or 1).
 */
async function insertBooking(
  db: D1Database,
  row: NewBooking,
  now: number,
  maxOpenHolds: number | null,
  extra: D1PreparedStatement[] = [],
  actor?: SessionUser,
): Promise<number> {
  const segs = JSON.stringify(row.segments.map((s) => [s.start, s.end]));
  const start = row.segments[0]!.start;
  const end = row.segments[row.segments.length - 1]!.end;
  const holdCap = maxOpenHolds != null
    ? `AND (SELECT COUNT(*) FROM bookings b WHERE b.user_id = ?2 AND b.status = 'TEMPORARY' AND b.hold_expires_at > ?10) < ${maxOpenHolds}`
    : '';
  const insert = db
    .prepare(
      `INSERT INTO bookings (id, ref, user_id, resource_id, date, start_min, end_min, status, amount_due, rate, hold_expires_at, created_at, updated_at,
                             source, created_by, payment_method, submitted_at, confirmed_at, confirmed_by, credit_applied, booker_name)
       SELECT ?1,
              'LS-' || replace(?4, '-', '') || '-' || printf('%03d', COALESCE((SELECT MAX(CAST(substr(ref, 13) AS INTEGER)) FROM bookings WHERE date = ?4), 0) + 1),
              ?2, ?3, ?4, ?5, ?6, ?11, ?7, ?8, ?9, ?10, ?10, ?12, ?13, ?14, ?15, ?16, ?17, ?19, ?20
        WHERE NOT ${clashSql('t.resource_id = ?3', '?4', '?18', '?10')}
          AND NOT ${clashSql('b.user_id = ?2', '?4', '?18', '?10')}
          AND NOT EXISTS (
            SELECT 1 FROM closures c, json_each(?18) n
             WHERE c.date = ?4 AND (c.resource_id IS NULL OR c.resource_id = ?3)
               AND (c.start_min IS NULL OR c.end_min IS NULL
                    OR (c.start_min < json_extract(n.value, '$[1]') AND c.end_min > json_extract(n.value, '$[0]'))))
          AND EXISTS (
            SELECT 1 FROM resources r
             WHERE r.id = ?3
               AND ((r.status = 'active' AND r.open_play = 0)
                    OR (r.status = 'maintenance' AND r.maintenance_until IS NOT NULL AND r.maintenance_until <= ?4)))
          ${holdCap}`,
    )
    .bind(
      row.id, row.userId, row.resourceId, row.date, start, end, row.amount, row.rate, row.holdUntil, now,
      row.status, row.source, row.createdBy, row.paymentMethod, row.submittedAt, row.confirmedAt, row.confirmedBy, segs,
      row.creditApplied, row.bookerName,
    );
  const times = db
    .prepare(
      `INSERT INTO booking_slots (booking_id, resource_id, date, start_min, end_min)
       SELECT ?1, ?2, ?3, json_extract(n.value, '$[0]'), json_extract(n.value, '$[1]') FROM json_each(?4) n
        WHERE EXISTS (SELECT 1 FROM bookings WHERE id = ?1)`,
    )
    .bind(row.id, row.resourceId, row.date, segs);
  try {
    const [res] = await bookingConfigurationBatch(db, row.scheduleVersion, [insert, times, ...extra], actor);
    return res?.meta.changes ?? 0;
  } catch (err) {
    if (!/UNIQUE constraint failed: bookings\.resource_id, bookings\.date, bookings\.start_min/.test(String(err))) throw err;
    return 0; // lost a race on the exact slot
  }
}

/** Says why insertBooking inserted nothing. */
async function explainRefusal(
  db: D1Database,
  userId: string,
  input: { resourceId: string; date: string; segments: Segment[]; slots: number },
  now: number,
  opts: { checkHolds: boolean; self: boolean },
): Promise<never> {
  // A closure or a status change saved after checkSlots ran (the insert checks both atomically).
  const [closureRes, resourceRes] = await db.batch([
    db.prepare('SELECT * FROM closures WHERE date = ?').bind(input.date),
    db.prepare('SELECT * FROM resources WHERE id = ?').bind(input.resourceId),
  ]);
  const closure = ((closureRes?.results ?? []) as ClosureRow[]).find((c) => input.segments.some((s) => closureCovers(c, input.resourceId, s.start, s.end)));
  if (closure) throw unprocessable('CLOSED', closure.reason ? `Unavailable: ${closure.reason}.` : 'That time is unavailable.');
  const resource = ((resourceRes?.results ?? []) as ResourceRow[])[0];
  if (!resource || resource.status === 'disabled') throw unprocessable('RESOURCE_UNAVAILABLE', 'That court or table is not available.');
  if (underMaintenance(resource, input.date)) throw unprocessable('MAINTENANCE', `${resource.name} is under maintenance.`);
  if (isOpenPlay(resource)) throw unprocessable('OPEN_PLAY', `${resource.name} is open play: free for all, so it can't be booked.`);
  const own = await db
    .prepare(
      `SELECT b.id FROM booking_times t JOIN bookings b ON b.id = t.booking_id, json_each(?3) n
        WHERE b.user_id = ?1 AND t.date = ?2
          AND t.start_min < json_extract(n.value, '$[1]') AND t.end_min > json_extract(n.value, '$[0]')
          AND ${OCCUPYING('b', '?4')} LIMIT 1`,
    )
    .bind(userId, input.date, JSON.stringify(input.segments.map((s) => [s.start, s.end])), now)
    .first<{ id: string }>();
  if (own) throw unprocessable('OVERLAP_OWN', opts.self ? 'You already have a booking at this time.' : 'You already have a booking at this time on your account.', { bookingId: own.id });
  if (opts.checkHolds) {
    const holds = await db
      .prepare(`SELECT COUNT(*) AS n FROM bookings WHERE user_id = ? AND status = 'TEMPORARY' AND hold_expires_at > ?`)
      .bind(userId, now)
      .first<{ n: number }>();
    if ((holds?.n ?? 0) >= MAX_OPEN_HOLDS) {
      throw unprocessable('TOO_MANY_HOLDS', `You already have ${MAX_OPEN_HOLDS} unpaid holds. Pay for or release one first.`);
    }
  }
  throw conflict('SLOT_TAKEN', input.slots > 1 ? 'Some of those times were just taken by another player.' : 'This slot was just taken by another player.');
}

/** "6:00 PM" for a single slot, otherwise every range: "4:00 PM – 5:00 PM, 7:00 PM – 8:00 PM". */
function whenLabel(segments: Segment[], slots: number): string {
  if (slots === 1) return minutesLabel(segments[0]!.start);
  return segments.map((s) => `${minutesLabel(s.start)} – ${minutesLabel(s.end)}`).join(', ');
}

/** What a player's booking credit would cover for a price (the server's figures; nothing is held). */
export async function creditQuote(db: D1Database, userId: string, price: number, now: number) {
  const plan = planCreditUse(await spendableCredits(db, userId, now), price);
  return { price, creditApplied: plan.total, amountDue: price - plan.total, uses: plan.uses };
}

function creditChanged(quote: { price: number; creditApplied: number; amountDue: number }) {
  return conflict('CREDIT_CHANGED', 'Your booking credit changed. Check the new total, then book again.', {
    price: quote.price,
    creditApplied: quote.creditApplied,
    amountDue: quote.amountDue,
    priceLabel: peso(quote.price),
    creditAppliedLabel: peso(quote.creditApplied),
    amountDueLabel: peso(quote.amountDue),
  });
}

/**
 * Reserve a booking. With `useCredit`, the player's booking credit pays first (soonest-expiring,
 * then oldest): when it covers the whole price the booking is confirmed at once; otherwise a hold
 * for the difference is paid by GCash as usual, and the credit comes back if that hold ends unpaid.
 * `expectedCredit` is what the app showed; it never sets an amount, a mismatch answers 409.
 */
export async function createHold(
  env: Bindings,
  settings: Settings,
  user: SessionUser,
  input: SlotInput & { useCredit?: boolean; expectedCredit?: number | null; idempotencyKey?: string },
  now = Date.now(),
  beforeCreate?: () => Promise<void>,
) {
  const db = env.DB;
  const { resourceId, date } = input;
  const op = await bookingOperation(db, user.id, 'player', input.idempotencyKey, {
    resourceId, date, starts: [...new Set(input.starts)].sort((a, b) => a - b),
    useCredit: input.useCredit ?? false, expectedCredit: input.useCredit ? input.expectedCredit ?? null : null,
  });
  const replay = await op.replay();
  if (replay) return getBooking(db, replay);
  try {
    // HTTP callers charge only new attempts. Durable successful retries must
    // remain recoverable even when the player's new-hold budget is exhausted.
    await beforeCreate?.();
    const { resource, segments, slots, version } = await checkSlots(env, settings, input, now);

    const rate = user.membership === 'member' ? 'member' : 'non_member';
    const price = (rate === 'member' ? resource.price_member : resource.price_non_member) * slots;
    const quote = input.useCredit ? await creditQuote(db, user.id, price, now) : { price, creditApplied: 0, amountDue: price, uses: [] as CreditUse[] };
    if (input.useCredit && input.expectedCredit != null && input.expectedCredit !== quote.creditApplied) throw creditChanged(quote);
    const paidByCredit = quote.creditApplied > 0 && quote.amountDue === 0;
    const id = newId('b_');
    const guard: Guard = { sql: 'EXISTS (SELECT 1 FROM bookings WHERE id = ?)', params: [id] };
    const effects: D1PreparedStatement[] = [];
    const where = `${resource.name} · ${dateLabel(date)} · ${whenLabel(segments, slots)}`;
    const credit = quote.uses.length ? usesNote(quote.uses) : null;
    if (paidByCredit) {
      effects.push(
        eventStmt(db, id, 'credit_booked', user.id, 'player', `Paid with ${credit}`, now, guard),
        systemMessageStmt(db, id, 'Booked with booking credit · confirmed', now, guard),
        userNoticeStmt(db, user.id, {
          type: 'credit_booking_confirmed',
          title: 'Booking confirmed',
          body: `${where} · paid with ${peso(quote.creditApplied)} booking credit`,
          link: `/bookings/${id}`,
          bookingId: id,
        }, now, guard),
        staffNoticeStmt(db, {
          type: 'new_booking',
          title: 'New booking · paid with credit',
          body: `${user.name} · ${where} · confirmed`,
          link: `/admin/bookings/${id}`,
          bookingId: id,
        }, now, guard),
        // Nothing for staff to do: the notice is informational.
        resolveStaffStmt(db, id, ['new_booking'], now, guard),
        outboxStmt(db, 'email', user.email, 'Le Spinners — Booking confirmed',
          `Hi ${user.name},\n\nYour booking is confirmed, paid with ${peso(quote.creditApplied)} booking credit.\n\n${activityLabel(resource.activity)} · ${where}\n\nView your ticket: ${env.APP_ORIGIN}/bookings/${id}\n\nSee you on court!\nLe Spinners Recreational Hub`,
          id, now, guard),
      );
    } else {
      const pay = credit ? `pay ${peso(quote.amountDue)} within ${settings.holdMinutes} minutes (${peso(quote.creditApplied)} credit applied)` : `pay within ${settings.holdMinutes} minutes`;
      effects.push(
        eventStmt(db, id, 'created', user.id, 'player', null, now, guard),
        ...(credit ? [eventStmt(db, id, 'credit_applied', user.id, 'player', credit, now, guard)] : []),
        systemMessageStmt(db, id, credit ? `Temporary booking created · ${credit} applied` : 'Temporary booking created', now, guard),
        userNoticeStmt(db, user.id, {
          type: 'hold_created',
          title: 'Slot held for you',
          body: `${where} · ${pay}`,
          link: `/bookings/${id}/pay`,
          bookingId: id,
        }, now, guard),
        staffNoticeStmt(db, {
          type: 'new_booking',
          title: 'New booking created',
          body: `${user.name} · ${where} · temporary hold${credit ? ` · ${peso(quote.creditApplied)} credit applied` : ''}`,
          link: `/admin/bookings/${id}`,
          bookingId: id,
        }, now, guard),
      );
    }
    let changes: number;
    try {
      changes = await insertBooking(db, {
        id, userId: user.id, resourceId, date, segments, scheduleVersion: version,
        status: paidByCredit ? 'CONFIRMED' : 'TEMPORARY',
        amount: quote.amountDue,
        creditApplied: quote.creditApplied,
        rate,
        holdUntil: paidByCredit ? null : now + settings.holdMinutes * 60_000,
        source: 'online',
        createdBy: user.id,
        bookerName: null,
        paymentMethod: paidByCredit ? 'none' : 'gcash',
        submittedAt: null,
        confirmedAt: paidByCredit ? now : null,
        confirmedBy: null,
      }, now, paidByCredit ? null : MAX_OPEN_HOLDS, [...redeemStmts(db, { bookingId: id, userId: user.id, uses: quote.uses, now }), ...effects, op.statement(id, now)]);
    } catch (err) {
      const replay = await op.replay();
      if (replay) return getBooking(db, replay);
      // Another booking spent the same credit a moment earlier: nothing was booked or spent.
      if (isOverspend(err)) throw creditChanged(await creditQuote(db, user.id, price, now));
      if (input.useCredit && err instanceof Error && 'code' in err && err.code === 'SCHEDULE_CHANGED') {
        const fresh = await creditQuote(db, user.id, price, now);
        if (fresh.creditApplied !== quote.creditApplied) throw creditChanged(fresh);
      }
      throw err;
    }
    if (changes === 0) await explainRefusal(db, user.id, { resourceId, date, segments, slots }, now, { checkHolds: !paidByCredit, self: true });

    return getBooking(db, id);
  } catch (err) {
    // A matching request can commit while this invocation is still validating.
    const replay = await op.replay();
    if (replay) return getBooking(db, replay);
    throw err;
  }
}

/**
 * Staff or an admin books a court or table from the console (a booking on site). It is
 * booked under their own account and records `bookerName`, who it's for. There is no
 * GCash step: it is confirmed at once, either paid at the front desk (counted as revenue)
 * or free of charge.
 */
export async function createConsoleBooking(
  env: Bindings,
  settings: Settings,
  staff: SessionUser,
  input: SlotInput & { rate: 'member' | 'non_member'; payment: 'on_site' | 'none'; bookerName: string; idempotencyKey?: string; requestIp?: string },
  now = Date.now(),
) {
  const db = env.DB;
  const { resourceId, date, rate, payment, bookerName } = input;
  const op = await bookingOperation(db, staff.id, 'console', input.idempotencyKey, {
    resourceId, date, starts: [...new Set(input.starts)].sort((a, b) => a - b), rate, payment, bookerName,
  });
  const replay = await op.replay();
  if (replay) return getBooking(db, replay);
  try {
    const { resource, segments, slots, version } = await checkSlots(env, settings, input, now);
    const source: BookingSource = staff.role === 'admin' ? 'admin' : 'staff';
    const amount = payment === 'none' ? 0 : (rate === 'member' ? resource.price_member : resource.price_non_member) * slots;
    const id = newId('b_');
    const guard: Guard = { sql: 'EXISTS (SELECT 1 FROM bookings WHERE id = ?)', params: [id] };
    const effects = [
      eventStmt(db, id, 'console_booked', staff.id, 'staff', payment === 'on_site' ? `Paid on site · ${peso(amount)}` : 'No charge', now, guard),
      systemMessageStmt(db, id, `Booked on site by ${source === 'admin' ? 'an admin' : 'staff'} · confirmed`, now, guard),
      db.prepare(`INSERT INTO audit_log (actor_id, action, entity, entity_id, detail, ip, created_at)
        SELECT ?, 'booking_created_on_site', 'booking', ?, ?, ?, ? WHERE ${guard.sql}`)
        .bind(staff.id, id, JSON.stringify({ payment, slots }), input.requestIp ?? null, now, ...guard.params),
      op.statement(id, now),
    ];
    const changes = await insertBooking(db, {
      id, userId: staff.id, resourceId, date, segments, scheduleVersion: version, status: 'CONFIRMED', amount, creditApplied: 0, rate, holdUntil: null,
      source, createdBy: staff.id, bookerName, paymentMethod: payment,
      // Paid at the desk counts as a verified payment for revenue; a free booking has no payment.
      submittedAt: payment === 'on_site' ? now : null,
      confirmedAt: now,
      confirmedBy: staff.id,
    }, now, null, effects, staff);
    if (changes === 0) await explainRefusal(db, staff.id, { resourceId, date, segments, slots }, now, { checkHolds: false, self: false });

    return getBooking(db, id);
  } catch (err) {
    // A matching request can commit while this invocation is still validating.
    const replay = await op.replay();
    if (replay) return getBooking(db, replay);
    throw err;
  }
}

// ── Player actions ─────────────────────────────────────────────────────────

export async function releaseHold(env: Bindings, user: SessionUser, bookingId: string, now = Date.now()) {
  const db = env.DB;
  const g = bookingTransition(bookingId);
  const [update] = await db.batch([
    db
      .prepare(
        `UPDATE bookings SET status = 'CANCELLED', cancelled_at = ?1, cancelled_by = ?2, cancel_reason = 'Released by player', hold_expires_at = NULL, updated_at = ?1, transition_id = ?4
          WHERE id = ?3 AND user_id = ?2 AND status IN ('TEMPORARY', 'REJECTED') AND hold_expires_at > ?1`,
      )
      .bind(now, user.id, bookingId, g.id),
    eventStmt(db, bookingId, 'released', user.id, 'player', null, now, g),
    systemMessageStmt(db, bookingId, 'Hold released by the player', now, g),
    resolveStaffStmt(db, bookingId, ['new_booking', 'hold_expiring', 'proof_submitted'], now, g),
    // A hold paid partly with booking credit gives that credit back.
    ...releaseStmts(db, 'b.id = ? AND b.transition_id = ?', [bookingId, g.id], now),
  ]);
  if (!update?.meta.changes) throw conflict('INVALID_STATUS', 'This hold has already ended.');
}

/**
 * Policy (REBOOKING.md §4): players never cancel a booking. Unpaid holds can be released
 * (releaseHold); everything else goes through the booking chat, and only Le Spinners cancels,
 * issuing a booking credit (lib/disruptions.ts).
 */
export async function cancelByPlayer(env: Bindings, user: SessionUser, bookingId: string): Promise<never> {
  const b = await getBooking(env.DB, bookingId);
  if (b.user_id !== user.id) throw notFound('Booking not found.');
  throw conflict('NOT_CANCELLABLE', "Booked and paid bookings can't be cancelled. Message staff in the booking chat if your plans change.");
}

// ── Timeline ───────────────────────────────────────────────────────────────

const EVENT_LABELS: Record<string, string> = {
  created: 'Temporary booking created',
  console_booked: 'Booked on site · confirmed',
  proof_submitted: 'Payment proof submitted',
  approved: 'Payment verified · booking confirmed',
  rejected: 'Payment proof rejected',
  expired: 'Booking expired',
  released: 'Hold released',
  cancelled: 'Booking cancelled',
  completed: 'Booking completed',
  disrupted: 'Cancelled by Le Spinners',
  partially_disrupted: 'Part of the booking credited',
  credit_booked: 'Booked with booking credit · confirmed',
  credit_applied: 'Booking credit applied',
  credit_restored: 'Booking credit returned',
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
