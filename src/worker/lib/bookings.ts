import * as z from 'zod';
import type { Activity, Bindings, BookingRow, BookingSource, BookingStatus, PaymentMethod, ResourceRow, SessionUser } from '../types';
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
         ${SEGMENTS_SQL('b')}
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

export function paymentMethodLabel(m: PaymentMethod): string {
  return METHOD_LABEL[m];
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
    canCancel: false, // booked or paid bookings can't be cancelled
    cancelDeadline,
    source: b.source,
    paymentMethod: b.payment_method,
    paymentMethodLabel: METHOD_LABEL[b.payment_method],
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
  const starts = [...new Set(input.starts)].sort((a, b) => a - b);
  if (!starts.length || starts.length > MAX_SLOTS || starts.some((s) => !Number.isInteger(s))) {
    throw unprocessable('INVALID_SLOT', 'Pick one or more of the listed times.');
  }

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

  // Release stale holds first so they can't trip the unique index.
  await sweepExpired(env, now);
  return { resource, segments, slots: starts.length };
}

type NewBooking = {
  id: string;
  userId: string;
  resourceId: string;
  date: string;
  segments: Segment[];
  status: 'TEMPORARY' | 'CONFIRMED';
  amount: number;
  rate: 'member' | 'non_member';
  holdUntil: number | null;
  source: BookingSource;
  createdBy: string;
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
 * booking of the same user (INSERT … WHERE NOT EXISTS, evaluated atomically); the times
 * are inserted only if the booking was. Returns rows inserted (0 or 1).
 */
async function insertBooking(db: D1Database, row: NewBooking, now: number, maxOpenHolds: number | null): Promise<number> {
  const segs = JSON.stringify(row.segments.map((s) => [s.start, s.end]));
  const start = row.segments[0]!.start;
  const end = row.segments[row.segments.length - 1]!.end;
  const holdCap = maxOpenHolds != null
    ? `AND (SELECT COUNT(*) FROM bookings b WHERE b.user_id = ?2 AND b.status = 'TEMPORARY' AND b.hold_expires_at > ?10) < ${maxOpenHolds}`
    : '';
  const insert = db
    .prepare(
      `INSERT INTO bookings (id, ref, user_id, resource_id, date, start_min, end_min, status, amount_due, rate, hold_expires_at, created_at, updated_at,
                             source, created_by, payment_method, submitted_at, confirmed_at, confirmed_by)
       SELECT ?1,
              'LS-' || replace(?4, '-', '') || '-' || printf('%03d', COALESCE((SELECT MAX(CAST(substr(ref, -3) AS INTEGER)) FROM bookings WHERE date = ?4), 0) + 1),
              ?2, ?3, ?4, ?5, ?6, ?11, ?7, ?8, ?9, ?10, ?10, ?12, ?13, ?14, ?15, ?16, ?17
        WHERE NOT ${clashSql('t.resource_id = ?3', '?4', '?18', '?10')}
          AND NOT ${clashSql('b.user_id = ?2', '?4', '?18', '?10')}
          ${holdCap}`,
    )
    .bind(
      row.id, row.userId, row.resourceId, row.date, start, end, row.amount, row.rate, row.holdUntil, now,
      row.status, row.source, row.createdBy, row.paymentMethod, row.submittedAt, row.confirmedAt, row.confirmedBy, segs,
    );
  const times = db
    .prepare(
      `INSERT INTO booking_slots (booking_id, resource_id, date, start_min, end_min)
       SELECT ?1, ?2, ?3, json_extract(n.value, '$[0]'), json_extract(n.value, '$[1]') FROM json_each(?4) n
        WHERE EXISTS (SELECT 1 FROM bookings WHERE id = ?1)`,
    )
    .bind(row.id, row.resourceId, row.date, segs);
  try {
    const [res] = await db.batch([insert, times]);
    return res?.meta.changes ?? 0;
  } catch (err) {
    if (!String(err).includes('UNIQUE')) throw err;
    return 0; // lost a race on the exact slot
  }
}

/** Says why insertBooking inserted nothing. */
async function explainRefusal(
  db: D1Database,
  userId: string,
  input: { date: string; segments: Segment[]; slots: number },
  now: number,
  opts: { checkHolds: boolean; self: boolean },
): Promise<never> {
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

export async function createHold(env: Bindings, settings: Settings, user: SessionUser, input: SlotInput, now = Date.now()) {
  const db = env.DB;
  const { resourceId, date } = input;
  const { resource, segments, slots } = await checkSlots(env, settings, input, now);

  const rate = user.membership === 'member' ? 'member' : 'non_member';
  const amount = (rate === 'member' ? resource.price_member : resource.price_non_member) * slots;
  const id = newId('b_');
  const changes = await insertBooking(db, {
    id, userId: user.id, resourceId, date, segments, status: 'TEMPORARY', amount, rate,
    holdUntil: now + settings.holdMinutes * 60_000, source: 'online', createdBy: user.id, paymentMethod: 'gcash',
    submittedAt: null, confirmedAt: null, confirmedBy: null,
  }, now, MAX_OPEN_HOLDS);
  if (changes === 0) await explainRefusal(db, user.id, { date, segments, slots }, now, { checkHolds: true, self: true });

  const where = `${resource.name} · ${dateLabel(date)} · ${whenLabel(segments, slots)}`;
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

/**
 * Staff or an admin books a court or table for themselves from the console (a personal
 * booking on site). There is no GCash step: it is confirmed at once, either paid at the
 * front desk (counted as revenue) or free of charge.
 */
export async function createConsoleBooking(
  env: Bindings,
  settings: Settings,
  staff: SessionUser,
  input: SlotInput & { rate: 'member' | 'non_member'; payment: 'on_site' | 'none' },
  now = Date.now(),
) {
  const db = env.DB;
  const { resourceId, date, rate, payment } = input;
  const { resource, segments, slots } = await checkSlots(env, settings, input, now);
  const source: BookingSource = staff.role === 'admin' ? 'admin' : 'staff';
  const amount = payment === 'none' ? 0 : (rate === 'member' ? resource.price_member : resource.price_non_member) * slots;
  const id = newId('b_');
  const changes = await insertBooking(db, {
    id, userId: staff.id, resourceId, date, segments, status: 'CONFIRMED', amount, rate, holdUntil: null,
    source, createdBy: staff.id, paymentMethod: payment,
    // Paid at the desk counts as a verified payment for revenue; a free booking has no payment.
    submittedAt: payment === 'on_site' ? now : null,
    confirmedAt: now,
    confirmedBy: staff.id,
  }, now, null);
  if (changes === 0) await explainRefusal(db, staff.id, { date, segments, slots }, now, { checkHolds: false, self: false });

  await db.batch([
    eventStmt(db, id, 'console_booked', staff.id, 'staff', payment === 'on_site' ? `Paid on site · ${peso(amount)}` : 'No charge', now),
    systemMessageStmt(db, id, `Booked on site by ${source === 'admin' ? 'an admin' : 'staff'} · confirmed`, now),
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

/**
 * Policy: a booking with a submitted payment or a confirmation can't be cancelled
 * (by the player or by staff). Unpaid holds are released instead (releaseHold).
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
