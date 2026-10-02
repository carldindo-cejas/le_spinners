import { Hono } from 'hono';
import * as z from 'zod';
import type { AppContext, AppEnv, BookingStatus, ResourceRow } from '../types';
import { dayAvailability } from '../lib/availability';
import { audit, clientIp, requireStaff } from '../lib/auth';
import { ADMIN_RETRO_DAYS, bookingCreditInfo, openDisruptionItems, resolveDeferredForBooking } from '../lib/disruptions';
import {
  BOOKING_SELECT, bookingDTO, createConsoleBooking, effectiveStatus, getBooking, PICK_A_TIME, hasSlotPick, listEvents, requestedStarts, slotLabel, sweepExpired,
  isOpenPlay, underMaintenance, zSlotPick, type BookingJoin,
} from '../lib/bookings';
import { MESSAGE_MAX_CHARS, listMessages, markRead, postMessage, staffConversations, staffUnreadChats } from '../lib/chat';
import { notFound, unprocessable } from '../lib/errors';
import { lazyMaintenance } from '../lib/maintenance';
import { approvePayment, listProofs, proofLink, rejectPayment, staffCancel } from '../lib/payments';
import { loadSettings } from '../lib/settings';
import { addDays, dateLabel, isValidDate, localNow, localToMs, offsetMinutes, peso } from '../lib/time';
import { jsonBody, parse, query, zActivity, zDate, zId } from '../lib/validate';
import { staffCreditRoutes } from './credits';
import { disruptionRoutes } from './disruptions';
import { facilityAdminRoutes } from './facilities';
import { notificationDTO, readSchema } from './notifications';

/**
 * Day-to-day operations: dashboard, payment verification, bookings, chat, staff
 * notifications, the schedule grid, and courts/hours/closures.
 *
 * One router, mounted twice (src/worker/index.ts):
 *   /api/staff/*  staff and admins  (the staff console)
 *   /api/admin/*  admins only       (the admin console)
 * The namespace guard runs first; requireStaff here is the floor for both.
 */
export const operationsRoutes = new Hono<AppEnv>();

operationsRoutes.use('*', async (c, next) => {
  requireStaff(c);
  await next();
});

const STATUSES = ['TEMPORARY', 'PAYMENT_SUBMITTED', 'CONFIRMED', 'EXPIRED', 'REJECTED', 'CANCELLED', 'COMPLETED'] as const;

async function staffContext(c: AppContext) {
  const settings = await loadSettings(c.env.DB);
  const offset = offsetMinutes(c.env.TZ_OFFSET_MINUTES);
  return { settings, offset };
}

type ProofSummaryRow = { id: string; booking_id: string; amount_claimed: number | null; gcash_ref: string | null; status: string; created_at: number };

/** Latest proof per booking, for queue rows. */
async function latestProofs(db: D1Database, bookingIds: string[]): Promise<Map<string, ProofSummaryRow>> {
  if (!bookingIds.length) return new Map();
  const { results } = await db
    .prepare(
      `SELECT p.id, p.booking_id, p.amount_claimed, p.gcash_ref, p.status, p.created_at
         FROM payment_proofs p
        WHERE p.booking_id IN (SELECT value FROM json_each(?1))
          AND p.id = (SELECT q.id FROM payment_proofs q WHERE q.booking_id = p.booking_id ORDER BY q.created_at DESC LIMIT 1)`,
    )
    .bind(JSON.stringify(bookingIds))
    .all<ProofSummaryRow>();
  return new Map(results.map((p) => [p.booking_id, p]));
}

function amountCheck(b: BookingJoin, claimed: number | null): 'match' | 'differs' | 'unknown' {
  if (claimed == null) return 'unknown';
  return claimed === b.amount_due ? 'match' : 'differs';
}

/** Signed thumbnail links for queue rows (valid 5–10 minutes). */
async function proofLinks(c: AppContext, proofs: Map<string, ProofSummaryRow>, now: number) {
  const entries = await Promise.all([...proofs.values()].map(async (p) => [p.booking_id, await proofLink(c.env, p.id, now)] as const));
  return new Map(entries);
}

function proofSummary(b: BookingJoin, p: ProofSummaryRow | undefined, link?: { url: string; expiresAt: number }) {
  if (!p) return null;
  return {
    id: p.id,
    url: link?.url ?? null,
    amountClaimed: p.amount_claimed,
    amountClaimedLabel: p.amount_claimed != null ? peso(p.amount_claimed) : null,
    amountCheck: amountCheck(b, p.amount_claimed),
    gcashRef: p.gcash_ref,
    status: p.status,
    submittedAt: p.created_at,
  };
}

// ── Dashboard ──────────────────────────────────────────────────────────────

async function summary(c: AppContext) {
  const db = c.env.DB;
  const now = Date.now();
  await sweepExpired(c.env, now);
  const { settings, offset } = await staffContext(c);
  const local = localNow(offset, now);
  const [pending, holds, today, notif, upcoming, facility] = await db.batch([
    db.prepare(`${BOOKING_SELECT} WHERE b.status = 'PAYMENT_SUBMITTED' ORDER BY b.submitted_at ASC LIMIT 50`),
    db.prepare(`${BOOKING_SELECT} WHERE b.status IN ('TEMPORARY', 'REJECTED') AND b.hold_expires_at > ? ORDER BY b.hold_expires_at ASC LIMIT 50`).bind(now),
    db
      .prepare(`${BOOKING_SELECT} WHERE b.date = ? AND b.status IN ('TEMPORARY', 'PAYMENT_SUBMITTED', 'CONFIRMED', 'REJECTED', 'COMPLETED') ORDER BY b.start_min, r.activity, r.sort_order`)
      .bind(local.date),
    db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE audience = 'staff' AND resolved_at IS NULL`),
    db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE status = 'CONFIRMED' AND (date > ?1 OR (date = ?1 AND end_min > ?2))`).bind(local.date, local.minutes),
    db.prepare(`SELECT id, name, activity, status, open_play, maintenance_note, maintenance_until FROM resources ORDER BY activity, sort_order, name`),
  ]);
  const resources = (facility?.results ?? []) as Pick<ResourceRow, 'id' | 'name' | 'activity' | 'status' | 'open_play' | 'maintenance_note' | 'maintenance_until'>[];
  const pendingRows = (pending?.results ?? []) as BookingJoin[];
  const holdRows = (holds?.results ?? []) as BookingJoin[];
  const todayRows = (today?.results ?? []) as BookingJoin[];
  const proofs = await latestProofs(db, pendingRows.map((b) => b.id));
  const links = await proofLinks(c, proofs, now);
  const dto = (b: BookingJoin) => bookingDTO(b, now, settings, offset, true);
  const confirmedToday = todayRows.filter((b) => b.status === 'CONFIRMED' || b.status === 'COMPLETED');
  return c.json({
    now,
    today: local.date,
    todayLabel: dateLabel(local.date),
    counts: {
      pendingVerification: pendingRows.length,
      activeHolds: holdRows.length,
      confirmedToday: confirmedToday.length,
      unresolved: ((notif?.results ?? [])[0] as { n: number } | undefined)?.n ?? 0,
      unreadChats: await staffUnreadChats(db),
      upcomingConfirmed: ((upcoming?.results ?? [])[0] as { n: number } | undefined)?.n ?? 0,
      /** Bookings a disruption still needs staff for (payment waiting, or changed while applying). */
      disruptionsOpen: await openDisruptionItems(db),
    },
    // Disabled courts are retired, not out of service: they count in neither number.
    facility: {
      inService: resources.filter((r) => r.status !== 'disabled' && !underMaintenance(r, local.date)).length,
      total: resources.filter((r) => r.status !== 'disabled').length,
      maintenance: resources
        .filter((r) => underMaintenance(r, local.date))
        .map((r) => ({ id: r.id, name: r.name, activity: r.activity, note: r.maintenance_note, untilLabel: r.maintenance_until ? dateLabel(r.maintenance_until) : null })),
      // In service, but free for all: not bookable.
      openPlay: resources.filter((r) => isOpenPlay(r)).map((r) => ({ id: r.id, name: r.name, activity: r.activity })),
    },
    verifiedRevenueToday: confirmedToday.reduce((sum, b) => sum + b.amount_due, 0),
    verification: pendingRows.map((b) => ({ ...dto(b), proof: proofSummary(b, proofs.get(b.id), links.get(b.id)) })),
    holds: holdRows.map(dto),
    todaySchedule: todayRows.map(dto),
  });
}

operationsRoutes.get('/summary', summary);
operationsRoutes.get('/dashboard', summary);

/**
 * What staff need while verifying: booking rules and the GCash account players pay
 * (both already shown to players), plus how many alert recipients are set up.
 * Recipient addresses and the rest of Settings stay admin-only.
 */
operationsRoutes.get('/rules', async (c) => {
  const s = await loadSettings(c.env.DB);
  return c.json({
    settings: {
      holdMinutes: s.holdMinutes,
      warnMinutes: s.warnMinutes,
      resubmitMinutes: s.resubmitMinutes,
      cancelCutoffHours: s.cancelCutoffHours,
      bookingWindowDays: s.bookingWindowDays,
      slotMinutes: s.slotMinutes,
      gcashName: s.gcashName,
      gcashNumber: s.gcashNumber,
    },
    alerts: { emailRecipients: s.staffAlertEmails.length, smsRecipients: s.staffAlertSms.length },
    delivery: { email: c.env.RESEND_API_KEY && c.env.EMAIL_FROM ? 'resend' : 'queued', sms: 'queued' },
  });
});

operationsRoutes.get('/badges', async (c) => {
  const db = c.env.DB;
  const now = Date.now();
  c.executionCtx.waitUntil(lazyMaintenance(c.env, now));
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM notifications WHERE audience = 'staff' AND resolved_at IS NULL) AS unresolved,
         (SELECT COUNT(*) FROM notifications WHERE audience = 'staff' AND read_at IS NULL) AS unread,
         (SELECT COUNT(*) FROM bookings WHERE status = 'PAYMENT_SUBMITTED') AS pending,
         (SELECT COUNT(*) FROM bookings WHERE status IN ('TEMPORARY', 'REJECTED') AND hold_expires_at > ?1) AS holds,
         (SELECT COUNT(*) FROM disruption_items
           WHERE outcome = 'deferred' OR (outcome = 'skipped' AND skip_reason = 'changed')) AS disruptions`,
    )
    .bind(now)
    .first<{ unresolved: number; unread: number; pending: number; holds: number; disruptions: number }>();
  return c.json({
    now,
    unresolved: row?.unresolved ?? 0,
    unreadNotifications: row?.unread ?? 0,
    pendingVerification: row?.pending ?? 0,
    activeHolds: row?.holds ?? 0,
    unreadChats: await staffUnreadChats(db),
    disruptionsOpen: row?.disruptions ?? 0,
  });
});

// ── Verification queue ────────────────────────────────────────────────────

operationsRoutes.get('/verifications', async (c) => {
  const db = c.env.DB;
  const now = Date.now();
  const q = query(c, z.object({ tab: z.enum(['pending', 'approved', 'rejected']).optional() }));
  const tab = q.tab ?? 'pending';
  const { settings, offset } = await staffContext(c);
  const local = localNow(offset, now);
  const dayStart = localToMs(local.date, 0, offset);
  const sql = {
    pending: `${BOOKING_SELECT} WHERE b.status = 'PAYMENT_SUBMITTED' ORDER BY b.submitted_at ASC LIMIT 100`,
    approved: `${BOOKING_SELECT} WHERE b.confirmed_at >= ?1 ORDER BY b.confirmed_at DESC LIMIT 100`,
    rejected: `${BOOKING_SELECT} WHERE b.rejected_at >= ?1 ORDER BY b.rejected_at DESC LIMIT 100`,
  }[tab];
  const [list, counts] = await db.batch([
    tab === 'pending' ? db.prepare(sql) : db.prepare(sql).bind(dayStart),
    db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM bookings WHERE status = 'PAYMENT_SUBMITTED') AS pending,
                (SELECT COUNT(*) FROM bookings WHERE confirmed_at >= ?1) AS approved,
                (SELECT COUNT(*) FROM bookings WHERE rejected_at >= ?1) AS rejected`,
      )
      .bind(dayStart),
  ]);
  const rows = (list?.results ?? []) as BookingJoin[];
  const proofs = await latestProofs(db, rows.map((b) => b.id));
  const links = await proofLinks(c, proofs, now);
  const unread = await unreadByBooking(db, rows.map((b) => b.id));
  return c.json({
    now,
    tab,
    counts: ((counts?.results ?? [])[0] as { pending: number; approved: number; rejected: number } | undefined) ?? { pending: 0, approved: 0, rejected: 0 },
    items: rows.map((b) => ({
      ...bookingDTO(b, now, settings, offset, true),
      proof: proofSummary(b, proofs.get(b.id), links.get(b.id)),
      unreadMessages: unread.get(b.id) ?? 0,
    })),
  });
});

/** Player messages staff haven't read yet, per booking. */
async function unreadByBooking(db: D1Database, ids: string[]): Promise<Map<string, number>> {
  if (!ids.length) return new Map();
  const { results } = await db
    .prepare(
      `SELECT m.booking_id, COUNT(*) AS n FROM messages m
         LEFT JOIN message_reads r ON r.booking_id = m.booking_id AND r.reader = 'staff'
        WHERE m.booking_id IN (SELECT value FROM json_each(?1)) AND m.sender_role = 'player' AND m.kind = 'text'
          AND m.created_at > COALESCE(r.last_read_at, 0)
        GROUP BY m.booking_id`,
    )
    .bind(JSON.stringify(ids))
    .all<{ booking_id: string; n: number }>();
  return new Map(results.map((r) => [r.booking_id, r.n]));
}

// ── Bookings ──────────────────────────────────────────────────────────────

const listSchema = z.object({
  status: z.enum([...STATUSES, 'active', 'holds', 'closed', 'all']).optional(),
  date: zDate.optional(),
  activity: zActivity.optional(),
  q: z.string().trim().max(80).optional(),
  scope: z.enum(['upcoming', 'past', 'all']).optional(),
});

operationsRoutes.get('/bookings', async (c) => {
  const db = c.env.DB;
  const now = Date.now();
  await sweepExpired(c.env, now);
  const q = query(c, listSchema);
  const { settings, offset } = await staffContext(c);
  const local = localNow(offset, now);
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (q.status === 'active') where.push(`b.status IN ('TEMPORARY', 'PAYMENT_SUBMITTED', 'CONFIRMED', 'REJECTED')`);
  else if (q.status === 'holds') where.push(`b.status IN ('TEMPORARY', 'REJECTED')`);
  else if (q.status === 'closed') where.push(`b.status IN ('CANCELLED', 'EXPIRED')`);
  else if (q.status && q.status !== 'all') {
    where.push('b.status = ?');
    params.push(q.status);
  }
  if (q.date) {
    where.push('b.date = ?');
    params.push(q.date);
  }
  if (q.activity) {
    where.push('r.activity = ?');
    params.push(q.activity);
  }
  if (q.q) {
    const like = `%${q.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    where.push(`(b.ref LIKE ? ESCAPE '\\' OR u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\')`);
    params.push(like, like, like);
  }
  if (q.scope === 'upcoming') {
    where.push('b.date >= ?');
    params.push(local.date);
  } else if (q.scope === 'past') {
    where.push('b.date < ?');
    params.push(local.date);
  }
  const order = q.scope === 'upcoming' ? 'b.date ASC, b.start_min ASC' : 'b.date DESC, b.start_min DESC';
  const sql = `${BOOKING_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT 200`;
  const [list, counts] = await db.batch([
    db.prepare(sql).bind(...params),
    db.prepare('SELECT status, COUNT(*) AS n FROM bookings GROUP BY status'),
  ]);
  const rows = (list?.results ?? []) as BookingJoin[];
  const countMap: Record<string, number> = {};
  for (const r of (counts?.results ?? []) as { status: BookingStatus; n: number }[]) countMap[r.status] = r.n;
  const unread = await unreadByBooking(db, rows.map((b) => b.id));
  return c.json({
    now,
    today: local.date,
    counts: countMap,
    bookings: rows.map((b) => ({ ...bookingDTO(b, now, settings, offset, true), unreadMessages: unread.get(b.id) ?? 0 })),
  });
});

async function staffDetail(c: AppContext, bookingId: string, now: number) {
  const db = c.env.DB;
  const { settings, offset } = await staffContext(c);
  const b = await getBooking(db, bookingId);
  const [proofs, timeline, unreadRow, credit, owner] = await Promise.all([
    listProofs(c.env, bookingId),
    listEvents(db, bookingId, true),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM messages m LEFT JOIN message_reads r ON r.booking_id = m.booking_id AND r.reader = 'staff'
          WHERE m.booking_id = ? AND m.sender_role = 'player' AND m.kind = 'text' AND m.created_at > COALESCE(r.last_read_at, 0)`,
      )
      .bind(bookingId)
      .first<{ n: number }>(),
    bookingCreditInfo(db, bookingId, true),
    db.prepare('SELECT role FROM users WHERE id = ?').bind(b.user_id).first<{ role: string }>(),
  ]);
  const booking = bookingDTO(b, now, settings, offset, true);
  const latest = proofs[0];
  const staff = requireStaff(c);
  const today = localNow(offset, now).date;
  // Cancel & credit: confirmed bookings, and finished ones today (admins: up to ADMIN_RETRO_DAYS back).
  const recentlyFinished = booking.status === 'COMPLETED' && (b.date >= today || (staff.role === 'admin' && b.date >= addDays(today, -ADMIN_RETRO_DAYS)));
  return {
    now,
    booking,
    proofs: await Promise.all(
      proofs.map(async (p) => ({
        ...p,
        amountClaimedLabel: p.amountClaimed != null ? peso(p.amountClaimed) : null,
        amountCheck: amountCheck(b, p.amountClaimed),
        ...(await proofLink(c.env, p.id, now)),
      })),
    ),
    amountCheck: latest ? amountCheck(b, latest.amountClaimed) : 'unknown',
    timeline,
    unreadMessages: unreadRow?.n ?? 0,
    credit,
    actions: {
      canApprove: booking.status === 'PAYMENT_SUBMITTED',
      canReject: booking.status === 'PAYMENT_SUBMITTED',
      /** Unpaid holds: the plain cancel (nothing to credit). */
      canCancel: ['TEMPORARY', 'REJECTED'].includes(booking.status),
      /** Paid or confirmed: "Cancel & credit" (a disruption of this one booking). */
      canDisrupt: booking.status === 'CONFIRMED' || recentlyFinished,
      /** Why Cancel & credit isn't offered right now, when it will be later. */
      disruptHint: booking.status === 'PAYMENT_SUBMITTED' ? 'Verify or reject the payment first.' : null,
      /** Admins can add a credit by hand for this booking's player (players only). */
      canIssueCredit: staff.role === 'admin' && owner?.role === 'player',
    },
  };
}

/** A personal booking made on site by the signed-in staff member or admin: confirmed at once. */
const consoleBookingSchema = z
  .object({
    resourceId: zId,
    date: zDate,
    ...zSlotPick,
    rate: z.enum(['member', 'non_member']),
    payment: z.enum(['on_site', 'none']),
  })
  .refine(hasSlotPick, PICK_A_TIME);

operationsRoutes.post('/bookings', async (c) => {
  const staff = requireStaff(c);
  const body = await jsonBody(c, consoleBookingSchema);
  const { settings } = await staffContext(c);
  const starts = requestedStarts(body, settings.slotMinutes);
  const now = Date.now();
  const b = await createConsoleBooking(c.env, settings, staff, { resourceId: body.resourceId, date: body.date, starts, rate: body.rate, payment: body.payment }, now);
  c.executionCtx.waitUntil(audit(c, staff.id, 'booking_created_on_site', 'booking', b.id, JSON.stringify({ payment: body.payment, slots: starts.length })));
  return c.json(await staffDetail(c, b.id, now), 201);
});

operationsRoutes.get('/bookings/:id', async (c) => {
  const id = parse(zId, c.req.param('id'));
  return c.json(await staffDetail(c, id, Date.now()));
});

operationsRoutes.post('/bookings/:id/approve', async (c) => {
  const staff = requireStaff(c);
  const id = parse(zId, c.req.param('id'));
  const body = await jsonBody(
    c,
    z.object({
      message: z.string().trim().max(MESSAGE_MAX_CHARS).optional(),
      // The "Before you approve" checklist: every item has to be ticked.
      checklist: z.literal(true, { error: 'Tick every item on the "Before you approve" checklist first.' }),
    }),
  );
  const now = Date.now();
  await approvePayment(c.env, staff, id, now, body.message || null);
  c.executionCtx.waitUntil(audit(c, staff.id, 'payment_approved', 'booking', id));
  // A disruption that was waiting on this payment now cancels the booking and issues its credit.
  const disruptions = await resolveDeferredForBooking(c, staff, id, clientIp(c));
  return c.json({ ...(await staffDetail(c, id, Date.now())), resolvedDisruptions: disruptions });
});

const rejectSchema = z.object({
  reason: z.string().trim().min(3, 'Tell the player why the proof was rejected.').max(300, 'Keep the reason under 300 characters.'),
  message: z.string().trim().max(MESSAGE_MAX_CHARS).optional(),
  keepHold: z.boolean().default(true),
});

operationsRoutes.post('/bookings/:id/reject', async (c) => {
  const staff = requireStaff(c);
  const id = parse(zId, c.req.param('id'));
  const body = await jsonBody(c, rejectSchema);
  const { settings } = await staffContext(c);
  const now = Date.now();
  await rejectPayment(c.env, settings, staff, id, { reason: body.reason, message: body.message || null, keepHold: body.keepHold }, now);
  c.executionCtx.waitUntil(audit(c, staff.id, 'payment_rejected', 'booking', id, body.reason));
  // Rejected for good: a disruption that was waiting on this payment has nothing to credit.
  const disruptions = body.keepHold ? [] : await resolveDeferredForBooking(c, staff, id, clientIp(c));
  return c.json({ ...(await staffDetail(c, id, Date.now())), resolvedDisruptions: disruptions });
});

operationsRoutes.post('/bookings/:id/cancel', async (c) => {
  const staff = requireStaff(c);
  const id = parse(zId, c.req.param('id'));
  const body = await jsonBody(c, z.object({ reason: z.string().trim().min(3, 'Give a reason for the player.').max(300) }));
  const now = Date.now();
  await staffCancel(c.env, staff, id, body.reason, now);
  c.executionCtx.waitUntil(audit(c, staff.id, 'booking_cancelled', 'booking', id, body.reason));
  return c.json(await staffDetail(c, id, now));
});

// ── Schedule grid (with names — staff only) ────────────────────────────────

operationsRoutes.get('/schedule', async (c) => {
  const q = query(c, z.object({ date: zDate.optional(), activity: zActivity.optional() }));
  const { settings, offset } = await staffContext(c);
  const now = Date.now();
  const date = q.date ?? localNow(offset, now).date;
  if (!isValidDate(date)) throw unprocessable('VALIDATION_ERROR', 'Use a real date (YYYY-MM-DD).');
  return c.json(await dayAvailability(c.env, settings, { activity: q.activity ?? null, date }, { staff: true }, now));
});

// ── Booking chat (staff side) ──────────────────────────────────────────────

operationsRoutes.get('/messages', async (c) => {
  const now = Date.now();
  const rows = await staffConversations(c.env.DB);
  return c.json({
    now,
    conversations: rows.map((r) => ({
      bookingId: r.id,
      ref: r.ref,
      status: effectiveStatus({ status: r.status as BookingStatus, hold_expires_at: r.hold_expires_at }, now),
      resourceName: r.resource_name,
      activity: r.activity,
      userName: r.user_name,
      dateLabel: dateLabel(r.date),
      timeLabel: slotLabel(r),
      last: {
        body: r.last_kind === 'proof' ? 'Sent a payment screenshot' : r.last_body.slice(0, 140),
        kind: r.last_kind,
        sender: r.last_sender,
        at: r.last_at,
      },
      unread: r.unread,
    })),
  });
});

operationsRoutes.get('/bookings/:id/messages', async (c) => {
  const staff = requireStaff(c);
  const id = parse(zId, c.req.param('id'));
  const now = Date.now();
  const b = await getBooking(c.env.DB, id);
  const { settings, offset } = await staffContext(c);
  const messages = await listMessages(c.env, id, { side: 'staff', userId: staff.id }, now);
  c.executionCtx.waitUntil(markRead(c.env, id, 'staff', staff.id, now).catch((err) => console.error('markRead failed', err)));
  return c.json({ now, booking: bookingDTO(b, now, settings, offset, true), messages });
});

operationsRoutes.post('/bookings/:id/messages', async (c) => {
  const staff = requireStaff(c);
  const id = parse(zId, c.req.param('id'));
  const body = await jsonBody(
    c,
    z.object({ body: z.string().trim().min(1, 'Write a message first.').max(MESSAGE_MAX_CHARS, `Keep messages under ${MESSAGE_MAX_CHARS} characters.`) }),
  );
  const b = await getBooking(c.env.DB, id);
  const now = Date.now();
  await postMessage(c.env, staff, 'staff', b, body.body, now);
  return c.json({ now, messages: await listMessages(c.env, id, { side: 'staff', userId: staff.id }, now) }, 201);
});

// ── Staff notification center ──────────────────────────────────────────────

operationsRoutes.get('/notifications', async (c) => {
  const db = c.env.DB;
  const q = query(c, z.object({ filter: z.enum(['unresolved', 'all']).optional() }));
  const [list, counts] = await db.batch([
    db.prepare(
      `SELECT id, type, title, body, link, booking_id, read_at, resolved_at, created_at
         FROM notifications WHERE audience = 'staff'${q.filter === 'unresolved' ? ' AND resolved_at IS NULL' : ''}
        ORDER BY created_at DESC LIMIT 100`,
    ),
    db.prepare(
      `SELECT (SELECT COUNT(*) FROM notifications WHERE audience = 'staff' AND resolved_at IS NULL) AS unresolved,
              (SELECT COUNT(*) FROM notifications WHERE audience = 'staff' AND read_at IS NULL) AS unread`,
    ),
  ]);
  const n = ((counts?.results ?? [])[0] as { unresolved: number; unread: number } | undefined) ?? { unresolved: 0, unread: 0 };
  return c.json({
    now: Date.now(),
    unresolved: n.unresolved,
    unread: n.unread,
    notifications: ((list?.results ?? []) as Parameters<typeof notificationDTO>[0][]).map(notificationDTO),
  });
});

operationsRoutes.post('/notifications/read', async (c) => {
  const body = await jsonBody(c, readSchema);
  const now = Date.now();
  if (body.all) {
    await c.env.DB.prepare(`UPDATE notifications SET read_at = ? WHERE audience = 'staff' AND read_at IS NULL`).bind(now).run();
  } else {
    await c.env.DB.prepare(`UPDATE notifications SET read_at = ? WHERE audience = 'staff' AND read_at IS NULL AND id IN (SELECT value FROM json_each(?))`)
      .bind(now, JSON.stringify(body.ids))
      .run();
  }
  return c.json({ ok: true });
});

operationsRoutes.post('/notifications/:id/resolve', async (c) => {
  const id = parse(zId, c.req.param('id'));
  const now = Date.now();
  const res = await c.env.DB.prepare(
    `UPDATE notifications SET resolved_at = COALESCE(resolved_at, ?1), read_at = COALESCE(read_at, ?1) WHERE id = ?2 AND audience = 'staff'`,
  )
    .bind(now, id)
    .run();
  if (!res.meta.changes) throw notFound('Notification not found.');
  return c.json({ ok: true });
});

// ── Courts and tables, weekly hours, closures ─────────────────────────────

operationsRoutes.route('/', facilityAdminRoutes);

// ── Disruptions (cancel & credit) and booking credits ─────────────────────

operationsRoutes.route('/', disruptionRoutes);
operationsRoutes.route('/', staffCreditRoutes);
