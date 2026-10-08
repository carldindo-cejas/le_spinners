import { Hono } from 'hono';
import { afterPage, pageRequest, pageResult } from '../lib/pagination';
import * as z from 'zod';
import type { AppEnv } from '../types';
import { audit, isStaff, requirePlayer, requireUser } from '../lib/auth';
import { playerUnreadChats } from '../lib/chat';
import { ApiError, notFound } from '../lib/errors';
import { lazyMaintenance } from '../lib/maintenance';
import { checkProofSignature, getProof } from '../lib/payments';
import { jsonBody, parse, query, zId } from '../lib/validate';

type NotificationRow = {
  id: string;
  type: string;
  title: string;
  body: string;
  link: string | null;
  booking_id: string | null;
  read_at: number | null;
  resolved_at: number | null;
  created_at: number;
};

export function notificationDTO(n: NotificationRow) {
  return {
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    link: n.link,
    bookingId: n.booking_id,
    read: n.read_at != null,
    resolved: n.resolved_at != null,
    createdAt: n.created_at,
  };
}

export const readSchema = z
  .object({ ids: z.array(zId).max(200).optional(), all: z.boolean().optional() })
  .refine((v) => v.all || (v.ids && v.ids.length > 0), { message: 'Pass ids or all: true.' });

// ── /api/notifications (player inbox) ──────────────────────────────────────

export const notificationRoutes = new Hono<AppEnv>();

notificationRoutes.get('/', async (c) => {
  const user = requirePlayer(c);
  const db = c.env.DB;
  const q = query(c,z.object({filter:z.enum(['all','bookings','messages']).default('all')}));
  const page = pageRequest(c.req.query(), `player-notifications:${user.id}:${q.filter}`, ['number','string']);
  const after = afterPage(page, ['created_at','id']);
  const group = q.filter === 'messages' ? " AND type='new_message'" : q.filter === 'bookings' ? " AND type!='new_message'" : '';
  const [list, count] = await db.batch([
    db
      .prepare(
        `SELECT id, type, title, body, link, booking_id, read_at, resolved_at, created_at
           FROM notifications WHERE audience = 'user' AND user_id = ?${group}${after.sql ? ` AND ${after.sql}` : ''} ORDER BY created_at DESC, id DESC LIMIT ?`,
      )
      .bind(user.id,...after.params,page.limit + 1),
    db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE audience = 'user' AND user_id = ? AND read_at IS NULL`).bind(user.id),
  ]);
  const rows = (list?.results ?? []) as NotificationRow[];
  const unread = ((count?.results ?? [])[0] as { n: number } | undefined)?.n ?? 0;
  const result = pageResult(rows,page,n => [n.created_at,n.id]);
  return c.json({ now: Date.now(), unread, page:result.page, notifications: result.rows.map(notificationDTO) });
});

notificationRoutes.post('/read', async (c) => {
  const user = requirePlayer(c);
  const body = await jsonBody(c, readSchema);
  const now = Date.now();
  if (body.all) {
    await c.env.DB.prepare(`UPDATE notifications SET read_at = ? WHERE audience = 'user' AND user_id = ? AND read_at IS NULL`).bind(now, user.id).run();
  } else {
    await c.env.DB.prepare(
      `UPDATE notifications SET read_at = ? WHERE audience = 'user' AND user_id = ? AND read_at IS NULL AND id IN (SELECT value FROM json_each(?))`,
    )
      .bind(now, user.id, JSON.stringify(body.ids))
      .run();
  }
  return c.json({ ok: true });
});

/** Small payload the app polls: unread counts and running holds (for the countdown banner). */
notificationRoutes.get('/badges', async (c) => {
  const user = requirePlayer(c);
  const now = Date.now();
  c.executionCtx.waitUntil(lazyMaintenance(c.env, now));
  const db = c.env.DB;
  const [count, holds] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS n FROM notifications WHERE audience = 'user' AND user_id = ? AND read_at IS NULL`).bind(user.id),
    db
      .prepare(
        `SELECT b.id, b.status, b.hold_expires_at, r.name AS resource_name
           FROM bookings b JOIN resources r ON r.id = b.resource_id
          WHERE b.user_id = ? AND b.status IN ('TEMPORARY', 'REJECTED') AND b.hold_expires_at > ?
          ORDER BY b.hold_expires_at`,
      )
      .bind(user.id, now),
  ]);
  const chats = await playerUnreadChats(db, user.id);
  const holdRows = (holds?.results ?? []) as { id: string; status: string; hold_expires_at: number; resource_name: string }[];
  return c.json({
    now,
    notifications: ((count?.results ?? [])[0] as { n: number } | undefined)?.n ?? 0,
    chats: [...chats.values()].reduce((a, b) => a + b, 0),
    holds: holdRows.map((h) => ({ id: h.id, status: h.status, holdExpiresAt: h.hold_expires_at, resourceName: h.resource_name })),
  });
});

// ── /api/files (private payment screenshots) ───────────────────────────────

export const fileRoutes = new Hono<AppEnv>();

/**
 * Serves a payment screenshot. Needs BOTH a fresh signed link and a session
 * belonging to the booking's player or to staff. Never cached.
 */
fileRoutes.get('/proofs/:id', async (c) => {
  const user = requireUser(c);
  const id = parse(zId, c.req.param('id'));
  const exp = Number(c.req.query('exp'));
  const sig = c.req.query('sig') ?? '';
  if (!(await checkProofSignature(c.env, id, exp, sig))) {
    throw new ApiError(403, 'LINK_EXPIRED', 'This image link has expired. Refresh the page to view it again.');
  }
  const proof = await getProof(c.env.DB, id);
  const staff = isStaff(user.role);
  if (!staff && proof.booking_user_id !== user.id) {
    c.executionCtx.waitUntil(audit(c, user.id, 'proof_access_denied', 'payment_proof', id));
    throw notFound('File not found.');
  }
  const obj = await c.env.PROOFS.get(proof.r2_key);
  if (!obj) throw notFound('File not found.');
  if (staff) c.executionCtx.waitUntil(audit(c, user.id, 'proof_viewed', 'payment_proof', id));
  return new Response(obj.body, {
    headers: {
      'Content-Type': proof.content_type,
      'Content-Disposition': 'inline',
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Referrer-Policy': 'no-referrer',
    },
  });
});
