import { Hono } from 'hono';
import { pageRequest, pageResult } from '../lib/pagination';
import * as z from 'zod';
import type { AppEnv } from '../types';
import { requireAdmin, requirePlayer, requireStaff } from '../lib/auth';
import {
  MAX_MANUAL_CREDIT, creditDTO, creditLedger, creditSummary, getCredit, issueManualCredit, listUserCredits, recordRefund, searchCredits, voidCredit,
} from '../lib/credits';
import { idempotencyKeySchema } from '../lib/disruptions';
import { badRequest, notFound, unprocessable } from '../lib/errors';
import { jsonBody, parse, query, zId } from '../lib/validate';

/** /api/credits — a player's own booking credits. Another player's credit answers 404. */
export const creditRoutes = new Hono<AppEnv>();

creditRoutes.get('/', async (c) => {
  const user = requirePlayer(c);
  const now = Date.now();
  const page = pageRequest(c.req.query(),`player-credits:${user.id}`,['number','string']);
  const [rows, summary] = await Promise.all([listUserCredits(c.env.DB, user.id, now, page), creditSummary(c.env.DB, user.id, now)]);
  const result = pageResult(rows,page,r => [r.created_at,r.id]);
  return c.json({ now, summary, page:result.page, credits: result.rows.map((r) => creditDTO(r, now)) });
});

creditRoutes.get('/:id', async (c) => {
  const user = requirePlayer(c);
  const id = parse(zId, c.req.param('id'));
  const now = Date.now();
  const credit = await getCredit(c.env.DB, id, now);
  if (credit.user_id !== user.id) throw notFound('Credit not found.');
  return c.json({ now, credit: creditDTO(credit, now), history: await creditLedger(c.env.DB, id, false) });
});

/** Staff and admins look credits up (mounted in the operations router: /api/staff/*, /api/admin/*). */
export const staffCreditRoutes = new Hono<AppEnv>();

staffCreditRoutes.get('/credits', async (c) => {
  const actor = requireStaff(c);
  const q = query(c, z.object({ q: z.string().trim().max(80).optional(), state: z.enum(['spendable', 'all']).optional() }));
  const now = Date.now();
  const page = pageRequest(c.req.query(),`console-credits:${actor.id}:${JSON.stringify(q)}`,['number','string']);
  const rows = await searchCredits(c.env.DB, { q: q.q || undefined, state: q.state ?? 'all' }, now, page);
  const result = pageResult(rows,page,r => [r.created_at,r.id]);
  return c.json({ now, page:result.page, credits: result.rows.map((r) => creditDTO(r, now, true)) });
});

staffCreditRoutes.get('/credits/:id', async (c) => {
  requireStaff(c);
  const id = parse(zId, c.req.param('id'));
  const now = Date.now();
  const credit = await getCredit(c.env.DB, id, now);
  return c.json({ now, credit: creditDTO(credit, now, true), history: await creditLedger(c.env.DB, id, true) });
});

/** /api/admin/credits — admins issue credits by hand, void them and record cash refunds. */
export const adminCreditRoutes = new Hono<AppEnv>();

const zMoney = z.number().int().min(100, 'At least ₱1.').max(MAX_MANUAL_CREDIT, 'At most ₱100,000.');
const zReason = z.string().trim().min(3, 'Give a reason the player will see.').max(120, 'Keep it under 120 characters.');

adminCreditRoutes.post('/', async (c) => {
  const admin = requireAdmin(c);
  const key = c.req.header('Idempotency-Key');
  if (!key) throw badRequest('Send an Idempotency-Key header.');
  const body = await jsonBody(c, z.strictObject({ userId: zId, amount: zMoney, reason: zReason, sourceBookingId: zId.nullable().default(null) }));
  const id = await issueManualCredit(c.env, admin, { ...body, idempotencyKey: parse(idempotencyKeySchema, key) });
  const now = Date.now();
  return c.json({ credit: creditDTO(await getCredit(c.env.DB, id, now), now, true), history: await creditLedger(c.env.DB, id, true) }, 201);
});

adminCreditRoutes.post('/:id/void', async (c) => {
  const admin = requireAdmin(c);
  const id = parse(zId, c.req.param('id'));
  const body = await jsonBody(c, z.strictObject({ reason: zReason }));
  await voidCredit(c.env, admin, id, body.reason);
  const now = Date.now();
  return c.json({ credit: creditDTO(await getCredit(c.env.DB, id, now), now, true), history: await creditLedger(c.env.DB, id, true) });
});

adminCreditRoutes.post('/:id/refund', async (c) => {
  const admin = requireAdmin(c);
  const id = parse(zId, c.req.param('id'));
  const key = c.req.header('Idempotency-Key');
  if (!key) throw badRequest('Send an Idempotency-Key header.');
  const idempotencyKey = parse(idempotencyKeySchema, key);
  const body = await jsonBody(
    c,
    z.strictObject({
      amount: zMoney,
      method: z.enum(['gcash', 'cash']),
      reference: z.string().trim().max(40).regex(/^[A-Za-z0-9 -]*$/, 'Use letters and numbers only.').nullable().default(null),
      note: z.string().trim().max(200).nullable().default(null),
    }),
  );
  if (body.method === 'gcash' && !body.reference) {
    throw unprocessable('VALIDATION_ERROR', 'Please check the highlighted fields.', { reference: ['Enter the GCash reference number of the refund.'] });
  }
  const refund = await recordRefund(c.env, admin, id, { amount: body.amount, method: body.method, reference: body.reference || null, note: body.note || null, idempotencyKey });
  const now = Date.now();
  // `refund` is the durable original result; credit/history are current read models.
  return c.json({ refund, credit: creditDTO(await getCredit(c.env.DB, id, now), now, true), history: await creditLedger(c.env.DB, id, true) });
});
