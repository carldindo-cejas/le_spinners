import { Hono } from 'hono';
import * as z from 'zod';
import type { AppEnv, ResourceRow } from '../types';
import { requireStaff } from '../lib/auth';
import { OCCUPYING, type ClosureRow, type HoursRow } from '../lib/bookings';
import {
  closureSchema, createClosure, createResource, deleteClosure, hoursSchema, resourceCreateSchema, resourceDTO, resourceUpdateSchema,
  setWeeklyHours, updateResource,
} from '../lib/facility';
import { loadSettings } from '../lib/settings';
import { dateLabel, hoursLabel, localNow, minutesLabel, offsetMinutes } from '../lib/time';
import { jsonBody, parse, zId } from '../lib/validate';

/**
 * Courts/tables, weekly hours and closures. Mounted inside the operations router,
 * so it is served at /api/staff/* (staff + admin) and /api/admin/* (admin only).
 * Prices stay admin-only (see lib/facility.ts).
 */
export const facilityAdminRoutes = new Hono<AppEnv>();

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

facilityAdminRoutes.get('/facilities', async (c) => {
  requireStaff(c);
  const db = c.env.DB;
  const now = Date.now();
  const local = localNow(offsetMinutes(c.env.TZ_OFFSET_MINUTES), now);
  const { results } = await db
    .prepare(
      `SELECT r.*, (SELECT COUNT(*) FROM bookings b
                     WHERE b.resource_id = r.id AND ${OCCUPYING('b', '?1')} AND (b.date > ?2 OR (b.date = ?2 AND b.end_min > ?3))) AS upcoming
         FROM resources r ORDER BY r.activity, r.sort_order, r.name`,
    )
    .bind(now, local.date, local.minutes)
    .all<ResourceRow & { upcoming: number }>();
  return c.json({ today: local.date, resources: results.map(resourceDTO) });
});

facilityAdminRoutes.post('/facilities', async (c) => {
  const actor = requireStaff(c);
  const body = await jsonBody(c, resourceCreateSchema);
  return c.json({ resource: await createResource(c, actor, body) }, 201);
});

facilityAdminRoutes.patch('/facilities/:id', async (c) => {
  const actor = requireStaff(c);
  const id = parse(zId, c.req.param('id'));
  const body = await jsonBody(c, resourceUpdateSchema);
  return c.json(await updateResource(c, actor, id, body));
});

type ClosureListRow = ClosureRow & { resource_name: string | null; created_by_name: string | null; created_at: number };

facilityAdminRoutes.get('/availability', async (c) => {
  requireStaff(c);
  const db = c.env.DB;
  const settings = await loadSettings(db);
  const local = localNow(offsetMinutes(c.env.TZ_OFFSET_MINUTES));
  const [hours, closures, resources] = await db.batch([
    db.prepare('SELECT * FROM opening_hours ORDER BY weekday'),
    db
      .prepare(
        `SELECT cl.*, r.name AS resource_name, u.name AS created_by_name
           FROM closures cl LEFT JOIN resources r ON r.id = cl.resource_id LEFT JOIN users u ON u.id = cl.created_by
          WHERE cl.date >= ? ORDER BY cl.date, cl.start_min LIMIT 200`,
      )
      .bind(local.date),
    db.prepare(`SELECT id, name, activity, status FROM resources WHERE status != 'disabled' ORDER BY activity, sort_order, name`),
  ]);
  const byDay = new Map(((hours?.results ?? []) as HoursRow[]).map((h) => [h.weekday, h]));
  return c.json({
    today: local.date,
    slotMinutes: settings.slotMinutes,
    hours: WEEKDAY_NAMES.map((name, weekday) => {
      const h = byDay.get(weekday);
      const isOpen = Boolean(h?.is_open);
      return { weekday, name, isOpen, open: h?.open_min ?? 960, close: h?.close_min ?? 1320, label: h && isOpen ? hoursLabel(h.open_min, h.close_min) : 'Closed' };
    }),
    closures: ((closures?.results ?? []) as ClosureListRow[]).map((cl) => ({
      id: cl.id,
      date: cl.date,
      dateLabel: dateLabel(cl.date),
      resourceId: cl.resource_id,
      resourceName: cl.resource_name,
      start: cl.start_min,
      end: cl.end_min,
      timeLabel: cl.start_min == null || cl.end_min == null ? 'All day' : `${minutesLabel(cl.start_min)} – ${minutesLabel(cl.end_min)}`,
      reason: cl.reason,
      createdBy: cl.created_by_name,
      createdAt: cl.created_at,
    })),
    resources: (resources?.results ?? []) as Pick<ResourceRow, 'id' | 'name' | 'activity' | 'status'>[],
  });
});

facilityAdminRoutes.put('/availability/hours/:weekday', async (c) => {
  const actor = requireStaff(c);
  const weekday = parse(z.coerce.number().int().min(0).max(6), c.req.param('weekday'));
  const body = await jsonBody(c, hoursSchema);
  const settings = await loadSettings(c.env.DB);
  return c.json(await setWeeklyHours(c, actor, weekday, settings.slotMinutes, body));
});

facilityAdminRoutes.post('/availability/closures', async (c) => {
  const actor = requireStaff(c);
  const body = await jsonBody(c, closureSchema);
  return c.json(await createClosure(c, actor, body), 201);
});

facilityAdminRoutes.delete('/availability/closures/:id', async (c) => {
  const actor = requireStaff(c);
  await deleteClosure(c, actor, parse(zId, c.req.param('id')));
  return c.json({ ok: true });
});