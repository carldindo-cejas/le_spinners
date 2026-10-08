import * as z from 'zod';
import { MAINTENANCE_BATCH_SIZE } from './limits';
import type { Activity, AppContext, Bindings, BookingRow, BookingStatus, Role, SessionUser } from '../types';
import { ApiError, conflict, forbidden, notFound, unprocessable } from './errors';
import { newId, sha256Hex } from './crypto';
import { SEGMENTS_SQL, effectiveStatus, segmentsOf, type Segment } from './bookings';
import { SQL_ID, releaseStmts } from './credits';
import { DAY_MS, dateLabel, daysBetween, isValidDate, localNow, localToMs, minutesLabel, offsetMinutes, peso } from './time';
import { zActivity, zDate, zId } from './validate';
import { scheduleBatch, scheduleVersion } from './schedule';

/**
 * Operator cancellations and facility disruptions (REBOOKING.md §4–§6, §14).
 *
 * One engine for one booking or a whole closure:
 *   buildPlan        pure decision per affected booking (no writes) → preview + previewToken
 *   applyDisruption  rebuilds the plan, checks the token, then ONE D1 batch (one transaction)
 *                    of set-based statements, whatever the number of bookings
 *   resolveItem      finishes a booking that was deferred (payment waiting) or skipped
 *
 * Each booking update requires the status and updated_at the plan saw, so a booking that changed
 * in between is skipped (never cancelled or credited twice). Customers never reach this code.
 */

export const CATEGORIES = [
  'weather', 'unsafe_conditions', 'maintenance', 'equipment_failure', 'emergency', 'facility_error', 'customer_request', 'other',
] as const;
export type Category = (typeof CATEGORIES)[number];

export const CATEGORY_LABEL: Record<Category, string> = {
  weather: 'Weather',
  unsafe_conditions: 'Unsafe conditions',
  maintenance: 'Maintenance',
  equipment_failure: 'Equipment failure',
  emergency: 'Emergency',
  facility_error: 'Facility error',
  customer_request: 'Customer request',
  other: 'Other',
};

/** Bookings one disruption may touch (one facility day has at most about 90 court-hours). */
export const MAX_DISRUPTION_BOOKINGS = 150;
/** Admins may record a disruption this many days back; staff only from the start of today. */
export const ADMIN_RETRO_DAYS = 7;

// ── Request schemas ─────────────────────────────────────────────────────────

const zMinuteOfDay = z.number().int().min(0).max(1440);

const windowScope = z.strictObject({
  kind: z.literal('window'),
  date: zDate,
  start: zMinuteOfDay,
  end: zMinuteOfDay,
  activity: zActivity.nullable().default(null),
  resourceId: zId.nullable().default(null),
});

const bookingsScope = z.strictObject({
  kind: z.literal('bookings'),
  bookingIds: z.array(zId).min(1, 'Pick at least one booking.').max(MAX_DISRUPTION_BOOKINGS),
  /** When it stopped being playable (epoch ms). Default: now. Before the booking starts = the whole booking. */
  effectiveFrom: z.number().int().positive().nullable().default(null),
  /** Also close the affected times for new bookings. */
  closeSlots: z.boolean().default(false),
});

const disruptionShape = {
  scope: z.discriminatedUnion('kind', [windowScope, bookingsScope]),
  category: z.enum(CATEGORIES),
  reason: z.string().trim().min(3, 'Give a short reason players will see.').max(120, 'Keep the reason under 120 characters.'),
  staffNote: z.string().trim().max(500, 'Keep the note under 500 characters.').nullable().default(null),
  compensation: z.enum(['credit', 'none']).default('credit'),
  /** Staff choice for bookings that haven't started and are only partly affected. */
  overrides: z.array(z.strictObject({ bookingId: zId, action: z.enum(['cancel', 'keep']) })).max(MAX_DISRUPTION_BOOKINGS).default([]),
};

export const previewSchema = z.strictObject(disruptionShape);
export const applySchema = z.strictObject({ ...disruptionShape, previewToken: z.string().regex(/^[a-f0-9]{64}$/, 'Preview the change first.') });
export type DisruptionInput = z.infer<typeof previewSchema>;

export const idempotencyKeySchema = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/, 'Send an Idempotency-Key header (8–100 letters, digits, - or _).');

// ── Planning ────────────────────────────────────────────────────────────────

type Candidate = BookingRow & {
  resource_name: string;
  activity: Activity;
  user_name: string;
  user_email: string;
  user_role: Role;
  segments_json: string | null;
};

const CANDIDATE_SELECT = `
  SELECT b.*, r.name AS resource_name, r.activity AS activity, u.name AS user_name, u.email AS user_email, u.role AS user_role,
         ${SEGMENTS_SQL('b')}
    FROM bookings b JOIN resources r ON r.id = b.resource_id JOIN users u ON u.id = b.user_id`;

export type Action = 'cancel' | 'keep' | 'defer';

export type PlanItem = {
  booking: Candidate;
  effective: BookingStatus;
  action: Action;
  /** Staff may switch between cancel and keep (booking not started, only partly affected). */
  canChoose: boolean;
  segments: Segment[];
  affected: Segment[];
  bookedMin: number;
  affectedMin: number;
  paidValue: number;
  credit: number;
  /** For bookings whose payment is still waiting: the credit once it is verified. */
  projectedCredit: number;
  flags: string[];
  whereLabel: string;
  affectedLabel: string;
};

type NotAffected = { booking: Candidate; reason: 'ended' | 'outside' | 'already_compensated' };

export type Plan = {
  scheduleVersion: number;
  input: DisruptionInput;
  items: PlanItem[];
  notAffected: NotAffected[];
  closures: { resourceId: string | null; date: string; start: number; end: number }[];
  scopeLabel: string;
  previewToken: string;
};

const minutesOf = (segs: Segment[]) => segs.reduce((n, s) => n + s.end - s.start, 0);
const rangesLabel = (segs: Segment[]) => segs.map((s) => `${minutesLabel(s.start)} – ${minutesLabel(s.end)}`).join(', ');

function clip(segs: Segment[], from: number, to: number): Segment[] {
  return segs.map((s) => ({ start: Math.max(s.start, from), end: Math.min(s.end, to) })).filter((s) => s.start < s.end);
}

/** `segs` minus every range in `minus`. */
export function subtractRanges(segs: Segment[], minus: Segment[]): Segment[] {
  let out = segs.map((s) => ({ ...s }));
  for (const m of minus) {
    const next: Segment[] = [];
    for (const s of out) {
      if (m.end <= s.start || m.start >= s.end) {
        next.push(s);
        continue;
      }
      if (m.start > s.start) next.push({ start: s.start, end: m.start });
      if (m.end < s.end) next.push({ start: m.end, end: s.end });
    }
    out = next;
  }
  return out;
}

function parseSegments(json: string | null): Segment[] {
  try {
    const arr = JSON.parse(json ?? '[]') as unknown[];
    return arr
      .filter((x): x is [number, number] => Array.isArray(x) && Number.isInteger(x[0]) && Number.isInteger(x[1]))
      .map(([start, end]) => ({ start, end }));
  } catch {
    return [];
  }
}

/** Fills defaults that depend on the clock, so the preview and the confirmation agree. */
function normalize(input: DisruptionInput, now: number): DisruptionInput {
  if (input.scope.kind !== 'bookings' || input.scope.effectiveFrom != null) return input;
  return { ...input, scope: { ...input.scope, effectiveFrom: Math.floor(now / 60_000) * 60_000 } };
}

function retroNotAllowed() {
  return new ApiError(403, 'RETRO_NOT_ALLOWED', 'Staff can record disruptions from today onward. Ask an administrator to record an earlier one.');
}

/** Role rules that the UI also shows: customer requests, no compensation and retro records are admin-only. */
function checkPermissions(actor: SessionUser, input: DisruptionInput, now: number, offset: number) {
  const admin = actor.role === 'admin';
  if (input.category === 'customer_request' && !admin) throw forbidden("Only administrators can cancel a booking at the customer's request.");
  if (input.compensation === 'none' && !admin) throw forbidden('Only administrators can cancel without a booking credit.');
  const local = localNow(offset, now);
  const field = (key: string, msg: string) => unprocessable('VALIDATION_ERROR', 'Please check the highlighted fields.', { [key]: [msg] });
  if (input.scope.kind === 'window') {
    const { date, start, end } = input.scope;
    if (!isValidDate(date)) throw field('scope.date', 'Use a real date.');
    if (start >= end) throw field('scope.end', 'The end must be after the start.');
    const back = daysBetween(date, local.date);
    if (back > 0 && !admin) throw retroNotAllowed();
    if (back > ADMIN_RETRO_DAYS) throw field('scope.date', `Disruptions can be recorded up to ${ADMIN_RETRO_DAYS} days back.`);
    if (-back > 366) throw field('scope.date', 'Pick a date within the next year.');
  } else {
    const from = input.scope.effectiveFrom ?? now;
    const dayStart = localToMs(local.date, 0, offset);
    if (from < dayStart && !admin) throw retroNotAllowed();
    if (from < dayStart - ADMIN_RETRO_DAYS * DAY_MS) throw field('scope.effectiveFrom', `Disruptions can be recorded up to ${ADMIN_RETRO_DAYS} days back.`);
    if (from > now + 366 * DAY_MS) throw field('scope.effectiveFrom', 'Pick a time within the next year.');
  }
}

/** The part of the day a disruption covers for booking `b`, or null when it doesn't reach that day. */
function intervalFor(input: DisruptionInput, b: Candidate, offset: number): [number, number] | null {
  if (input.scope.kind === 'window') return [input.scope.start, input.scope.end];
  const eff = localNow(offset, input.scope.effectiveFrom ?? Date.now());
  if (eff.date < b.date) return [0, 1440];
  if (eff.date > b.date) return null;
  return [eff.minutes, 1440];
}

/** The decision for one booking (REBOOKING.md §6.2). Pure. */
export function decide(
  b: Candidate,
  input: DisruptionInput,
  prior: Segment[],
  now: number,
  offset: number,
  override: 'cancel' | 'keep' | undefined,
): PlanItem | NotAffected {
  const effective = effectiveStatus(b, now);
  if (effective === 'EXPIRED' || effective === 'CANCELLED') return { booking: b, reason: 'ended' };
  const segments = segmentsOf(b);
  const interval = intervalFor(input, b, offset);
  const inWindow = interval ? clip(segments, interval[0], interval[1]) : [];
  if (!inWindow.length) return { booking: b, reason: 'outside' };
  const affected = subtractRanges(inWindow, prior);
  if (!affected.length) return { booking: b, reason: 'already_compensated' };

  const local = localNow(offset, now);
  const started = b.date < local.date || (b.date === local.date && segments[0]!.start <= local.minutes);
  const bookedMin = minutesOf(segments);
  const affectedMin = minutesOf(affected);
  // What a booking will still let them play once the affected and already-credited minutes are gone.
  const playable = subtractRanges(subtractRanges(segments, inWindow), prior);
  const verifiedValue = b.amount_due + b.credit_applied;
  const paidValue = effective === 'CONFIRMED' || effective === 'COMPLETED' ? verifiedValue : 0;
  const remaining = Math.max(0, paidValue - b.compensated_amount);
  const prorated = (value: number) => Math.floor((value * affectedMin) / bookedMin);
  const flags: string[] = [];
  let action: Action;
  let canChoose = false;
  let credit = 0;
  let projectedCredit = 0;

  if (effective === 'TEMPORARY' || effective === 'REJECTED') {
    action = 'cancel';
    flags.push('hold');
    if (b.credit_applied > 0) flags.push('credit_returned');
  } else if (effective === 'PAYMENT_SUBMITTED') {
    action = 'defer';
    flags.push('verify_first');
    // Once verified it is decided like a confirmed booking: not started → cancelled in full.
    const owed = Math.max(0, verifiedValue - b.compensated_amount);
    projectedCredit = started ? Math.min(owed, prorated(verifiedValue)) : owed;
  } else if (effective === 'CONFIRMED' && !started) {
    canChoose = playable.length > 0;
    action = canChoose ? override ?? 'cancel' : 'cancel';
    credit = action === 'cancel' ? remaining : Math.min(remaining, prorated(paidValue));
  } else {
    action = 'keep';
    flags.push(effective === 'COMPLETED' ? 'finished' : 'in_progress');
    credit = Math.min(remaining, prorated(paidValue));
  }

  if ((effective === 'CONFIRMED' || effective === 'COMPLETED') && paidValue === 0) flags.push('free');
  if (b.user_role !== 'player') {
    if (credit > 0 || projectedCredit > 0) flags.push('staff_booking');
    credit = 0;
    projectedCredit = 0;
  }
  if (input.compensation === 'none') {
    if (credit > 0 || projectedCredit > 0) flags.push('no_compensation');
    credit = 0;
    projectedCredit = 0;
  }

  return {
    booking: b,
    effective,
    action,
    canChoose,
    segments,
    affected,
    bookedMin,
    affectedMin,
    paidValue,
    credit,
    projectedCredit,
    flags,
    whereLabel: `${b.resource_name} · ${dateLabel(b.date)} · ${rangesLabel(segments)}`,
    affectedLabel: rangesLabel(affected),
  };
}

const isItem = (x: PlanItem | NotAffected): x is PlanItem => 'action' in x;

/** Minutes already credited per booking, from earlier disruptions. */
async function priorSegments(db: D1Database, bookingIds: string[]): Promise<Map<string, Segment[]>> {
  const out = new Map<string, Segment[]>();
  if (!bookingIds.length) return out;
  const { results } = await db
    .prepare(
      `SELECT booking_id, affected_segments FROM disruption_items
        WHERE booking_id IN (SELECT value FROM json_each(?1)) AND outcome IN ('cancelled', 'partial')`,
    )
    .bind(JSON.stringify(bookingIds))
    .all<{ booking_id: string; affected_segments: string }>();
  for (const r of results) out.set(r.booking_id, [...(out.get(r.booking_id) ?? []), ...parseSegments(r.affected_segments)]);
  return out;
}

type PlanOptions = { onlyBookingIds?: string[]; skipPermissions?: boolean };

/** Everything a disruption would do, computed without writing anything. */
export async function buildPlan(c: AppContext, actor: SessionUser, raw: DisruptionInput, now: number, opts: PlanOptions = {}): Promise<Plan> {
  const db = c.env.DB;
  const version = await scheduleVersion(db);
  const offset = offsetMinutes(c.env.TZ_OFFSET_MINUTES);
  const input = normalize(raw, now);
  if (!opts.skipPermissions) checkPermissions(actor, input, now, offset);
  const local = localNow(offset, now);

  let rows: Candidate[];
  let scopeLabel: string;
  let closureResources: (string | null)[] = [];
  if (input.scope.kind === 'window') {
    const s = input.scope;
    let activity = s.activity;
    if (s.resourceId) {
      const r = await db.prepare('SELECT id, name, activity FROM resources WHERE id = ?').bind(s.resourceId).first<{ id: string; name: string; activity: Activity }>();
      if (!r) throw notFound('Court or table not found.');
      activity = r.activity;
      scopeLabel = r.name;
      closureResources = [r.id];
    } else if (activity) {
      const { results } = await db
        .prepare(`SELECT id FROM resources WHERE activity = ? AND status != 'disabled' ORDER BY sort_order, name`)
        .bind(activity)
        .all<{ id: string }>();
      scopeLabel = activity === 'pickleball' ? 'All pickleball courts' : 'All table-tennis tables';
      closureResources = results.map((r) => r.id);
    } else {
      scopeLabel = 'Whole facility';
      closureResources = [null];
    }
    const only = opts.onlyBookingIds ? JSON.stringify(opts.onlyBookingIds) : null;
    rows = (
      await db
        .prepare(
          `${CANDIDATE_SELECT}
            WHERE b.date = ?1 AND (?2 IS NULL OR r.activity = ?2) AND (?3 IS NULL OR b.resource_id = ?3)
              AND b.status IN ('TEMPORARY', 'REJECTED', 'PAYMENT_SUBMITTED', 'CONFIRMED', 'COMPLETED')
              AND (b.status NOT IN ('TEMPORARY', 'REJECTED') OR b.hold_expires_at > ?6)
              AND EXISTS (SELECT 1 FROM booking_times t WHERE t.booking_id = b.id AND t.start_min < ?5 AND t.end_min > ?4)
              AND (?8 IS NULL OR b.id IN (SELECT value FROM json_each(?8)))
            ORDER BY b.start_min, r.sort_order, b.id
            LIMIT ?7`,
        )
        .bind(s.date, activity, s.resourceId, s.start, s.end, now, MAX_DISRUPTION_BOOKINGS + 1, only)
        .all<Candidate>()
    ).results;
  } else {
    const ids = [...new Set(opts.onlyBookingIds ?? input.scope.bookingIds)];
    rows = (
      await db
        .prepare(`${CANDIDATE_SELECT} WHERE b.id IN (SELECT value FROM json_each(?1)) ORDER BY b.date, b.start_min, b.id`)
        .bind(JSON.stringify(ids))
        .all<Candidate>()
    ).results;
    if (rows.length !== ids.length) throw notFound('Booking not found.');
    scopeLabel = rows.length === 1 ? rows[0]!.ref : `${rows.length} bookings`;
  }
  if (rows.length > MAX_DISRUPTION_BOOKINGS) {
    throw unprocessable('TOO_MANY_BOOKINGS', `This affects more than ${MAX_DISRUPTION_BOOKINGS} bookings. Choose a shorter time range or fewer courts and tables.`);
  }

  const prior = await priorSegments(db, rows.map((b) => b.id));
  const overrides = new Map(input.overrides.map((o) => [o.bookingId, o.action]));
  const items: PlanItem[] = [];
  const notAffected: NotAffected[] = [];
  for (const b of rows) {
    const d = decide(b, input, prior.get(b.id) ?? [], now, offset, overrides.get(b.id));
    if (isItem(d)) items.push(d);
    else notAffected.push(d);
  }

  // New bookings are blocked for the closed times that are still ahead.
  const closures: Plan['closures'] = [];
  const stillAhead = (date: string, end: number) => date > local.date || (date === local.date && end > local.minutes);
  if (input.scope.kind === 'window') {
    const s = input.scope;
    if (stillAhead(s.date, s.end)) for (const resourceId of closureResources) closures.push({ resourceId, date: s.date, start: s.start, end: s.end });
  } else if (input.scope.closeSlots) {
    for (const i of items) {
      if (i.action === 'defer') continue;
      for (const seg of i.affected) {
        if (stillAhead(i.booking.date, seg.end)) closures.push({ resourceId: i.booking.resource_id, date: i.booking.date, start: seg.start, end: seg.end });
      }
    }
  }

  const fingerprint = {
    input,
    items: items.map((i) => [i.booking.id, i.booking.status, i.booking.updated_at, i.action, i.credit, i.affectedMin]),
    closures,
  };
  return { input, items, notAffected, closures, scopeLabel, scheduleVersion: version, previewToken: await sha256Hex(JSON.stringify(fingerprint)) };
}

const FLAG_LABEL: Record<string, string> = {
  hold: 'Hold — nothing paid',
  credit_returned: 'Credit it used is returned',
  verify_first: 'Verify the payment first',
  in_progress: 'Already started',
  finished: 'Already finished',
  free: 'Free booking',
  staff_booking: 'Staff booking — settle at the desk',
  no_compensation: 'No credit (admin decision)',
};

const NOT_AFFECTED_LABEL: Record<NotAffected['reason'], string> = {
  ended: 'Already ended',
  outside: 'Outside the time',
  already_compensated: 'Already credited',
};

/** What staff see before confirming. */
export function previewDTO(plan: Plan) {
  const sum = (f: (i: PlanItem) => number) => plan.items.reduce((n, i) => n + f(i), 0);
  return {
    input: plan.input,
    previewToken: plan.previewToken,
    scopeLabel: plan.scopeLabel,
    items: plan.items.map((i) => ({
      bookingId: i.booking.id,
      ref: i.booking.ref,
      userName: i.booking.booker_name ?? i.booking.user_name,
      resourceName: i.booking.resource_name,
      activity: i.booking.activity,
      date: i.booking.date,
      dateLabel: dateLabel(i.booking.date),
      timeLabel: rangesLabel(i.segments),
      affectedLabel: i.affectedLabel,
      status: i.effective,
      paymentMethod: i.booking.payment_method,
      paidValue: i.paidValue,
      paidLabel: peso(i.paidValue),
      action: i.action,
      canChoose: i.canChoose,
      bookedMin: i.bookedMin,
      affectedMin: i.affectedMin,
      credit: i.credit,
      creditLabel: peso(i.credit),
      projectedCredit: i.projectedCredit,
      projectedCreditLabel: peso(i.projectedCredit),
      flags: i.flags.map((f) => ({ key: f, label: FLAG_LABEL[f] ?? f })),
    })),
    notAffected: plan.notAffected.map((n) => ({
      bookingId: n.booking.id,
      ref: n.booking.ref,
      userName: n.booking.booker_name ?? n.booking.user_name,
      label: `${n.booking.resource_name} · ${dateLabel(n.booking.date)} · ${rangesLabel(segmentsOf(n.booking))}`,
      reason: n.reason,
      reasonLabel: NOT_AFFECTED_LABEL[n.reason],
    })),
    closures: plan.closures.map((cl) => ({ ...cl, dateLabel: dateLabel(cl.date), timeLabel: `${minutesLabel(cl.start)} – ${minutesLabel(cl.end)}` })),
    totals: {
      bookings: plan.items.length,
      cancel: plan.items.filter((i) => i.action === 'cancel').length,
      keep: plan.items.filter((i) => i.action === 'keep').length,
      defer: plan.items.filter((i) => i.action === 'defer').length,
      credit: sum((i) => i.credit),
      creditLabel: peso(sum((i) => i.credit)),
      pending: sum((i) => i.projectedCredit),
      pendingLabel: peso(sum((i) => i.projectedCredit)),
    },
  };
}

// ── Applying ────────────────────────────────────────────────────────────────

/** Player-facing words for one booking's outcome. */
function itemTexts(i: PlanItem, input: DisruptionInput, origin: string) {
  const b = i.booking;
  const reason = input.reason;
  const credit = peso(i.credit);
  const where = i.whereLabel;
  const link = `/bookings/${b.id}`;
  if (i.action === 'defer') {
    return {
      event: `${reason} · waiting for payment verification`,
      chat: `Le Spinners closed this time · ${reason} · a booking credit follows once your payment is verified`,
      notice: { type: 'disruption_pending', title: 'Your booking time is closed', body: `${where} · ${reason}. Once we verify your payment, a booking credit is added.`, link },
      email: null,
    };
  }
  if (i.flags.includes('hold')) {
    const back = i.flags.includes('credit_returned') ? ' The booking credit it used is back.' : '';
    return {
      event: `${reason} · hold ended`,
      chat: `Hold ended by Le Spinners · ${reason}`,
      notice: { type: 'booking_disrupted', title: 'Your hold ended', body: `${where} · ${reason}. Nothing was charged.${back}`, link },
      email: null,
    };
  }
  const withCredit = i.credit > 0;
  if (i.action === 'cancel') {
    const by = input.category === 'customer_request' ? 'at your request' : 'by Le Spinners';
    return {
      event: `${reason}${withCredit ? ` · ${credit} booking credit` : ''}`,
      chat: `Booking cancelled ${by} · ${reason}${withCredit ? ` · ${credit} booking credit added` : ''}`,
      notice: {
        type: 'booking_disrupted',
        title: `Booking cancelled ${by}`,
        body: `${where} · ${reason}.${withCredit ? ` ${credit} booking credit added — rebook anytime.` : ''}`,
        link,
      },
      email: {
        subject: `Le Spinners — Booking cancelled${withCredit ? ` · ${credit} credit` : ''}`,
        body: [
          `Hi ${b.user_name},`,
          '',
          input.category === 'customer_request' ? `As you asked, Le Spinners cancelled your booking ${b.ref} (${where}).` : `Le Spinners had to cancel your booking ${b.ref} (${where}).`,
          `Reason: ${reason}`,
          '',
          ...(withCredit
            ? [
                `We added a ${credit} booking credit to your account. It isn't a cash refund: it's applied automatically the next time you book.`,
                `Rebook: ${origin}${link}`,
                '',
              ]
            : []),
          `Questions? Reply in the booking chat: ${origin}${link}/chat`,
          '',
          'Le Spinners Recreational Hub',
        ].join('\n'),
      },
    };
  }
  return {
    event: `${i.affectedLabel} · ${reason}${withCredit ? ` · ${credit} booking credit` : ''}`,
    chat: `${i.affectedLabel} couldn't go ahead · ${reason}${withCredit ? ` · ${credit} booking credit added` : ''}`,
    notice: {
      type: 'booking_partly_credited',
      title: "Part of your booking couldn't go ahead",
      body: `${b.resource_name} · ${dateLabel(b.date)} · ${i.affectedLabel} · ${reason}.${withCredit ? ` ${credit} booking credit added.` : ''}`,
      link,
    },
    email: withCredit
      ? {
          subject: `Le Spinners — ${credit} booking credit`,
          body: [
            `Hi ${b.user_name},`,
            '',
            `Part of your booking ${b.ref} (${where}) couldn't go ahead: ${i.affectedLabel}.`,
            `Reason: ${reason}`,
            '',
            `We added a ${credit} booking credit for that time. It isn't a cash refund: it's applied automatically the next time you book.`,
            `Your credits: ${origin}/credits`,
            '',
            'Le Spinners Recreational Hub',
          ].join('\n'),
        }
      : null,
  };
}

type ApplyContext = {
  db: D1Database;
  disruptionId: string;
  actor: SessionUser;
  input: DisruptionInput;
  plan: Plan;
  now: number;
  origin: string;
};

/**
 * The statements that act on the items marked 'pending' for this disruption: booking changes,
 * outcomes, credits, ledger, returned credit, timeline, chat, notices and email. Every insert
 * joins on the outcome this batch wrote, so a skipped booking gets nothing.
 */
function effectStatements(ctx: ApplyContext): D1PreparedStatement[] {
  const { db, disruptionId: d, actor, input, plan, now, origin } = ctx;
  const texts = plan.items.map((i) => ({ i, t: itemTexts(i, input, origin) }));
  const creditRows = plan.items
    .filter((i) => i.credit > 0)
    .map((i) => ({ b: i.booking.id, c: newId('cr_'), r: `${i.booking.resource_name} · ${dateLabel(i.booking.date)} — ${input.reason}` }));
  const events = texts.map(({ i, t }) => ({ b: i.booking.id, t: t.event }));
  const chats = texts.map(({ i, t }) => ({ b: i.booking.id, id: newId('m_'), t: t.chat }));
  const notices = texts.map(({ i, t }) => ({ b: i.booking.id, id: newId('n_'), ty: t.notice.type, ti: t.notice.title, bo: t.notice.body, l: t.notice.link }));
  const emails = texts.filter(({ t }) => t.email).map(({ i, t }) => ({ b: i.booking.id, to: i.booking.user_email, s: t.email!.subject, t: t.email!.body }));
  const itemSel = (col: string) => `(SELECT di.${col} FROM disruption_items di WHERE di.disruption_id = ?1 AND di.booking_id = bookings.id)`;
  const applied = `di.disruption_id = ?1 AND di.resolved_at = ?2 AND di.outcome IN ('cancelled', 'partial')`;
  const touched = `(${applied}) OR (di.disruption_id = ?1 AND di.outcome = 'deferred' AND di.created_at = ?2)`;

  return [
    // Cancel: only where the status and version are still what the plan saw.
    db
      .prepare(
        `UPDATE bookings
            SET status = 'CANCELLED', cancelled_at = ?2, cancelled_by = ?3, cancel_reason = ?4, hold_expires_at = NULL,
                disruption_id = ?1, updated_at = ?2, compensated_amount = compensated_amount + ${itemSel('credit_amount')}
          WHERE id IN (SELECT booking_id FROM disruption_items WHERE disruption_id = ?1 AND outcome = 'pending' AND planned_action = 'cancel')
            AND status = ${itemSel('status_before')} AND updated_at = ${itemSel('version_before')}
            AND (status NOT IN ('TEMPORARY', 'REJECTED') OR hold_expires_at > ?2)
            AND compensated_amount + ${itemSel('credit_amount')} <= amount_due + credit_applied`,
      )
      .bind(d, now, actor.id, input.reason),
    // Keep (started, finished, or staff chose to keep the rest): only the credit is recorded.
    db
      .prepare(
        `UPDATE bookings
            SET disruption_id = ?1, updated_at = ?2, compensated_amount = compensated_amount + ${itemSel('credit_amount')}
          WHERE id IN (SELECT booking_id FROM disruption_items WHERE disruption_id = ?1 AND outcome = 'pending' AND planned_action = 'keep')
            AND status = ${itemSel('status_before')} AND updated_at = ${itemSel('version_before')}
            AND compensated_amount + ${itemSel('credit_amount')} <= amount_due + credit_applied`,
      )
      .bind(d, now),
    db
      .prepare(
        `UPDATE disruption_items
            SET outcome = CASE WHEN EXISTS (SELECT 1 FROM bookings b WHERE b.id = disruption_items.booking_id AND b.disruption_id = ?1 AND b.updated_at = ?2)
                               THEN CASE planned_action WHEN 'cancel' THEN 'cancelled' ELSE 'partial' END ELSE 'skipped' END,
                skip_reason = CASE WHEN EXISTS (SELECT 1 FROM bookings b WHERE b.id = disruption_items.booking_id AND b.disruption_id = ?1 AND b.updated_at = ?2)
                                   THEN NULL ELSE 'changed' END,
                resolved_at = ?2
          WHERE disruption_id = ?1 AND outcome = 'pending'`,
      )
      .bind(d, now),
    db
      .prepare(
        `INSERT INTO booking_credits (id, user_id, origin, source_booking_id, disruption_id, amount, remaining, state, expires_at, reason, created_by, created_at, updated_at)
         SELECT json_extract(j.value, '$.c'), di.user_id, 'disruption', di.booking_id, ?1, di.credit_amount, di.credit_amount, 'active', NULL,
                json_extract(j.value, '$.r'), ?3, ?2, ?2
           FROM json_each(?4) j JOIN disruption_items di ON di.disruption_id = ?1 AND di.booking_id = json_extract(j.value, '$.b')
          WHERE di.resolved_at = ?2 AND di.outcome IN ('cancelled', 'partial') AND di.credit_amount > 0`,
      )
      .bind(d, now, actor.id, JSON.stringify(creditRows)),
    db
      .prepare(
        `INSERT INTO credit_transactions (id, credit_id, user_id, kind, amount, booking_id, actor_id, actor_role, note, created_at)
         SELECT ${SQL_ID('ct_')}, c.id, c.user_id, 'issue', c.amount, c.source_booking_id, ?3, 'staff', ?4, ?2
           FROM booking_credits c
          WHERE c.disruption_id = ?1 AND c.created_at = ?2
            AND NOT EXISTS (SELECT 1 FROM credit_transactions t WHERE t.credit_id = c.id AND t.kind = 'issue')`,
      )
      .bind(d, now, actor.id, input.reason),
    // Holds cancelled here give back any credit they had reserved.
    ...releaseStmts(db, 'b.disruption_id = ? AND b.updated_at = ?', [d, now], now),
    db
      .prepare(
        `INSERT INTO booking_events (booking_id, type, actor_id, actor_role, note, created_at)
         SELECT di.booking_id, CASE di.outcome WHEN 'cancelled' THEN 'disrupted' ELSE 'partially_disrupted' END, ?3, 'staff',
                json_extract(j.value, '$.t'), ?2
           FROM disruption_items di JOIN json_each(?4) j ON json_extract(j.value, '$.b') = di.booking_id
          WHERE ${applied}`,
      )
      .bind(d, now, actor.id, JSON.stringify(events)),
    db
      .prepare(
        `INSERT INTO messages (id, booking_id, sender_id, sender_role, kind, body, created_at)
         SELECT json_extract(j.value, '$.id'), di.booking_id, NULL, 'system', 'system', json_extract(j.value, '$.t'), ?2
           FROM disruption_items di JOIN json_each(?3) j ON json_extract(j.value, '$.b') = di.booking_id
          WHERE ${touched}`,
      )
      .bind(d, now, JSON.stringify(chats)),
    db
      .prepare(
        `INSERT INTO notifications (id, audience, user_id, booking_id, type, title, body, link, created_at)
         SELECT json_extract(j.value, '$.id'), 'user', di.user_id, di.booking_id, json_extract(j.value, '$.ty'),
                json_extract(j.value, '$.ti'), json_extract(j.value, '$.bo'), json_extract(j.value, '$.l'), ?2
           FROM disruption_items di JOIN json_each(?3) j ON json_extract(j.value, '$.b') = di.booking_id
          WHERE ${touched}`,
      )
      .bind(d, now, JSON.stringify(notices)),
    db
      .prepare(
        `UPDATE notifications SET resolved_at = ?2, read_at = COALESCE(read_at, ?2)
          WHERE audience = 'staff' AND resolved_at IS NULL AND type IN ('proof_submitted', 'new_booking', 'hold_expiring')
            AND booking_id IN (SELECT booking_id FROM disruption_items di WHERE di.disruption_id = ?1 AND di.resolved_at = ?2 AND di.outcome = 'cancelled')`,
      )
      .bind(d, now),
    db
      .prepare(
        `INSERT INTO outbox (id, channel, recipient, subject, body, status, booking_id, created_at)
         SELECT ${SQL_ID('o_')}, 'email', json_extract(j.value, '$.to'), json_extract(j.value, '$.s'), json_extract(j.value, '$.t'), 'queued', di.booking_id, ?2
           FROM disruption_items di JOIN json_each(?3) j ON json_extract(j.value, '$.b') = di.booking_id
          WHERE ${applied}`,
      )
      .bind(d, now, JSON.stringify(emails)),
    db
      .prepare(
        `UPDATE disruptions
            SET item_count = (SELECT COUNT(*) FROM disruption_items WHERE disruption_id = ?1),
                credited_total = (SELECT COALESCE(SUM(amount), 0) FROM booking_credits WHERE disruption_id = ?1)
          WHERE id = ?1`,
      )
      .bind(d),
  ];
}

/** The plan's items as rows for disruption_items (INSERT … FROM json_each). */
function itemRows(plan: Plan) {
  return JSON.stringify(
    plan.items.map((i) => ({
      b: i.booking.id,
      u: i.booking.user_id,
      a: i.action,
      s: i.booking.status,
      v: i.booking.updated_at,
      bm: i.bookedMin,
      am: i.affectedMin,
      seg: JSON.stringify(i.affected.map((x) => [x.start, x.end])),
      pv: i.paidValue,
      cr: i.credit,
      f: JSON.stringify(i.flags),
      w: i.whereLabel,
    })),
  );
}

function auditStmt(db: D1Database, actorId: string, action: string, entityId: string, detail: unknown, ip: string, now: number) {
  return db
    .prepare('INSERT INTO audit_log (actor_id, action, entity, entity_id, detail, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(actorId, action, 'disruption', entityId, JSON.stringify(detail).slice(0, 2000), ip, now);
}

/** Outcome counts for one disruption. */
async function outcomeCounts(db: D1Database, id: string) {
  const { results } = await db
    .prepare('SELECT outcome, skip_reason, COUNT(*) AS n, COALESCE(SUM(credit_amount), 0) AS credit FROM disruption_items WHERE disruption_id = ? GROUP BY outcome, skip_reason')
    .bind(id)
    .all<{ outcome: string; skip_reason: string | null; n: number; credit: number }>();
  const count = (o: string, reason?: string) => results.filter((r) => r.outcome === o && (reason === undefined || r.skip_reason === reason)).reduce((n, r) => n + r.n, 0);
  return {
    cancelled: count('cancelled'),
    partial: count('partial'),
    deferred: count('deferred'),
    changed: count('skipped', 'changed'),
    credited: results.filter((r) => r.outcome === 'cancelled' || r.outcome === 'partial').reduce((n, r) => n + r.credit, 0),
  };
}

/** SQL: items that still need staff (payment waiting, or changed while applying). */
const OPEN_ITEM = (alias: string) => `(${alias}.outcome = 'deferred' OR (${alias}.outcome = 'skipped' AND ${alias}.skip_reason = 'changed'))`;

/** Marks the staff notice for a disruption handled once nothing is left to do. */
function resolveNoticeStmt(db: D1Database, disruptionId: string, now: number) {
  return db
    .prepare(
      `UPDATE notifications SET resolved_at = ?2, read_at = COALESCE(read_at, ?2)
        WHERE audience = 'staff' AND type = 'disruption' AND resolved_at IS NULL AND link = ?3
          AND NOT EXISTS (SELECT 1 FROM disruption_items di WHERE di.disruption_id = ?1 AND ${OPEN_ITEM('di')})`,
    )
    .bind(disruptionId, now, `/admin/disruptions/${disruptionId}`);
}

/** The shared staff notice after a disruption: a summary, unresolved while bookings still need follow-up. */
async function summaryNotice(db: D1Database, id: string, plan: Plan, actor: SessionUser, input: DisruptionInput, now: number) {
  const n = await outcomeCounts(db, id);
  const parts = [
    n.cancelled ? `${n.cancelled} cancelled` : '',
    n.partial ? `${n.partial} partly credited` : '',
    n.credited ? `${peso(n.credited)} credited` : '',
    n.deferred ? `${n.deferred} waiting for payment verification` : '',
    n.changed ? `${n.changed} changed — review again` : '',
  ].filter(Boolean);
  const open = n.deferred + n.changed > 0;
  await db
    .prepare(
      `INSERT INTO notifications (id, audience, user_id, booking_id, type, title, body, link, resolved_at, created_at)
       VALUES (?, 'staff', NULL, NULL, 'disruption', ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId('n_'),
      `${CATEGORY_LABEL[input.category]} · ${plan.scopeLabel}`,
      `${input.reason} · ${parts.join(' · ') || 'no bookings affected'} · by ${actor.name}`,
      `/admin/disruptions/${id}`,
      open ? null : now,
      now,
    )
    .run();
}

/**
 * Applies a previewed disruption. Replays with the same Idempotency-Key return the first result;
 * a preview that went stale answers 409 DISRUPTION_CHANGED with the fresh one.
 */
export async function applyDisruption(
  c: AppContext,
  actor: SessionUser,
  body: z.infer<typeof applySchema>,
  idempotencyKey: string,
  ip: string,
): Promise<{ id: string; replay: boolean }> {
  const db = c.env.DB;
  const { previewToken, ...raw } = body;
  const requestHash = await sha256Hex(JSON.stringify({ body, actor: actor.id }));
  const seen = await db.prepare('SELECT id, request_hash FROM disruptions WHERE idempotency_key = ?').bind(idempotencyKey).first<{ id: string; request_hash: string }>();
  if (seen) {
    if (seen.request_hash !== requestHash) throw conflict('IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different change. Reload and try again.');
    return { id: seen.id, replay: true };
  }

  const now = Date.now();
  const plan = await buildPlan(c, actor, raw, now);
  if (plan.previewToken !== previewToken) {
    throw conflict('DISRUPTION_CHANGED', 'Bookings changed since the preview. Review the updated list, then confirm again.', { preview: previewDTO(plan) });
  }
  if (!plan.items.length && !plan.closures.length) {
    throw unprocessable('NOTHING_TO_DO', 'No bookings are affected, and those times have already passed, so there is nothing to change.');
  }

  const id = newId('d_');
  const input = plan.input;
  const s = input.scope;
  const win = s.kind === 'window' ? s : null;
  const ctx: ApplyContext = { db, disruptionId: id, actor, input, plan, now, origin: c.env.APP_ORIGIN };
  const closures = plan.closures.map((cl) => ({ id: newId('cl_'), ...cl }));
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO disruptions (id, kind, category, reason, staff_note, date, start_min, end_min, activity, resource_id, effective_from, compensation,
                                  created_by, idempotency_key, request_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        id, s.kind, input.category, input.reason, input.staffNote,
        win?.date ?? null, win?.start ?? null, win?.end ?? null, win?.activity ?? null, win?.resourceId ?? null,
        s.kind === 'bookings' ? s.effectiveFrom : null, input.compensation, actor.id, idempotencyKey, requestHash, now,
      ),
  ];
  if (closures.length) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO closures (id, date, resource_id, start_min, end_min, reason, created_by, created_at, disruption_id)
           SELECT json_extract(j.value, '$.id'), json_extract(j.value, '$.date'), json_extract(j.value, '$.resourceId'),
                  json_extract(j.value, '$.start'), json_extract(j.value, '$.end'), ?2, ?3, ?4, ?5
             FROM json_each(?1) j`,
        )
        .bind(JSON.stringify(closures), input.reason, actor.id, now, id),
    );
  }
  stmts.push(
    db
      .prepare(
        `INSERT INTO disruption_items (disruption_id, booking_id, user_id, planned_action, outcome, status_before, version_before, booked_min,
                                       affected_min, affected_segments, paid_value, credit_amount, flags, where_label, created_at)
         SELECT ?2, json_extract(j.value, '$.b'), json_extract(j.value, '$.u'), json_extract(j.value, '$.a'),
                CASE json_extract(j.value, '$.a') WHEN 'defer' THEN 'deferred' ELSE 'pending' END,
                json_extract(j.value, '$.s'), json_extract(j.value, '$.v'), json_extract(j.value, '$.bm'), json_extract(j.value, '$.am'),
                json_extract(j.value, '$.seg'), json_extract(j.value, '$.pv'), json_extract(j.value, '$.cr'), json_extract(j.value, '$.f'),
                json_extract(j.value, '$.w'), ?3
           FROM json_each(?1) j`,
      )
      .bind(itemRows(plan), id, now),
    ...effectStatements(ctx),
    auditStmt(db, actor.id, 'disruption_applied', id, {
      kind: s.kind, category: input.category, scope: plan.scopeLabel, bookings: plan.items.length,
      credit: plan.items.reduce((n, i) => n + i.credit, 0), closures: closures.length,
    }, ip, now),
  );

  try {
    await scheduleBatch(db, plan.scheduleVersion, stmts);
  } catch (err) {
    // A same-key winner may have changed the revision before this batch started.
    const won = await db.prepare('SELECT id, request_hash FROM disruptions WHERE idempotency_key = ?').bind(idempotencyKey).first<{ id: string; request_hash: string }>();
    if (won) {
      if (won.request_hash !== requestHash) throw conflict('IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different change. Reload and try again.');
      return { id: won.id, replay: true };
    }
    if (err instanceof Error && 'code' in err && err.code === 'SCHEDULE_CHANGED') {
      const fresh = await buildPlan(c, actor, raw, Date.now());
      throw conflict('DISRUPTION_CHANGED', 'Bookings changed since the preview. Review the updated list, then confirm again.', { preview: previewDTO(fresh) });
    }
    throw err;
  }
  await summaryNotice(db, id, plan, actor, input, now).catch((err) => console.error('disruption summary notice failed', err));
  return { id, replay: false };
}

type DisruptionRow = {
  id: string;
  kind: 'bookings' | 'window';
  category: Category;
  reason: string;
  staff_note: string | null;
  date: string | null;
  start_min: number | null;
  end_min: number | null;
  activity: Activity | null;
  resource_id: string | null;
  effective_from: number | null;
  compensation: 'credit' | 'none';
  created_by: string;
  item_count: number;
  credited_total: number;
  created_at: number;
};

type ItemRow = {
  disruption_id: string;
  booking_id: string;
  planned_action: Action;
  outcome: 'pending' | 'cancelled' | 'partial' | 'deferred' | 'skipped';
  skip_reason: string | null;
  status_before: BookingStatus;
};

/** The original request, rebuilt to re-plan one booking of a stored disruption. */
function inputFromRow(d: DisruptionRow, item: ItemRow): DisruptionInput {
  const overrides = item.planned_action === 'keep' ? [{ bookingId: item.booking_id, action: 'keep' as const }] : [];
  const base = { category: d.category, reason: d.reason, staffNote: d.staff_note, compensation: d.compensation, overrides };
  if (d.kind === 'window') {
    return { ...base, scope: { kind: 'window', date: d.date!, start: d.start_min!, end: d.end_min!, activity: d.activity, resourceId: d.resource_id } };
  }
  return { ...base, scope: { kind: 'bookings', bookingIds: [item.booking_id], effectiveFrom: d.effective_from, closeSlots: false } };
}

/**
 * Finishes one booking of a disruption that was deferred (payment waiting) or skipped because it
 * changed mid-way, using the booking's current state. Runs the same statements as applyDisruption
 * for that one booking.
 */
export async function resolveItem(c: AppContext, actor: SessionUser, disruptionId: string, bookingId: string, ip: string, now = Date.now()) {
  const db = c.env.DB;
  const [d, item] = await Promise.all([
    db.prepare('SELECT * FROM disruptions WHERE id = ?').bind(disruptionId).first<DisruptionRow>(),
    db.prepare('SELECT * FROM disruption_items WHERE disruption_id = ? AND booking_id = ?').bind(disruptionId, bookingId).first<ItemRow>(),
  ]);
  if (!d || !item) throw notFound('This booking is not part of that disruption.');
  const open = item.outcome === 'deferred' || (item.outcome === 'skipped' && item.skip_reason === 'changed');
  if (!open) throw conflict('ITEM_RESOLVED', 'This booking was already handled.');

  const input = inputFromRow(d, item);
  const plan = await buildPlan(c, actor, input, now, { onlyBookingIds: [bookingId], skipPermissions: true });
  const p = plan.items.find((i) => i.booking.id === bookingId);
  if (!p) {
    const why = plan.notAffected.find((n) => n.booking.id === bookingId)?.reason ?? 'ended';
    const reason = item.status_before === 'PAYMENT_SUBMITTED' && why === 'ended' ? 'payment_not_verified' : why;
    await scheduleBatch(db, plan.scheduleVersion, [
      db
        .prepare(`UPDATE disruption_items SET outcome = 'skipped', skip_reason = ?3, resolved_at = ?4 WHERE disruption_id = ?1 AND booking_id = ?2 AND ${OPEN_ITEM('disruption_items')}`)
        .bind(disruptionId, bookingId, reason, now),
      resolveNoticeStmt(db, disruptionId, now),
    ]);
    return { outcome: 'skipped' as const, reason };
  }
  if (p.action === 'defer') {
    throw conflict('VERIFY_FIRST', 'The payment for this booking is still waiting for verification. Approve or reject it first.');
  }

  const one: Plan = { ...plan, items: [p] };
  const ctx: ApplyContext = { db, disruptionId, actor, input: plan.input, plan: one, now, origin: c.env.APP_ORIGIN };
  const [row] = await scheduleBatch(db, plan.scheduleVersion, [
    db
      .prepare(
        `UPDATE disruption_items
            SET planned_action = ?3, outcome = 'pending', skip_reason = NULL, status_before = ?4, version_before = ?5, booked_min = ?6,
                affected_min = ?7, affected_segments = ?8, paid_value = ?9, credit_amount = ?10, flags = ?11, where_label = ?12, resolved_at = NULL
          WHERE disruption_id = ?1 AND booking_id = ?2 AND ${OPEN_ITEM('disruption_items')}`,
      )
      .bind(
        disruptionId, bookingId, p.action, p.booking.status, p.booking.updated_at, p.bookedMin, p.affectedMin,
        JSON.stringify(p.affected.map((x) => [x.start, x.end])), p.paidValue, p.credit, JSON.stringify(p.flags), p.whereLabel,
      ),
    ...effectStatements(ctx),
    resolveNoticeStmt(db, disruptionId, now),
    auditStmt(db, actor.id, 'disruption_item_applied', disruptionId, { bookingId, action: p.action, credit: p.credit }, ip, now),
  ]);
  if (!row?.meta.changes) throw conflict('ITEM_RESOLVED', 'This booking was already handled.');
  const after = await db
    .prepare('SELECT outcome, credit_amount FROM disruption_items WHERE disruption_id = ? AND booking_id = ?')
    .bind(disruptionId, bookingId)
    .first<{ outcome: string; credit_amount: number }>();
  return { outcome: (after?.outcome ?? 'skipped') as 'cancelled' | 'partial' | 'skipped', credit: after?.credit_amount ?? 0 };
}

/** After staff approve or reject a payment: finish any disruption that was waiting on it. Never throws. */
export async function resolveDeferredForBooking(c: AppContext, actor: SessionUser, bookingId: string, ip: string) {
  const { results } = await c.env.DB.prepare(`SELECT disruption_id FROM disruption_items WHERE booking_id = ? AND outcome = 'deferred'`)
    .bind(bookingId)
    .all<{ disruption_id: string }>();
  const out: { disruptionId: string; outcome: string; credit?: number }[] = [];
  for (const r of results) {
    try {
      out.push({ disruptionId: r.disruption_id, ...(await resolveItem(c, actor, r.disruption_id, bookingId, ip)) });
    } catch (err) {
      // Still waiting (e.g. rejected with a resubmit window) or handled meanwhile: stays on the disruption page.
      if (!(err instanceof ApiError)) console.error('resolve deferred disruption failed', err);
    }
  }
  return out;
}

/** Cron: deferred bookings whose payment never got verified (expired, released) need no credit. */
export async function closeUnpaidDeferred(env: Bindings, now = Date.now()): Promise<number> {
  const db = env.DB;
  const { results } = await db.prepare(`SELECT disruption_id, booking_id FROM disruption_items
    WHERE outcome = 'deferred' AND booking_id IN (SELECT id FROM bookings WHERE status IN ('EXPIRED', 'CANCELLED'))
    ORDER BY disruption_id, booking_id LIMIT ?`).bind(MAINTENANCE_BATCH_SIZE).all<{ disruption_id: string; booking_id: string }>();
  if (!results.length) return 0;
  const [updated] = await db.batch([
    db.prepare(`UPDATE disruption_items SET outcome = 'skipped', skip_reason = 'payment_not_verified', resolved_at = ?1
      WHERE outcome = 'deferred' AND booking_id IN (SELECT id FROM bookings WHERE status IN ('EXPIRED', 'CANCELLED'))
        AND EXISTS (SELECT 1 FROM json_each(?2) j WHERE json_extract(j.value, '$[0]') = disruption_id AND json_extract(j.value, '$[1]') = booking_id)`)
      .bind(now, JSON.stringify(results.map(r => [r.disruption_id, r.booking_id]))),
    ...[...new Set(results.map(r => r.disruption_id))].map(id => resolveNoticeStmt(db, id, now)),
  ]);
  return updated?.meta.changes ?? 0;
}

// ── Reading ────────────────────────────────────────────────────────────────

type DisruptionListRow = DisruptionRow & {
  created_by_name: string;
  resource_name: string | null;
  open_count: number;
  first_ref: string | null;
  first_user: string | null;
};

function scopeText(d: Pick<DisruptionListRow, 'kind' | 'resource_name' | 'activity' | 'item_count' | 'first_ref' | 'first_user'>) {
  if (d.kind === 'bookings') {
    if (d.item_count === 1 && d.first_ref) return `${d.first_ref}${d.first_user ? ` · ${d.first_user}` : ''}`;
    return `${d.item_count} booking${d.item_count === 1 ? '' : 's'}`;
  }
  if (d.resource_name) return d.resource_name;
  if (d.activity) return d.activity === 'pickleball' ? 'All pickleball courts' : 'All table-tennis tables';
  return 'Whole facility';
}

function disruptionDTO(d: DisruptionListRow) {
  return {
    id: d.id,
    kind: d.kind,
    category: d.category,
    categoryLabel: CATEGORY_LABEL[d.category],
    reason: d.reason,
    staffNote: d.staff_note,
    scopeLabel: scopeText(d),
    date: d.date,
    dateLabel: d.date ? dateLabel(d.date) : null,
    timeLabel: d.start_min != null && d.end_min != null ? `${minutesLabel(d.start_min)} – ${minutesLabel(d.end_min)}` : null,
    effectiveFrom: d.effective_from,
    compensation: d.compensation,
    itemCount: d.item_count,
    creditedTotal: d.credited_total,
    creditedLabel: peso(d.credited_total),
    openCount: d.open_count,
    createdBy: d.created_by_name,
    createdAt: d.created_at,
  };
}

const DISRUPTION_SELECT = `
  SELECT d.*, u.name AS created_by_name, r.name AS resource_name,
         (SELECT COUNT(*) FROM disruption_items di WHERE di.disruption_id = d.id AND ${OPEN_ITEM('di')}) AS open_count,
         (SELECT b.ref FROM disruption_items di JOIN bookings b ON b.id = di.booking_id WHERE di.disruption_id = d.id ORDER BY di.booking_id LIMIT 1) AS first_ref,
         (SELECT pu.name FROM disruption_items di JOIN users pu ON pu.id = di.user_id WHERE di.disruption_id = d.id ORDER BY di.booking_id LIMIT 1) AS first_user
    FROM disruptions d JOIN users u ON u.id = d.created_by LEFT JOIN resources r ON r.id = d.resource_id`;

export async function listDisruptions(db: D1Database, filter: 'open' | 'all') {
  const where = filter === 'open' ? ` WHERE EXISTS (SELECT 1 FROM disruption_items di WHERE di.disruption_id = d.id AND ${OPEN_ITEM('di')})` : '';
  const { results } = await db.prepare(`${DISRUPTION_SELECT}${where} ORDER BY d.created_at DESC LIMIT 100`).all<DisruptionListRow>();
  return results.map(disruptionDTO);
}

/** Bookings that still need staff after a disruption (for the dashboard). */
export async function openDisruptionItems(db: D1Database): Promise<number> {
  const row = await db.prepare(`SELECT COUNT(*) AS n FROM disruption_items di WHERE ${OPEN_ITEM('di')}`).first<{ n: number }>();
  return row?.n ?? 0;
}

type DetailItemRow = {
  booking_id: string;
  planned_action: Action;
  outcome: string;
  skip_reason: string | null;
  status_before: string;
  booked_min: number;
  affected_min: number;
  affected_segments: string;
  paid_value: number;
  credit_amount: number;
  flags: string | null;
  where_label: string;
  resolved_at: number | null;
  ref: string;
  booking_status: BookingStatus;
  hold_expires_at: number | null;
  user_name: string;
  credit_id: string | null;
  credit_remaining: number | null;
};

const OUTCOME_LABEL: Record<string, string> = {
  pending: 'Pending',
  cancelled: 'Cancelled',
  partial: 'Kept · part credited',
  deferred: 'Waiting for payment verification',
  skipped: 'Skipped',
};

const SKIP_LABEL: Record<string, string> = {
  changed: 'Changed while applying — review again',
  payment_not_verified: 'Payment never verified — nothing to credit',
  ended: 'Already ended',
  outside: 'No longer inside the time',
  already_compensated: 'Already credited',
};

export async function disruptionDetail(db: D1Database, id: string, now: number) {
  const d = await db.prepare(`${DISRUPTION_SELECT} WHERE d.id = ?`).bind(id).first<DisruptionListRow>();
  if (!d) throw notFound('Disruption not found.');
  const [items, closures] = await db.batch([
    db
      .prepare(
        `SELECT di.*, b.ref, b.status AS booking_status, b.hold_expires_at, COALESCE(b.booker_name, u.name) AS user_name, c.id AS credit_id, c.remaining AS credit_remaining
           FROM disruption_items di
           JOIN bookings b ON b.id = di.booking_id
           JOIN users u ON u.id = di.user_id
           LEFT JOIN booking_credits c ON c.source_booking_id = di.booking_id AND c.disruption_id = di.disruption_id
          WHERE di.disruption_id = ? ORDER BY di.where_label, di.booking_id`,
      )
      .bind(id),
    db.prepare('SELECT id, date, resource_id, start_min, end_min FROM closures WHERE disruption_id = ? ORDER BY date, start_min').bind(id),
  ]);
  return {
    now,
    disruption: disruptionDTO(d),
    items: ((items?.results ?? []) as DetailItemRow[]).map((i) => {
      const flags = (() => {
        try {
          return JSON.parse(i.flags ?? '[]') as string[];
        } catch {
          return [];
        }
      })();
      return {
        bookingId: i.booking_id,
        ref: i.ref,
        userName: i.user_name,
        whereLabel: i.where_label,
        affectedLabel: rangesLabel(parseSegments(i.affected_segments)),
        bookingStatus: effectiveStatus({ status: i.booking_status, hold_expires_at: i.hold_expires_at }, now),
        statusBefore: i.status_before,
        action: i.planned_action,
        outcome: i.outcome,
        outcomeLabel: OUTCOME_LABEL[i.outcome] ?? i.outcome,
        skipReason: i.skip_reason,
        skipLabel: i.skip_reason ? SKIP_LABEL[i.skip_reason] ?? i.skip_reason : null,
        open: i.outcome === 'deferred' || (i.outcome === 'skipped' && i.skip_reason === 'changed'),
        bookedMin: i.booked_min,
        affectedMin: i.affected_min,
        paidValue: i.paid_value,
        paidLabel: peso(i.paid_value),
        credit: i.credit_amount,
        creditLabel: peso(i.credit_amount),
        creditId: i.credit_id,
        creditRemaining: i.credit_remaining,
        flags: flags.map((f) => ({ key: f, label: FLAG_LABEL[f] ?? f })),
      };
    }),
    closures: ((closures?.results ?? []) as { id: string; date: string; resource_id: string | null; start_min: number; end_min: number }[]).map((cl) => ({
      id: cl.id,
      date: cl.date,
      dateLabel: dateLabel(cl.date),
      resourceId: cl.resource_id,
      timeLabel: `${minutesLabel(cl.start_min)} – ${minutesLabel(cl.end_min)}`,
    })),
  };
}

type BookingDisruptionRow = {
  disruption_id: string;
  outcome: string;
  affected_segments: string;
  credit_amount: number;
  created_at: number;
  resolved_at: number | null;
  category: Category;
  reason: string;
  staff_note: string | null;
  by_name: string;
  credit_id: string | null;
  credit_remaining: number | null;
};

/**
 * What disruptions did to one booking, and how credit paid for it. Players never see staff names
 * or internal notes.
 */
export async function bookingCreditInfo(db: D1Database, bookingId: string, forStaff: boolean) {
  const [disruptions, uses, issued] = await db.batch([
    db
      .prepare(
        `SELECT di.disruption_id, di.outcome, di.affected_segments, di.credit_amount, di.created_at, di.resolved_at,
                d.category, d.reason, d.staff_note, u.name AS by_name, c.id AS credit_id, c.remaining AS credit_remaining
           FROM disruption_items di
           JOIN disruptions d ON d.id = di.disruption_id
           JOIN users u ON u.id = d.created_by
           LEFT JOIN booking_credits c ON c.source_booking_id = di.booking_id AND c.disruption_id = di.disruption_id
          WHERE di.booking_id = ? AND di.outcome IN ('cancelled', 'partial', 'deferred')
          ORDER BY di.created_at`,
      )
      .bind(bookingId),
    db
      .prepare(
        `SELECT t.kind, t.amount, t.credit_id, sb.ref AS source_ref, sb.id AS source_id
           FROM credit_transactions t
           JOIN booking_credits c ON c.id = t.credit_id
           LEFT JOIN bookings sb ON sb.id = c.source_booking_id
          WHERE t.booking_id = ? AND t.kind IN ('redeem', 'release')
          ORDER BY t.created_at, t.rowid`,
      )
      .bind(bookingId),
    db.prepare(`SELECT COALESCE(SUM(amount), 0) AS total FROM booking_credits WHERE source_booking_id = ?`).bind(bookingId),
  ]);
  const used = (uses?.results ?? []) as { kind: string; amount: number; credit_id: string; source_ref: string | null; source_id: string | null }[];
  const returned = used.some((u) => u.kind === 'release');
  const sources = used
    .filter((u) => u.kind === 'redeem')
    .map((u) => ({ creditId: u.credit_id, amount: -u.amount, amountLabel: peso(-u.amount), sourceRef: u.source_ref, sourceBookingId: u.source_id }));
  return {
    disruptions: ((disruptions?.results ?? []) as BookingDisruptionRow[]).map((r) => ({
      disruptionId: r.disruption_id,
      outcome: r.outcome,
      category: r.category,
      categoryLabel: CATEGORY_LABEL[r.category],
      reason: r.reason,
      affectedLabel: rangesLabel(parseSegments(r.affected_segments)),
      credit: r.credit_amount,
      creditLabel: peso(r.credit_amount),
      creditId: r.credit_id,
      creditRemaining: r.credit_remaining,
      creditRemainingLabel: r.credit_remaining != null ? peso(r.credit_remaining) : null,
      at: r.resolved_at ?? r.created_at,
      ...(forStaff ? { staffNote: r.staff_note, by: r.by_name } : {}),
    })),
    creditUses: { sources, returned },
    creditIssued: (((issued?.results ?? [])[0] as { total: number } | undefined)?.total ?? 0),
  };
}
