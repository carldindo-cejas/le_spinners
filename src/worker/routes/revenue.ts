import { Hono } from 'hono';
import * as z from 'zod';
import type { AppContext, AppEnv, PaymentMethod } from '../types';
import { audit, requireAdmin } from '../lib/auth';
import { SEGMENTS_SQL, activityLabel, bookedMinutes, paymentMethodLabel, segmentsOf, slotLabel } from '../lib/bookings';
import { unprocessable } from '../lib/errors';
import { addDays, dateLabel, daysBetween, isValidDate, localNow, localToMs, MINUTE_MS, offsetMinutes, peso, weekdayOf } from '../lib/time';
import { query, zActivity, zDate, zId } from '../lib/validate';
import { creditAccounting } from '../lib/credits';

/**
 * Revenue reporting for the admin console (/revenue/). Read-only: nothing here
 * changes a booking or a payment proof.
 *
 * Accounting rules (one row per booking, so resubmitted proofs never double count):
 *   - Revenue is collected when staff verify the payment: bookings.confirmed_at,
 *     amount bookings.amount_due. Only bookings still CONFIRMED or COMPLETED count.
 *   - Console bookings paid at the front desk (payment_method 'on_site') are verified
 *     when they are made. Free console bookings ('none') have no payment and no row.
 *   - Proofs waiting for verification, rejected proofs, holds and expired or
 *     released bookings are never revenue.
 *   - A verified booking that was later cancelled ("cancelled after payment") is
 *     reported separately and left out of status-based collected revenue. Credit
 *     refunds are recorded in credit_transactions; /accounting separates those
 *     payouts and active credit balances from verified cash. External settlement
 *     and the business liability policy still require reconciliation/acceptance.
 * Reporting periods use facility time (TZ_OFFSET_MINUTES, Asia/Manila); weeks run Monday–Sunday.
 */
export const revenueRoutes = new Hono<AppEnv>();

// Mounted under /api/admin (admins only, src/worker/index.ts); checked again here.
revenueRoutes.use('*', async (c, next) => {
  requireAdmin(c);
  await next();
});

const COLLECTED = `status IN ('CONFIRMED', 'COMPLETED')`;
const CANCELLED_PAID = `status = 'CANCELLED'`;
const EXPORT_PART_ROWS = 1000; // ~4 ms of CPU per part (measured), inside the Free plan's 10 ms
const EXPORT_MAX_ROWS = 50_000;

// ── Calendar helpers (facility-local YYYY-MM-DD) ───────────────────────────

function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

const startOfWeek = (date: string) => addDays(date, -((weekdayOf(date) + 6) % 7)); // Monday
const startOfMonth = (date: string) => `${date.slice(0, 7)}-01`;
const startOfYear = (date: string) => `${date.slice(0, 4)}-01-01`;

function shortRange(from: string, toInclusive: string): string {
  return from === toInclusive ? dateLabel(from) : `${dateLabel(from)} – ${dateLabel(toInclusive)}`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const monthDay = (date: string) => `${MONTHS[Number(date.slice(5, 7)) - 1]} ${Number(date.slice(8, 10))}`;

/** "Sep 25 – Oct 1, 2026" · "Oct 2, 2025 – Oct 1, 2026" · "Oct 1, 2026" */
function rangeLabel(from: string, to: string): string {
  if (from === to) return `${monthDay(to)}, ${to.slice(0, 4)}`;
  if (from.slice(0, 4) === to.slice(0, 4)) return `${monthDay(from)} – ${monthDay(to)}, ${to.slice(0, 4)}`;
  return `${monthDay(from)}, ${from.slice(0, 4)} – ${monthDay(to)}, ${to.slice(0, 4)}`;
}

function change(current: number, previous: number) {
  const amount = current - previous;
  return {
    amount,
    // No percentage against a zero baseline (it would be infinite); the UI says so instead.
    pct: previous > 0 ? Math.round((amount / previous) * 1000) / 10 : null,
    direction: amount > 0 ? 'up' : amount < 0 ? 'down' : 'flat',
  };
}

// ── Summary cards ──────────────────────────────────────────────────────────

revenueRoutes.get('/accounting', async (c) => {
  requireAdmin(c);
  const now=Date.now();
  return c.json({now,...await creditAccounting(c.env.DB,now)});
});

revenueRoutes.get('/summary', async (c) => {
  const db = c.env.DB;
  const offset = offsetMinutes(c.env.TZ_OFFSET_MINUTES);
  const now = Date.now();
  const today = localNow(offset, now).date;
  const ms = (date: string) => localToMs(date, 0, offset);

  const periods = [
    { key: 'day', label: 'Daily revenue', compare: 'yesterday', start: today, end: addDays(today, 1), prevStart: addDays(today, -1) },
    { key: 'week', label: 'Weekly revenue', compare: 'last week', start: startOfWeek(today), end: addDays(startOfWeek(today), 7), prevStart: addDays(startOfWeek(today), -7) },
    { key: 'month', label: 'Monthly revenue', compare: 'last month', start: startOfMonth(today), end: addMonths(startOfMonth(today), 1), prevStart: addMonths(startOfMonth(today), -1) },
    { key: 'year', label: 'Yearly revenue', compare: 'last year', start: startOfYear(today), end: addMonths(startOfYear(today), 12), prevStart: addMonths(startOfYear(today), -12) },
  ] as const;

  // One aggregate query over the confirmed_at index. Each period has:
  //   cur      period start → now
  //   prevTd   the previous period up to the same point ("so far" comparison)
  //   prevFull the whole previous period
  //   cxl      verified this period, cancelled since (not counted as collected)
  const cols: string[] = [];
  const binds: number[] = [];
  const sum = (name: string, cond: string, from: number, to: number) => {
    binds.push(from, to);
    const a = binds.length - 1;
    const b = binds.length;
    const when = `${cond} AND confirmed_at >= ?${a} AND confirmed_at < ?${b}`;
    cols.push(`COALESCE(SUM(CASE WHEN ${when} THEN amount_due END), 0) AS ${name}_amt`, `COUNT(CASE WHEN ${when} THEN 1 END) AS ${name}_n`);
  };
  for (const p of periods) {
    const start = ms(p.start);
    const prevStart = ms(p.prevStart);
    const prevEnd = start;
    sum(`${p.key}_cur`, COLLECTED, start, ms(p.end));
    sum(`${p.key}_prevtd`, COLLECTED, prevStart, Math.min(prevStart + (now - start), prevEnd));
    sum(`${p.key}_prevfull`, COLLECTED, prevStart, prevEnd);
    sum(`${p.key}_cxl`, CANCELLED_PAID, start, ms(p.end));
  }
  binds.push(ms(periods[3].prevStart));
  const minParam = binds.length;

  const [agg, pending, resources] = await db.batch([
    // Free console bookings ("No charge") are confirmed but carry no payment: never a payment here.
    db.prepare(`SELECT ${cols.join(', ')} FROM bookings WHERE confirmed_at IS NOT NULL AND confirmed_at >= ?${minParam} AND payment_method != 'none'`).bind(...binds),
    db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(amount_due), 0) AS amt FROM bookings WHERE status = 'PAYMENT_SUBMITTED'`),
    db.prepare('SELECT id, name, activity FROM resources ORDER BY activity, sort_order, name'),
  ]);
  const row = ((agg?.results ?? [])[0] ?? {}) as Record<string, number>;
  const pend = ((pending?.results ?? [])[0] ?? { n: 0, amt: 0 }) as { n: number; amt: number };
  const val = (k: string) => Number(row[k] ?? 0);

  return c.json({
    now,
    today,
    timezone: { name: 'Asia/Manila', offsetMinutes: offset },
    periods: periods.map((p) => {
      const current = val(`${p.key}_cur_amt`);
      const previous = val(`${p.key}_prevtd_amt`);
      const prevEndInclusive = addDays(p.start, -1);
      return {
        key: p.key,
        label: p.label,
        from: p.start,
        to: today,
        rangeLabel: p.key === 'day' ? dateLabel(today) : shortRange(p.start, today),
        collected: current,
        collectedLabel: peso(current),
        payments: val(`${p.key}_cur_n`),
        previous: {
          from: p.prevStart,
          to: prevEndInclusive,
          compare: p.compare,
          toDate: previous,
          toDateLabel: peso(previous),
          full: val(`${p.key}_prevfull_amt`),
          fullLabel: peso(val(`${p.key}_prevfull_amt`)),
        },
        change: change(current, previous),
        cancelledAfterPayment: { amount: val(`${p.key}_cxl_amt`), count: val(`${p.key}_cxl_n`) },
      };
    }),
    pendingVerification: { amount: pend.amt, count: pend.n },
    resources: ((resources?.results ?? []) as { id: string; name: string; activity: 'pickleball' | 'table_tennis' }[]).map((r) => ({
      id: r.id,
      name: r.name,
      activity: r.activity,
    })),
    methods: [{ value: 'gcash', label: 'GCash' }, { value: 'on_site', label: 'Paid on site' }],
  });
});

// ── Booking ledger ─────────────────────────────────────────────────────────

/** Empty query values ("?q=") mean "not set". */
const opt = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

const PAY_STATUSES = ['paid', 'pending', 'rejected', 'cancelled_paid', 'cancelled_credited', 'cancelled_unverified'] as const;
type PayStatus = (typeof PAY_STATUSES)[number];
const SORTS = ['date', 'ref', 'user', 'facility', 'type', 'duration', 'amount', 'method', 'status'] as const;

const ledgerSchema = z.object({
  from: opt(zDate),
  to: opt(zDate),
  q: opt(z.string().trim().max(80)),
  resource: opt(zId),
  type: opt(zActivity),
  method: opt(z.enum(['gcash', 'on_site'])),
  status: opt(z.enum(PAY_STATUSES)),
  sort: opt(z.enum(SORTS)),
  dir: opt(z.enum(['asc', 'desc'])),
  page: opt(z.coerce.number().int().min(1).max(100_000)),
  size: opt(z.coerce.number().int().refine((n) => n === 10 || n === 25 || n === 50, 'Use 10, 25 or 50 rows per page.')),
});
type LedgerQuery = z.infer<typeof ledgerSchema>;

// Each booking that ever had a payment proof is one ledger row. Its payment status
// and timestamp come from the booking's own verification fields:
//   paid                   verified, booking kept (CONFIRMED / COMPLETED)   → at confirmed_at
//   cancelled_credited     verified, cancelled by Le Spinners with a booking credit → at confirmed_at
//   cancelled_paid         verified, cancelled later, no credit recorded    → at confirmed_at
//   pending                proof waiting for staff                         → at submitted_at
//   rejected               latest proof rejected (window open, lapsed or released) → at rejected_at
//   cancelled_unverified   cancelled while the proof was still unchecked   → at submitted_at
// amount_due is the cash part; credit_applied (booking credit used) is never cash collected.
const LEDGER_CTE = `
  WITH ledger AS (
    SELECT b.id, b.ref, b.status, b.date, b.start_min, b.end_min, b.amount_due, b.rate, b.payment_method, b.credit_applied,
           ${SEGMENTS_SQL('b')},
           (SELECT COALESCE(SUM(t.end_min - t.start_min), 0) FROM booking_times t WHERE t.booking_id = b.id) AS booked_min,
           b.submitted_at, b.confirmed_at, b.rejected_at, b.cancelled_at, b.updated_at, b.resource_id,
           r.name AS resource_name, r.activity, u.name AS user_name, u.email AS user_email, b.booker_name,
           cu.name AS verified_by,
           CASE WHEN b.confirmed_at IS NOT NULL AND b.status IN ('CONFIRMED', 'COMPLETED') THEN 'paid'
                WHEN b.confirmed_at IS NOT NULL AND EXISTS (SELECT 1 FROM booking_credits c WHERE c.source_booking_id = b.id) THEN 'cancelled_credited'
                WHEN b.confirmed_at IS NOT NULL THEN 'cancelled_paid'
                WHEN b.status = 'PAYMENT_SUBMITTED' THEN 'pending'
                WHEN b.rejected_at IS NOT NULL AND b.rejected_at >= b.submitted_at THEN 'rejected'
                ELSE 'cancelled_unverified' END AS pay_status,
           CASE WHEN b.confirmed_at IS NOT NULL THEN b.confirmed_at
                WHEN b.status = 'PAYMENT_SUBMITTED' THEN b.submitted_at
                WHEN b.rejected_at IS NOT NULL AND b.rejected_at >= b.submitted_at THEN b.rejected_at
                ELSE b.submitted_at END AS pay_at
      FROM bookings b
      JOIN resources r ON r.id = b.resource_id
      JOIN users u ON u.id = b.user_id
      LEFT JOIN users cu ON cu.id = b.confirmed_by
     WHERE b.submitted_at IS NOT NULL
  )`;

const SORT_SQL: Record<(typeof SORTS)[number], string> = {
  date: 'pay_at',
  ref: 'ref',
  user: 'COALESCE(booker_name, user_name) COLLATE NOCASE',
  facility: 'resource_name COLLATE NOCASE',
  type: 'activity',
  duration: 'booked_min',
  amount: 'amount_due',
  method: 'payment_method',
  status: `CASE pay_status WHEN 'paid' THEN 1 WHEN 'pending' THEN 2 WHEN 'rejected' THEN 3 WHEN 'cancelled_credited' THEN 4 WHEN 'cancelled_paid' THEN 5 ELSE 6 END`,
};

type LedgerRow = {
  id: string;
  ref: string;
  status: string;
  date: string;
  start_min: number;
  end_min: number;
  segments_json: string | null;
  booked_min: number;
  amount_due: number;
  rate: 'member' | 'non_member';
  payment_method: PaymentMethod;
  credit_applied: number;
  submitted_at: number;
  confirmed_at: number | null;
  rejected_at: number | null;
  cancelled_at: number | null;
  resource_id: string;
  resource_name: string;
  activity: 'pickleball' | 'table_tennis';
  user_name: string;
  user_email: string;
  booker_name: string | null;
  verified_by: string | null;
  pay_status: PayStatus;
  pay_at: number;
  gcash_ref: string | null;
};

/** Validates the filters and turns them into a WHERE clause over the ledger CTE. */
function ledgerFilter(c: AppContext, raw: LedgerQuery) {
  const offset = offsetMinutes(c.env.TZ_OFFSET_MINUTES);
  const today = localNow(offset).date;
  const to = raw.to ?? today;
  const from = raw.from ?? addDays(to, -6);
  if (!isValidDate(from) || !isValidDate(to)) throw unprocessable('VALIDATION_ERROR', 'Use real dates (YYYY-MM-DD).');
  if (from > to) throw unprocessable('VALIDATION_ERROR', 'The start date must be on or before the end date.');
  if (daysBetween(from, to) > 366 * 5) throw unprocessable('VALIDATION_ERROR', 'Choose a date range of 5 years or less.');

  const where = ['pay_at >= ?', 'pay_at < ?'];
  const params: (string | number)[] = [localToMs(from, 0, offset), localToMs(addDays(to, 1), 0, offset)];
  if (raw.q) {
    const like = `%${raw.q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    where.push(`(ref LIKE ? ESCAPE '\\' OR id = ? OR user_name LIKE ? ESCAPE '\\' OR user_email LIKE ? ESCAPE '\\' OR booker_name LIKE ? ESCAPE '\\' OR resource_name LIKE ? ESCAPE '\\')`);
    params.push(like, raw.q, like, like, like, like);
  }
  if (raw.resource) {
    where.push('resource_id = ?');
    params.push(raw.resource);
  }
  if (raw.type) {
    where.push('activity = ?');
    params.push(raw.type);
  }
  if (raw.method) {
    where.push('payment_method = ?');
    params.push(raw.method);
  }
  if (raw.status) {
    where.push('pay_status = ?');
    params.push(raw.status);
  }
  const sort = raw.sort ?? 'date';
  const dir = raw.dir ?? 'desc';
  return {
    from,
    to,
    offset,
    sql: `WHERE ${where.join(' AND ')}`,
    params,
    order: `ORDER BY ${SORT_SQL[sort]} ${dir === 'asc' ? 'ASC' : 'DESC'}, pay_at DESC, id ASC`,
    sort,
    dir,
  };
}

const PAY_LABEL: Record<PayStatus, string> = {
  paid: 'Paid · verified',
  pending: 'Pending verification',
  rejected: 'Proof rejected',
  cancelled_paid: 'Cancelled after payment',
  cancelled_credited: 'Cancelled · credited',
  cancelled_unverified: 'Cancelled · not verified',
};

const AT_KIND: Record<PayStatus, string> = {
  paid: 'Verified',
  cancelled_paid: 'Verified',
  cancelled_credited: 'Verified',
  pending: 'Proof submitted',
  rejected: 'Rejected',
  cancelled_unverified: 'Proof submitted',
};

function rowDTO(r: LedgerRow) {
  return {
    id: r.id,
    ref: r.ref,
    at: r.pay_at,
    atKind: AT_KIND[r.pay_status],
    payStatus: r.pay_status,
    payStatusLabel: PAY_LABEL[r.pay_status],
    countsAsRevenue: r.pay_status === 'paid',
    bookingStatus: r.status,
    date: r.date,
    dateLabel: dateLabel(r.date),
    timeLabel: slotLabel(r),
    start: r.start_min,
    end: r.end_min,
    segments: segmentsOf(r),
    durationMin: bookedMinutes(r),
    user: { name: r.user_name, email: r.user_email },
    /** Console bookings: who it's for (user is the staff account it's booked under). */
    bookerName: r.booker_name,
    resource: { id: r.resource_id, name: r.resource_name },
    activity: r.activity,
    activityLabel: activityLabel(r.activity),
    rate: r.rate,
    amount: r.amount_due,
    amountLabel: peso(r.amount_due),
    method: r.payment_method,
    methodLabel: paymentMethodLabel(r.payment_method, r.credit_applied),
    /** Booking credit that paid the rest (never cash collected). */
    creditApplied: r.credit_applied,
    gcashRef: r.gcash_ref,
    verifiedBy: r.verified_by,
    cancelledAt: r.cancelled_at,
  };
}

const ROW_SELECT = `SELECT l.*, (SELECT p.gcash_ref FROM payment_proofs p WHERE p.booking_id = l.id ORDER BY p.created_at DESC LIMIT 1) AS gcash_ref FROM ledger l`;

revenueRoutes.get('/ledger', async (c) => {
  const db = c.env.DB;
  const q = query(c, ledgerSchema);
  const f = ledgerFilter(c, q);
  const size = q.size ?? 10;
  let page = q.page ?? 1;

  const totalsStmt = db
    .prepare(
      `${LEDGER_CTE}
       SELECT COUNT(*) AS n,
              COALESCE(SUM(CASE WHEN pay_status = 'paid' THEN amount_due END), 0) AS paid_amt,
              COUNT(CASE WHEN pay_status = 'paid' THEN 1 END) AS paid_n,
              COALESCE(SUM(CASE WHEN pay_status = 'pending' THEN amount_due END), 0) AS pending_amt,
              COUNT(CASE WHEN pay_status = 'pending' THEN 1 END) AS pending_n,
              COALESCE(SUM(CASE WHEN pay_status IN ('cancelled_paid', 'cancelled_credited') THEN amount_due END), 0) AS cxl_amt,
              COUNT(CASE WHEN pay_status IN ('cancelled_paid', 'cancelled_credited') THEN 1 END) AS cxl_n
         FROM ledger ${f.sql}`,
    )
    .bind(...f.params);
  const pageStmt = (p: number) => db.prepare(`${LEDGER_CTE} ${ROW_SELECT} ${f.sql} ${f.order} LIMIT ? OFFSET ?`).bind(...f.params, size, (p - 1) * size);

  const [totalsRes, rowsRes] = await db.batch([totalsStmt, pageStmt(page)]);
  const t = ((totalsRes?.results ?? [])[0] ?? {}) as Record<string, number>;
  const total = Number(t.n ?? 0);
  const pages = Math.max(1, Math.ceil(total / size));
  let rows = (rowsRes?.results ?? []) as LedgerRow[];
  if (page > pages) {
    // Asked past the end (rows were filtered away since): serve the last page instead.
    page = pages;
    rows = (await pageStmt(page).all<LedgerRow>()).results;
  }

  return c.json({
    now: Date.now(),
    range: { from: f.from, to: f.to, label: rangeLabel(f.from, f.to), days: daysBetween(f.from, f.to) + 1 },
    sort: f.sort,
    dir: f.dir,
    page,
    size,
    pages,
    total,
    totals: {
      collected: Number(t.paid_amt ?? 0),
      collectedLabel: peso(Number(t.paid_amt ?? 0)),
      collectedCount: Number(t.paid_n ?? 0),
      pending: Number(t.pending_amt ?? 0),
      pendingLabel: peso(Number(t.pending_amt ?? 0)),
      pendingCount: Number(t.pending_n ?? 0),
      cancelledAfterPayment: Number(t.cxl_amt ?? 0),
      cancelledAfterPaymentLabel: peso(Number(t.cxl_amt ?? 0)),
      cancelledAfterPaymentCount: Number(t.cxl_n ?? 0),
    },
    rows: rows.map(rowDTO),
  });
});

// ── CSV export (same filters, sort and accounting as the ledger) ──────────

/** Quotes a CSV cell and defuses spreadsheet formulas in user-entered text. */
function csvCell(value: string | number | null | undefined): string {
  let s = value == null ? '' : String(value);
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function localStamp(ms: number | null, offset: number): string {
  if (!ms) return '';
  return new Date(ms + offset * MINUTE_MS).toISOString().slice(0, 16).replace('T', ' ');
}

const exportSchema = ledgerSchema.extend({
  part: opt(z.coerce.number().int().min(1).max(EXPORT_MAX_ROWS / EXPORT_PART_ROWS)),
});

const EXPORT_HEADER = [
  'Payment date (Asia/Manila)', 'Recorded as', 'Booking reference', 'Customer', 'Email', 'Facility', 'Type',
  'Booking date', 'Booking time', 'Duration (min)', 'Amount (PHP)', 'Payment method', 'GCash reference',
  'Payment status', 'Counts as collected revenue', 'Verified by', 'Booking status', 'Cancelled at (Asia/Manila)',
];

/**
 * The CSV comes in parts of EXPORT_PART_ROWS rows so each request stays well inside the
 * Workers Free CPU limit; the page fetches every part and saves one file. Part 1 carries
 * the byte-order mark and the header row. X-Export-Version (row count + latest change)
 * lets the page restart if payments change between parts, so no row is skipped or repeated.
 */
revenueRoutes.get('/export', async (c) => {
  const admin = requireAdmin(c);
  const db = c.env.DB;
  const q = query(c, exportSchema);
  const f = ledgerFilter(c, q);
  const part = q.part ?? 1;
  const [metaRes, rowsRes] = await db.batch([
    db.prepare(`${LEDGER_CTE} SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), 0) AS v FROM ledger ${f.sql}`).bind(...f.params),
    db.prepare(`${LEDGER_CTE} ${ROW_SELECT} ${f.sql} ${f.order} LIMIT ? OFFSET ?`).bind(...f.params, EXPORT_PART_ROWS, (part - 1) * EXPORT_PART_ROWS),
  ]);
  const meta = ((metaRes?.results ?? [])[0] ?? { n: 0, v: 0 }) as { n: number; v: number };
  if (meta.n > EXPORT_MAX_ROWS) {
    throw unprocessable('EXPORT_TOO_LARGE', `That's more than ${EXPORT_MAX_ROWS.toLocaleString('en-PH')} records. Choose a shorter date range or add a filter, then export again.`);
  }
  const parts = Math.max(1, Math.ceil(meta.n / EXPORT_PART_ROWS));
  if (part > parts) throw unprocessable('VALIDATION_ERROR', `This export has ${parts} part${parts === 1 ? '' : 's'}.`);

  const lines = part === 1 ? [EXPORT_HEADER.map(csvCell).join(',')] : [];
  for (const r of (rowsRes?.results ?? []) as LedgerRow[]) {
    lines.push([
      // A console booking's customer is its booker (no email); "Verified by" names the staff member who booked it.
      localStamp(r.pay_at, f.offset), AT_KIND[r.pay_status], r.ref, r.booker_name ?? r.user_name, r.booker_name ? '' : r.user_email, r.resource_name, activityLabel(r.activity),
      r.date, slotLabel(r), bookedMinutes(r), (r.amount_due / 100).toFixed(2), paymentMethodLabel(r.payment_method), r.gcash_ref,
      PAY_LABEL[r.pay_status], r.pay_status === 'paid' ? 'Yes' : 'No', r.verified_by, r.status, localStamp(r.cancelled_at, f.offset),
    ].map(csvCell).join(','));
  }
  if (part === 1) {
    c.executionCtx.waitUntil(
      audit(c, admin.id, 'revenue_exported', 'revenue', undefined, JSON.stringify({ from: f.from, to: f.to, q: q.q ?? null, resource: q.resource ?? null, type: q.type ?? null, status: q.status ?? null, sort: f.sort, dir: f.dir, rows: meta.n })),
    );
  }
  const bom = part === 1 ? String.fromCharCode(0xfeff) : '';
  return new Response(`${bom}${lines.map((l) => `${l}\r\n`).join('')}`, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="le-spinners-revenue-${f.from}_to_${f.to}.csv"`,
      'Cache-Control': 'no-store',
      'X-Export-Rows': String(meta.n),
      'X-Export-Part': String(part),
      'X-Export-Parts': String(parts),
      'X-Export-Version': `${meta.n}-${meta.v}`,
    },
  });
});
