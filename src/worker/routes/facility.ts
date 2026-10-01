import { Hono } from 'hono';
import * as z from 'zod';
import type { AppEnv, ResourceRow } from '../types';
import { alternativesFor, dayAvailability, daysSummary } from '../lib/availability';
import { requireUser } from '../lib/auth';
import { activityLabel, underMaintenance, type HoursRow } from '../lib/bookings';
import { notFound, unprocessable } from '../lib/errors';
import { publicSettings, loadSettings } from '../lib/settings';
import { addDays, dateLabel, daysBetween, hoursLabel, isValidDate, localNow, offsetMinutes, peso } from '../lib/time';
import { query, zActivity, zDate } from '../lib/validate';

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
    facility: { name: pub.facilityName, address: pub.facilityAddress },
    gcash: c.get('user') ? pub.gcash : null,
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
        status: maintenance ? 'maintenance' : 'active',
        maintenance: maintenance ? { note: r.maintenance_note, until: r.maintenance_until, untilLabel: r.maintenance_until ? dateLabel(r.maintenance_until) : null } : null,
        priceMember: r.price_member,
        priceNonMember: r.price_non_member,
      };
    }),
  });
});

/** The GCash QR image, for signed-in players on the payment screen. */
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

/** One day of slots for an activity. No names, ids or amounts of other players. */
facilityRoutes.get('/availability', async (c) => {
  const user = requireUser(c);
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
  const user = requireUser(c);
  const q = query(c, z.object({ activity: zActivity }));
  const settings = await loadSettings(c.env.DB);
  return c.json(await daysSummary(c.env, settings, q.activity, { userId: user.id, membership: user.membership }));
});

/** Free slots near a given one (the booking screen asks after a conflict). */
facilityRoutes.get('/availability/alternatives', async (c) => {
  const user = requireUser(c);
  const q = query(
    c,
    z.object({ resourceId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/), date: zDate, start: z.coerce.number().int().min(0).max(1439) }),
  );
  const settings = await loadSettings(c.env.DB);
  const now = Date.now();
  const local = localNow(offsetMinutes(c.env.TZ_OFFSET_MINUTES), now);
  checkPlayerDate(q.date, local.date, settings.bookingWindowDays);
  return c.json({ alternatives: await alternativesFor(c.env, settings, { userId: user.id, membership: user.membership }, q, now) });
});
