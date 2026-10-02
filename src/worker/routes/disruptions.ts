import { Hono } from 'hono';
import * as z from 'zod';
import type { AppEnv } from '../types';
import { clientIp, enforceRateLimit, requireStaff } from '../lib/auth';
import {
  applyDisruption, applySchema, buildPlan, disruptionDetail, idempotencyKeySchema, listDisruptions, previewDTO, previewSchema, resolveItem,
} from '../lib/disruptions';
import { badRequest } from '../lib/errors';
import { jsonBody, parse, query, zId } from '../lib/validate';

/**
 * Operator cancellations and facility disruptions (REBOOKING.md §10). Mounted inside the
 * operations router, so it is served at /api/staff/* (staff + admin) and /api/admin/* (admin).
 * Admin-only choices (customer requests, no credit, earlier days) are checked in lib/disruptions.
 */
export const disruptionRoutes = new Hono<AppEnv>();

/** What a disruption would do. Writes nothing. */
disruptionRoutes.post('/disruptions/preview', async (c) => {
  const actor = requireStaff(c);
  const body = await jsonBody(c, previewSchema);
  await enforceRateLimit(c.env.DB, `disruption-preview:${actor.id}`, 120, 10 * 60_000);
  const plan = await buildPlan(c, actor, body, Date.now());
  return c.json({ preview: previewDTO(plan) });
});

/**
 * Applies a previewed disruption in one transaction. Needs the preview's token and an
 * Idempotency-Key header; a retry with the same key returns the first result (200).
 */
disruptionRoutes.post('/disruptions', async (c) => {
  const actor = requireStaff(c);
  const key = c.req.header('Idempotency-Key');
  if (!key) throw badRequest('Send an Idempotency-Key header with each confirmation.');
  const idempotencyKey = parse(idempotencyKeySchema, key);
  const body = await jsonBody(c, applySchema);
  const { id, replay } = await applyDisruption(c, actor, body, idempotencyKey, clientIp(c));
  return c.json({ replay, ...(await disruptionDetail(c.env.DB, id, Date.now())) }, replay ? 200 : 201);
});

disruptionRoutes.get('/disruptions', async (c) => {
  requireStaff(c);
  const q = query(c, z.object({ filter: z.enum(['open', 'all']).optional() }));
  return c.json({ now: Date.now(), disruptions: await listDisruptions(c.env.DB, q.filter ?? 'all') });
});

disruptionRoutes.get('/disruptions/:id', async (c) => {
  requireStaff(c);
  const id = parse(zId, c.req.param('id'));
  return c.json(await disruptionDetail(c.env.DB, id, Date.now()));
});

/** Finish one booking that was waiting for payment verification or changed while applying. */
disruptionRoutes.post('/disruptions/:id/items/:bookingId/apply', async (c) => {
  const actor = requireStaff(c);
  const id = parse(zId, c.req.param('id'));
  const bookingId = parse(zId, c.req.param('bookingId'));
  const result = await resolveItem(c, actor, id, bookingId, clientIp(c));
  return c.json({ result, ...(await disruptionDetail(c.env.DB, id, Date.now())) });
});
