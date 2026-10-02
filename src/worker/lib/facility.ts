import * as z from 'zod';
import type { AppContext, BookingStatus, ResourceRow, SessionUser } from '../types';
import { audit } from './auth';
import { OCCUPYING, SEGMENTS_SQL, resourceStatus, slotLabel, type HoursRow } from './bookings';
import { newId } from './crypto';
import { conflict, forbidden, notFound, unprocessable } from './errors';
import { addDays, dateLabel, localNow, offsetMinutes, peso } from './time';
import { zActivity, zDate, zId } from './validate';

/**
 * Facility changes (maintenance, open play, disabling a court, closures, weekly hours) never
 * touch bookings. Before one is applied, the server lists the active bookings it
 * would affect and refuses with 409 AFFECTS_BOOKINGS until the request names every
 * one of them in `confirmAffected`. Staff then follow up per booking (chat, or the
 * existing cancel flow). Nothing is cancelled or rewritten automatically.
 */
export const zConfirmAffected = z.array(zId).max(500).optional();

type AffectedRow = {
  id: string;
  ref: string;
  status: BookingStatus;
  date: string;
  start_min: number;
  end_min: number;
  segments_json: string | null;
  resource_name: string;
  user_name: string;
};

export type ImpactScope =
  | { kind: 'resource'; resourceId: string; until: string | null }
  | { kind: 'closure'; date: string; resourceId: string | null; start: number | null; end: number | null }
  | { kind: 'hours'; weekday: number; isOpen: boolean; open: number; close: number; slotMinutes: number };

/** Active bookings (held, verifying or confirmed) that haven't ended yet and fall inside `scope`. */
export async function affectedBookings(c: AppContext, scope: ImpactScope, now = Date.now()) {
  const local = localNow(offsetMinutes(c.env.TZ_OFFSET_MINUTES), now);
  let where: string;
  let params: (string | number | null)[];
  if (scope.kind === 'resource') {
    // Maintenance with a back-on date only blocks the days before it; open play and disabling block every day.
    where = 'b.resource_id = ?4 AND (?5 IS NULL OR b.date < ?5)';
    params = [scope.resourceId, scope.until];
  } else if (scope.kind === 'closure') {
    where = `b.date = ?4 AND (?5 IS NULL OR b.resource_id = ?5)
             AND (?6 IS NULL OR EXISTS (SELECT 1 FROM booking_times t WHERE t.booking_id = b.id AND t.start_min < ?7 AND t.end_min > ?6))`;
    params = [scope.date, scope.resourceId, scope.start, scope.end];
  } else {
    // Any booked time outside the new hours, or no longer on the new slot grid.
    where = `CAST(strftime('%w', b.date) AS INTEGER) = ?4
             AND (?5 = 0 OR EXISTS (SELECT 1 FROM booking_times t WHERE t.booking_id = b.id
                                      AND (t.start_min < ?6 OR t.end_min > ?7 OR (t.start_min - ?6) % ?8 != 0)))`;
    params = [scope.weekday, scope.isOpen ? 1 : 0, scope.open, scope.close, scope.slotMinutes];
  }
  const { results } = await c.env.DB.prepare(
    `SELECT b.id, b.ref, b.status, b.date, b.start_min, b.end_min, ${SEGMENTS_SQL('b')}, r.name AS resource_name, COALESCE(b.booker_name, u.name) AS user_name
       FROM bookings b JOIN resources r ON r.id = b.resource_id JOIN users u ON u.id = b.user_id
      WHERE ${OCCUPYING('b', '?1')} AND (b.date > ?2 OR (b.date = ?2 AND b.end_min > ?3)) AND ${where}
      ORDER BY b.date, b.start_min, r.sort_order
      LIMIT 500`,
  )
    .bind(now, local.date, local.minutes, ...params)
    .all<AffectedRow>();
  return results;
}

function affectedDTO(b: AffectedRow) {
  return {
    id: b.id,
    ref: b.ref,
    status: b.status,
    userName: b.user_name,
    resourceName: b.resource_name,
    date: b.date,
    dateLabel: dateLabel(b.date),
    timeLabel: slotLabel(b),
  };
}

/** Throws 409 AFFECTS_BOOKINGS unless every affected booking was confirmed by id. */
export function requireConfirmation(affected: AffectedRow[], confirmed: string[] | undefined, change: string) {
  const ok = new Set(confirmed ?? []);
  const pending = affected.filter((b) => !ok.has(b.id));
  if (!pending.length) return affected.map(affectedDTO);
  const n = affected.length;
  throw conflict(
    'AFFECTS_BOOKINGS',
    `${change} affects ${n} active booking${n === 1 ? '' : 's'}. Review ${n === 1 ? 'it' : 'them'}, then confirm. Bookings are not cancelled automatically.`,
    { affected: affected.map(affectedDTO) },
  );
}

// ── Courts and tables ──────────────────────────────────────────────────────

export function resourceDTO(r: ResourceRow & { upcoming?: number }) {
  return {
    id: r.id,
    activity: r.activity,
    name: r.name,
    sortOrder: r.sort_order,
    status: resourceStatus(r),
    maintenanceNote: r.maintenance_note,
    maintenanceUntil: r.maintenance_until,
    maintenanceUntilLabel: r.maintenance_until ? dateLabel(r.maintenance_until) : null,
    priceMember: r.price_member,
    priceNonMember: r.price_non_member,
    priceMemberLabel: peso(r.price_member),
    priceNonMemberLabel: peso(r.price_non_member),
    upcomingBookings: r.upcoming ?? 0,
  };
}

const zName = z.string().trim().min(2, 'Use at least 2 characters.').max(40, 'Use at most 40 characters.');
const zPrice = z.number().int().min(0).max(10_000_000);

export const resourceUpdateSchema = z.object({
  name: zName.optional(),
  status: z.enum(['active', 'open_play', 'maintenance', 'disabled']).optional(),
  maintenanceNote: z.string().trim().max(120).nullable().optional(),
  maintenanceUntil: zDate.nullable().optional(),
  // Prices are payment configuration: administrators only.
  priceMember: zPrice.optional(),
  priceNonMember: zPrice.optional(),
  confirmAffected: zConfirmAffected,
});

export const resourceCreateSchema = z.object({
  activity: zActivity,
  name: zName,
  status: z.enum(['active', 'open_play', 'disabled']).default('active'),
  priceMember: zPrice.optional(),
  priceNonMember: zPrice.optional(),
});

type ApiStatus = 'active' | 'open_play' | 'maintenance' | 'disabled';

/** API status → the stored status and open_play flag (open play is an active resource). */
function storedStatus(status: ApiStatus): [ResourceRow['status'], 0 | 1] {
  return status === 'open_play' ? ['active', 1] : [status, 0];
}

function checkPriceRole(actor: SessionUser, body: { priceMember?: number; priceNonMember?: number }) {
  if ((body.priceMember !== undefined || body.priceNonMember !== undefined) && actor.role !== 'admin') {
    throw forbidden('Only administrators can change prices.');
  }
}

async function checkNameFree(db: D1Database, activity: string, name: string, exceptId: string | null) {
  const taken = await db
    .prepare('SELECT 1 FROM resources WHERE activity = ? AND name = ? COLLATE NOCASE AND id != ?')
    .bind(activity, name, exceptId ?? '')
    .first();
  if (taken) throw conflict('NAME_TAKEN', 'Another court or table already has that name.', { name: ['Already used.'] });
}

export async function getResource(db: D1Database, id: string): Promise<ResourceRow> {
  const row = await db.prepare('SELECT * FROM resources WHERE id = ?').bind(id).first<ResourceRow>();
  if (!row) throw notFound('Court or table not found.');
  return row;
}

/**
 * Name, status (active, open play, maintenance, disabled), maintenance details (staff and
 * admins) and prices (admins only).
 * Taking a court out of service lists the bookings it affects first.
 */
export async function updateResource(c: AppContext, actor: SessionUser, id: string, body: z.infer<typeof resourceUpdateSchema>) {
  checkPriceRole(actor, body);
  const db = c.env.DB;
  const now = Date.now();
  const today = localNow(offsetMinutes(c.env.TZ_OFFSET_MINUTES), now).date;
  const current = await getResource(db, id);
  const next = {
    name: body.name ?? current.name,
    price_member: body.priceMember ?? current.price_member,
    price_non_member: body.priceNonMember ?? current.price_non_member,
    status: body.status ?? resourceStatus(current),
    maintenance_note: body.maintenanceNote === undefined ? current.maintenance_note : body.maintenanceNote || null,
    maintenance_until: body.maintenanceUntil === undefined ? current.maintenance_until : body.maintenanceUntil,
  };
  if (next.status !== 'maintenance') {
    next.maintenance_note = null;
    next.maintenance_until = null;
  }
  if (next.name !== current.name) await checkNameFree(db, current.activity, next.name, id);

  let affected: ReturnType<typeof affectedDTO>[] = [];
  const outOfService = next.status !== 'active';
  const scheduleChanged = next.status !== resourceStatus(current) || next.maintenance_until !== current.maintenance_until;
  if (outOfService && scheduleChanged) {
    if (next.status === 'maintenance' && next.maintenance_until && next.maintenance_until <= today) {
      throw unprocessable('VALIDATION_ERROR', 'Please check the highlighted fields.', { maintenanceUntil: ['Pick a back-on date after today.'] });
    }
    const until = next.status === 'maintenance' ? next.maintenance_until : null;
    const rows = await affectedBookings(c, { kind: 'resource', resourceId: id, until }, now);
    const verb =
      next.status === 'disabled' ? `Disabling ${current.name}`
        : next.status === 'open_play' ? `Making ${current.name} open play`
          : `Putting ${current.name} into maintenance`;
    affected = requireConfirmation(rows, body.confirmAffected, verb);
  }

  const [status, openPlay] = storedStatus(next.status);
  const row = { status, open_play: openPlay };
  await db
    .prepare(
      `UPDATE resources SET name = ?, price_member = ?, price_non_member = ?, status = ?, open_play = ?, maintenance_note = ?, maintenance_until = ?, updated_at = ?
        WHERE id = ?`,
    )
    .bind(next.name, next.price_member, next.price_non_member, row.status, row.open_play, next.maintenance_note, next.maintenance_until, now, id)
    .run();
  const changed = Object.keys(body).filter((k) => k !== 'confirmAffected').join(',');
  const detail = affected.length ? `${changed}; affected ${affected.map((a) => a.ref).join(' ')}` : changed;
  c.executionCtx.waitUntil(audit(c, actor.id, 'resource_updated', 'resource', id, detail));
  return { resource: resourceDTO({ ...current, ...next, ...row }), affected };
}

/** Adds a court or table. Staff-added ones copy the prices of the same activity. */
export async function createResource(c: AppContext, actor: SessionUser, body: z.infer<typeof resourceCreateSchema>) {
  checkPriceRole(actor, body);
  const db = c.env.DB;
  await checkNameFree(db, body.activity, body.name, null);
  const template = await db
    .prepare('SELECT price_member, price_non_member, (SELECT MAX(sort_order) FROM resources WHERE activity = ?1) AS max_sort FROM resources WHERE activity = ?1 ORDER BY sort_order, name LIMIT 1')
    .bind(body.activity)
    .first<{ price_member: number; price_non_member: number; max_sort: number }>();
  const priceMember = body.priceMember ?? template?.price_member;
  const priceNonMember = body.priceNonMember ?? template?.price_non_member;
  if (priceMember === undefined || priceNonMember === undefined) {
    throw unprocessable(
      'PRICES_REQUIRED',
      actor.role === 'admin'
        ? 'This is the first one of its kind. Enter member and non-member prices.'
        : 'This is the first one of its kind, so an administrator needs to add it with its prices.',
    );
  }
  const id = newId('r_');
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO resources (id, activity, name, sort_order, status, open_play, price_member, price_non_member, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(id, body.activity, body.name, (template?.max_sort ?? 0) + 1, ...storedStatus(body.status), priceMember, priceNonMember, now, now)
    .run();
  c.executionCtx.waitUntil(audit(c, actor.id, 'resource_created', 'resource', id, `${body.activity} ${body.name}`));
  return resourceDTO(await getResource(db, id));
}

// ── Closures and weekly hours ──────────────────────────────────────────────

export const closureSchema = z
  .object({
    date: zDate,
    resourceId: zId.nullable().default(null),
    start: z.number().int().min(0).max(1440).nullable().default(null),
    end: z.number().int().min(0).max(1440).nullable().default(null),
    reason: z.string().trim().min(3, 'Give a short reason (players may see it).').max(120, 'Use at most 120 characters.'),
    confirmAffected: zConfirmAffected,
  })
  .refine((v) => (v.start === null) === (v.end === null), { message: 'Give both a start and an end time, or neither for all day.', path: ['end'] })
  .refine((v) => v.start === null || v.end === null || v.start < v.end, { message: 'The end must be after the start.', path: ['end'] });

export async function createClosure(c: AppContext, actor: SessionUser, body: z.infer<typeof closureSchema>) {
  const db = c.env.DB;
  const now = Date.now();
  const today = localNow(offsetMinutes(c.env.TZ_OFFSET_MINUTES), now).date;
  if (body.date < today) throw unprocessable('VALIDATION_ERROR', 'Please check the highlighted fields.', { date: ['Pick today or a later date.'] });
  if (body.date > addDays(today, 366)) throw unprocessable('VALIDATION_ERROR', 'Please check the highlighted fields.', { date: ['Pick a date within the next year.'] });
  const resource = body.resourceId ? await getResource(db, body.resourceId) : null;
  const rows = await affectedBookings(c, { kind: 'closure', date: body.date, resourceId: body.resourceId, start: body.start, end: body.end }, now);
  const affected = requireConfirmation(rows, body.confirmAffected, `Closing ${resource ? resource.name : 'the facility'} on ${dateLabel(body.date)}`);
  const id = newId('cl_');
  await db
    .prepare('INSERT INTO closures (id, date, resource_id, start_min, end_min, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, body.date, body.resourceId, body.start, body.end, body.reason, actor.id, now)
    .run();
  const detail = `${body.date} ${resource?.name ?? 'facility'} ${body.start ?? 'all'}-${body.end ?? 'day'}${affected.length ? `; affected ${affected.map((a) => a.ref).join(' ')}` : ''}`;
  c.executionCtx.waitUntil(audit(c, actor.id, 'closure_created', 'closure', id, detail));
  return { id, affected };
}

/** Removes an upcoming closure. Past ones stay as a record of what players saw. */
export async function deleteClosure(c: AppContext, actor: SessionUser, id: string) {
  const db = c.env.DB;
  const today = localNow(offsetMinutes(c.env.TZ_OFFSET_MINUTES)).date;
  const row = await db.prepare('SELECT id, date FROM closures WHERE id = ?').bind(id).first<{ id: string; date: string }>();
  if (!row) throw notFound('Closure not found.');
  if (row.date < today) throw conflict('CLOSURE_PAST', 'This date has passed. Past closures are kept for the record.');
  await db.prepare('DELETE FROM closures WHERE id = ?').bind(id).run();
  c.executionCtx.waitUntil(audit(c, actor.id, 'closure_removed', 'closure', id, row.date));
}

const zMinute = z.number().int().min(0).max(1440).refine((m) => m % 30 === 0, 'Use whole or half hours.');

export const hoursSchema = z
  .object({
    isOpen: z.boolean(),
    open: zMinute,
    close: zMinute,
    confirmAffected: zConfirmAffected,
  })
  .refine((v) => !v.isOpen || v.open < v.close, { message: 'Closing time must be after opening time.', path: ['close'] });

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export async function setWeeklyHours(c: AppContext, actor: SessionUser, weekday: number, slotMinutes: number, body: z.infer<typeof hoursSchema>) {
  if (body.isOpen && body.close - body.open < slotMinutes) {
    throw unprocessable('VALIDATION_ERROR', 'Please check the highlighted fields.', { close: [`Open for at least one ${slotMinutes}-minute slot.`] });
  }
  const db = c.env.DB;
  const current = await db.prepare('SELECT * FROM opening_hours WHERE weekday = ?').bind(weekday).first<HoursRow>();
  const rows = await affectedBookings(c, { kind: 'hours', weekday, isOpen: body.isOpen, open: body.open, close: body.close, slotMinutes });
  const affected = requireConfirmation(rows, body.confirmAffected, `Changing ${WEEKDAYS[weekday]} hours`);
  await db
    .prepare(
      `INSERT INTO opening_hours (weekday, is_open, open_min, close_min) VALUES (?, ?, ?, ?)
       ON CONFLICT (weekday) DO UPDATE SET is_open = excluded.is_open, open_min = excluded.open_min, close_min = excluded.close_min`,
    )
    .bind(weekday, body.isOpen ? 1 : 0, body.open, body.close)
    .run();
  const before = current ? `${current.is_open ? `${current.open_min}-${current.close_min}` : 'closed'}` : 'unset';
  const after = body.isOpen ? `${body.open}-${body.close}` : 'closed';
  const detail = `${WEEKDAYS[weekday]} ${before} -> ${after}${affected.length ? `; affected ${affected.map((a) => a.ref).join(' ')}` : ''}`;
  c.executionCtx.waitUntil(audit(c, actor.id, 'hours_updated', 'opening_hours', String(weekday), detail));
  return { affected };
}