import { Hono } from 'hono';
import * as z from 'zod';
import type { AppEnv, ResourceRow } from '../types';
import { alternativesFor, dayAvailability, daysSummary } from '../lib/availability';
import { requirePlayer, requireUser } from '../lib/auth';
import { activityLabel, isOpenPlay, underMaintenance, type HoursRow } from '../lib/bookings';
import { notFound, unprocessable } from '../lib/errors';
import { publicSettings, loadSettings } from '../lib/settings';
import { addDays, dateLabel, daysBetween, hoursLabel, isValidDate, localNow, offsetMinutes, peso } from '../lib/time';
import { parse, query, zActivity, zDate, zId } from '../lib/validate';
import { listPaymentMethods, type PaymentMethodRow } from '../lib/payment-methods';

export const facilityRoutes = new Hono<AppEnv>();

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Facility info for the app shell. GCash details are only sent to signed-in players. */
facilityRoutes.get('/facility', async (c) => {
  const db = c.env.DB;
  const settings = await loadSettings(db);
  const now = Date.now();
  const offset = offsetMinutes(c.env.TZ_OFFSET_MINUTES);
  const local = localNow(offset, now);
  const [resources, hours] = await db.batch([
    db.prepare(`SELECT * FROM resources WHERE status != 'disabled' ORDER BY activity, sort_order, name`),
    db.prepare('SELECT * FROM opening_hours ORDER BY weekday'),
  ]);
  const pub = publicSettings(settings);
  const resourceRows = (resources?.results ?? []) as ResourceRow[];
  const activities = (['pickleball', 'table_tennis'] as const).map((id) => {
    const rows = resourceRows.filter((r) => r.activity === id);
    const fromMember = rows.length ? Math.min(...rows.map((r) => r.price_member)) : 0;
    const fromNonMember = rows.length ? Math.min(...rows.map((r) => r.price_non_member)) : 0;
    return {
      id,
      label: activityLabel(id),
      unit: id === 'pickleball' ? 'court' : 'table',
      count: rows.length,
      priceMember: fromMember,
      priceNonMember: fromNonMember,
      priceMemberLabel: peso(fromMember),
      priceNonMemberLabel: peso(fromNonMember),
    };
  });
  return c.json({
    now,
    today: local.date,
    todayLabel: dateLabel(local.date),
    tzOffsetMinutes: offset,
    facility: { name: pub.facilityName, address: pub.facilityAddress, mapsUrl: pub.facilityMapsUrl },
    gcash: c.get('user') ? pub.gcash : null,
    paymentMethods: c.get('user') ? await listPaymentMethods(db, true) : [],
    rules: pub.rules,
    hours: ((hours?.results ?? []) as HoursRow[]).map((h) => ({
      weekday: h.weekday,
      name: WEEKDAY_NAMES[h.weekday] ?? '',
      isOpen: Boolean(h.is_open),
      open: h.open_min,
      close: h.close_min,
      label: h.is_open ? hoursLabel(h.open_min, h.close_min) : 'Closed',
    })),
    activities,
    resources: resourceRows.map((r) => {
      const maintenance = underMaintenance(r, local.date);
      return {
        id: r.id,
        activity: r.activity,
        name: r.name,
        status: maintenance ? 'maintenance' : isOpenPlay(r) ? 'open_play' : 'active',
        maintenance: maintenance ? { note: r.maintenance_note, until: r.maintenance_until, untilLabel: r.maintenance_until ? dateLabel(r.maintenance_until) : null } : null,
        priceMember: r.price_member,
        priceNonMember: r.price_non_member,
      };
    }),
  });
});

facilityRoutes.get('/facility/payment-methods/:id/qr', async (c) => {
  const user = requireUser(c);
  const id = parse(zId, c.req.param('id'));
  const method = await c.env.DB.prepare(`SELECT * FROM payment_methods WHERE id=? AND deleted_at IS NULL ${user.role === 'admin' ? '' : 'AND enabled=1'}`)
    .bind(id).first<PaymentMethodRow>();
  if (!method?.qr_key) throw notFound('QR image not found.');
  const obj = await c.env.PROOFS.get(method.qr_key);
  if (!obj) throw notFound('QR image not found.');
  return new Response(obj.body, { headers: {
    'Content-Type': obj.httpMetadata?.contentType ?? 'image/png',
    'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff',
  } });
});

/** The GCash QR image. Any signed-in role: players on the payment screen, admins in Settings. */
facilityRoutes.get('/facility/gcash-qr', async (c) => {
  requireUser(c);
  const settings = await loadSettings(c.env.DB);
  if (!settings.gcashQrKey) throw notFound('No GCash QR code has been uploaded yet.');
  const obj = await c.env.PROOFS.get(settings.gcashQrKey);
  if (!obj) throw notFound('No GCash QR code has been uploaded yet.');
  return new Response(obj.body, {
    headers: {
      'Content-Type': obj.httpMetadata?.contentType ?? 'image/png',
      'Cache-Control': 'private, max-age=300',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      'Cross-Origin-Resource-Policy': 'same-origin',
    },
  });
});

function checkPlayerDate(date: string, today: string, windowDays: number) {
  if (!isValidDate(date)) throw unprocessable('VALIDATION_ERROR', 'Use a real date (YYYY-MM-DD).', { date: ['Invalid date.'] });
  const ahead = daysBetween(today, date);
  if (ahead < 0) throw unprocessable('DATE_PAST', 'That date has already passed.');
  if (ahead > windowDays) {
    throw unprocessable('OUTSIDE_WINDOW', `Bookings open ${windowDays} days ahead. You can book up to ${dateLabel(addDays(today, windowDays))}.`);
  }
}

/** Public calendar: explicit allowlist, even for requests with a signed-in cookie.
 * Never expose booking data, closure reasons, internal notes, or personalized states.
 */
facilityRoutes.get('/facility/calendar', async (c) => {
  const q = query(c, z.object({ activity: zActivity.optional(), date: zDate }));
  const settings = await loadSettings(c.env.DB);
  const now = Date.now();
  const local = localNow(offsetMinutes(c.env.TZ_OFFSET_MINUTES), now);
  checkPlayerDate(q.date, local.date, settings.bookingWindowDays);
  const day = await dayAvailability(c.env, settings, { activity: q.activity ?? null, date: q.date },
    { staff: false, userId: null, membership: 'none' }, now);
  return c.json({
    now, today: local.date, lastDate: addDays(local.date, settings.bookingWindowDays),
    date: day.date, dateLabel: day.dateLabel, open: day.open, hours: day.hours,
    slotMinutes: day.slotMinutes, tzOffsetMinutes: offsetMinutes(c.env.TZ_OFFSET_MINUTES),
    resources: day.resources.map((r) => ({
      id: r.id, name: r.name, activity: r.activity, status: r.status,
      slots: r.slots.map((s) => ({ start: s.start, end: s.end, label: s.label, state: s.state })),
    })),
  });
});

/** One day of slots for an activity. No names, ids or amounts of other players. */
facilityRoutes.get('/availability', async (c) => {
  const user = requirePlayer(c);
  const q = query(c, z.object({ activity: zActivity, date: zDate }));
  const settings = await loadSettings(c.env.DB);
  const now = Date.now();
  const local = localNow(offsetMinutes(c.env.TZ_OFFSET_MINUTES), now);
  checkPlayerDate(q.date, local.date, settings.bookingWindowDays);
  const day = await dayAvailability(c.env, settings, { activity: q.activity, date: q.date }, { staff: false, userId: user.id, membership: user.membership }, now);
  return c.json({ ...day, activity: q.activity, rate: user.membership === 'member' ? 'member' : 'non_member' });
});

/** The bookable date strip for an activity. */
facilityRoutes.get('/availability/days', async (c) => {
  const user = requirePlayer(c);
  const q = query(c, z.object({ activity: zActivity }));
  const settings = await loadSettings(c.env.DB);
  return c.json(await daysSummary(c.env, settings, q.activity, { userId: user.id, membership: user.membership }));
});

/** Open times near the given ones: `start=1080`, or `starts=960,1080` for several. */
facilityRoutes.get('/availability/alternatives', async (c) => {
  const user = requirePlayer(c);
  const q = query(
    c,
    z
      .object({
        resourceId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/),
        date: zDate,
        start: z.coerce.number().int().min(0).max(1439).optional(),
        starts: z.string().regex(/^\d{1,4}(,\d{1,4}){0,95}$/, 'List start minutes like 960,1080').optional(),
      })
      .refine((v) => v.start != null || Boolean(v.starts), { message: 'Give start or starts.', path: ['starts'] }),
  );
  const starts = q.starts ? q.starts.split(',').map(Number).filter((n) => n <= 1439) : [q.start!];
  const settings = await loadSettings(c.env.DB);
  const now = Date.now();
  const local = localNow(offsetMinutes(c.env.TZ_OFFSET_MINUTES), now);
  checkPlayerDate(q.date, local.date, settings.bookingWindowDays);
  const input = { resourceId: q.resourceId, date: q.date, starts };
  return c.json({ alternatives: await alternativesFor(c.env, settings, { userId: user.id, membership: user.membership }, input, now) });
});
