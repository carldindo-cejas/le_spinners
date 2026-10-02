import { Hono } from 'hono';
import * as z from 'zod';
import type { AppContext, AppEnv, SessionUser } from '../types';
import { alternativesFor } from '../lib/availability';
import { enforceRateLimit, requirePlayer } from '../lib/auth';
import {
  BOOKING_SELECT, bookingDTO, cancelByPlayer, createHold, creditQuote, PICK_A_TIME, hasSlotPick, listEvents, releaseHold, requestedStarts, zSlotPick,
  type BookingJoin,
} from '../lib/bookings';
import { MESSAGE_MAX_CHARS, listMessages, markRead, playerUnreadChats, postMessage } from '../lib/chat';
import { creditSummary } from '../lib/credits';
import { bookingCreditInfo } from '../lib/disruptions';
import { ApiError, badRequest, conflict, notFound, unprocessable } from '../lib/errors';
import { listProofs, proofLink, submitProof } from '../lib/payments';
import { loadSettings, publicSettings } from '../lib/settings';
import { offsetMinutes, peso } from '../lib/time';
import { jsonBody, parse, query, zDate, zId } from '../lib/validate';

const MINUTE = 60_000;

export const bookingRoutes = new Hono<AppEnv>();

/** The player's own booking, or 404 — never reveals that someone else's booking exists. */
async function ownBooking(c: AppContext, user: SessionUser): Promise<BookingJoin> {
  const id = parse(zId, c.req.param('id'));
  const b = await c.env.DB.prepare(`${BOOKING_SELECT} WHERE b.id = ? AND b.user_id = ?`).bind(id, user.id).first<BookingJoin>();
  if (!b) throw notFound('Booking not found.');
  return b;
}

async function playerDetail(c: AppContext, b: BookingJoin, now: number) {
  const settings = await loadSettings(c.env.DB);
  const offset = offsetMinutes(c.env.TZ_OFFSET_MINUTES);
  const booking = bookingDTO(b, now, settings, offset);
  const [proofs, timeline, unread, last, credit] = await Promise.all([
    listProofs(c.env, b.id),
    listEvents(c.env.DB, b.id, false),
    playerUnreadChats(c.env.DB, b.user_id),
    c.env.DB.prepare(
      `SELECT m.body, m.kind, m.sender_role, m.created_at, u.name AS sender_name
         FROM messages m LEFT JOIN users u ON u.id = m.sender_id
        WHERE m.booking_id = ? AND m.kind != 'system'
        ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1`,
    )
      .bind(b.id)
      .first<{ body: string; kind: string; sender_role: string; created_at: number; sender_name: string | null }>(),
    bookingCreditInfo(c.env.DB, b.id, false),
  ]);
  const withLinks = await Promise.all(proofs.map(async (p) => ({ ...p, ...(await proofLink(c.env, p.id, now)) })));
  const pub = publicSettings(settings);
  return {
    now,
    booking,
    proofs: withLinks,
    timeline,
    /** What Le Spinners' disruptions did to this booking, and the booking credit it used or produced. */
    credit,
    unreadMessages: unread.get(b.id) ?? 0,
    lastMessage: last
      ? {
          body: last.kind === 'proof' ? 'Payment screenshot' : last.body,
          kind: last.kind,
          sender: last.sender_role,
          senderName: last.sender_role === 'staff' ? `${(last.sender_name ?? '').split(' ')[0] || 'Staff'} · Le Spinners` : 'You',
          at: last.created_at,
        }
      : null,
    payment: booking.canSubmitProof
      ? { gcashName: pub.gcash.name, gcashNumber: pub.gcash.number, hasQr: pub.gcash.hasQr, qrUrl: pub.gcash.hasQr ? '/api/facility/gcash-qr' : null, maxUploadMb: pub.rules.maxUploadMb }
      : null,
  };
}

bookingRoutes.get('/', async (c) => {
  const user = requirePlayer(c);
  const now = Date.now();
  const settings = await loadSettings(c.env.DB);
  const offset = offsetMinutes(c.env.TZ_OFFSET_MINUTES);
  const [{ results }, unread, credits] = await Promise.all([
    c.env.DB.prepare(`${BOOKING_SELECT} WHERE b.user_id = ? ORDER BY b.date DESC, b.start_min DESC LIMIT 200`).bind(user.id).all<BookingJoin>(),
    playerUnreadChats(c.env.DB, user.id),
    creditSummary(c.env.DB, user.id, now),
  ]);
  return c.json({
    now,
    /** Booking credit the player can spend now. */
    credits,
    bookings: results.map((b) => ({ ...bookingDTO(b, now, settings, offset), unreadMessages: unread.get(b.id) ?? 0 })),
  });
});

/**
 * Any number of slots on one court or table on one day, gaps allowed; the price is per slot.
 * `useCredit` pays with booking credit first; `expectedCredit` is the credit the app showed (a
 * mismatch answers 409 CREDIT_CHANGED). Amounts always come from the server.
 */
const holdSchema = z
  .object({
    resourceId: zId,
    date: zDate,
    ...zSlotPick,
    useCredit: z.boolean().optional(),
    expectedCredit: z.number().int().min(0).nullable().optional(),
  })
  .refine(hasSlotPick, PICK_A_TIME);

/** The price of some slots and how much of it the player's booking credit would pay. Holds nothing. */
bookingRoutes.get('/quote', async (c) => {
  const user = requirePlayer(c);
  const q = query(
    c,
    z.object({
      resourceId: zId,
      starts: z.string().regex(/^\d{1,4}(,\d{1,4}){0,95}$/, 'List start minutes like 960,1080'),
    }),
  );
  const resource = await c.env.DB.prepare('SELECT price_member, price_non_member FROM resources WHERE id = ?')
    .bind(q.resourceId)
    .first<{ price_member: number; price_non_member: number }>();
  if (!resource) throw notFound('Court or table not found.');
  const slots = new Set(q.starts.split(',').map(Number)).size;
  const price = (user.membership === 'member' ? resource.price_member : resource.price_non_member) * slots;
  const quote = await creditQuote(c.env.DB, user.id, price, Date.now());
  return c.json({
    price: quote.price,
    priceLabel: peso(quote.price),
    creditApplied: quote.creditApplied,
    creditAppliedLabel: peso(quote.creditApplied),
    amountDue: quote.amountDue,
    amountDueLabel: peso(quote.amountDue),
  });
});

/** Reserve & pay: creates a TEMPORARY booking that holds the chosen slots (or a CONFIRMED one paid by credit). */
bookingRoutes.post('/', async (c) => {
  const user = requirePlayer(c);
  const body = await jsonBody(c, holdSchema);
  await enforceRateLimit(c.env.DB, `hold:user:${user.id}`, 20, 60 * MINUTE);
  const settings = await loadSettings(c.env.DB);
  const input = { resourceId: body.resourceId, date: body.date, starts: requestedStarts(body, settings.slotMinutes) };
  const now = Date.now();
  try {
    const b = await createHold(c.env, settings, user, { ...input, useCredit: body.useCredit ?? false, expectedCredit: body.expectedCredit ?? null }, now);
    return c.json(await playerDetail(c, b, now), 201);
  } catch (err) {
    if (err instanceof ApiError && err.code === 'SLOT_TAKEN') {
      const alternatives = await alternativesFor(c.env, settings, { userId: user.id, membership: user.membership }, input, now).catch(() => []);
      throw conflict('SLOT_TAKEN', err.message, { alternatives });
    }
    throw err;
  }
});

bookingRoutes.get('/:id', async (c) => {
  const user = requirePlayer(c);
  const b = await ownBooking(c, user);
  return c.json(await playerDetail(c, b, Date.now()));
});

/** Parses "500", "500.00", "₱1,000" into centavos. Empty → null. */
function parseAmountPesos(raw: File | string | null): number | null {
  if (raw == null || typeof raw !== 'string') return null;
  const cleaned = raw.replace(/[₱,\s]/g, '').replace(/^PHP/i, '');
  if (!cleaned) return null;
  const m = /^(\d{1,6})(?:\.(\d{1,2}))?$/.exec(cleaned);
  if (!m) throw unprocessable('VALIDATION_ERROR', 'Please check the highlighted fields.', { amountPesos: ['Enter the amount you paid, like 500 or 500.00.'] });
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
}

const zGcashRef = z
  .string()
  .trim()
  .max(40, 'Use at most 40 characters.')
  .regex(/^[A-Za-z0-9 -]*$/, 'Use letters and numbers only.')
  .transform((v) => v.replace(/\s+/g, ' ') || null);

/** Upload a GCash screenshot (multipart: file, gcashRef?, amountPesos?). */
bookingRoutes.post('/:id/proof', async (c) => {
  const user = requirePlayer(c);
  const b = await ownBooking(c, user);
  await enforceRateLimit(c.env.DB, `proof:user:${user.id}`, 12, 10 * MINUTE);
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    throw badRequest('Send the screenshot as a file upload.');
  }
  const file = form.get('file');
  if (!(file instanceof File)) throw unprocessable('FILE_REQUIRED', 'Choose your GCash screenshot to upload.', { file: ['Choose a screenshot.'] });
  const refRaw = form.get('gcashRef');
  const gcashRef = parse(zGcashRef, typeof refRaw === 'string' ? refRaw : '');
  const amount = parseAmountPesos(form.get('amountPesos'));
  const settings = await loadSettings(c.env.DB);
  const now = Date.now();
  const updated = await submitProof(c.env, settings, user, b.id, file, { gcashRef, amount }, now);
  return c.json(await playerDetail(c, updated, now), 201);
});

/** Give up an unpaid hold so others can book the slot. */
bookingRoutes.post('/:id/release', async (c) => {
  const user = requirePlayer(c);
  const b = await ownBooking(c, user);
  const now = Date.now();
  await releaseHold(c.env, user, b.id, now);
  return c.json(await playerDetail(c, await ownBooking(c, user), now));
});

/** Booked and paid bookings can't be cancelled; this always answers 409 NOT_CANCELLABLE. */
bookingRoutes.post('/:id/cancel', async (c) => {
  const user = requirePlayer(c);
  const b = await ownBooking(c, user);
  return cancelByPlayer(c.env, user, b.id);
});

// ── Booking chat (player side) ─────────────────────────────────────────────

bookingRoutes.get('/:id/messages', async (c) => {
  const user = requirePlayer(c);
  const b = await ownBooking(c, user);
  const now = Date.now();
  const messages = await listMessages(c.env, b.id, { side: 'player', userId: user.id }, now);
  c.executionCtx.waitUntil(markRead(c.env, b.id, 'player', user.id, now).catch((err) => console.error('markRead failed', err)));
  const settings = await loadSettings(c.env.DB);
  return c.json({ now, booking: bookingDTO(b, now, settings, offsetMinutes(c.env.TZ_OFFSET_MINUTES)), messages });
});

bookingRoutes.post('/:id/messages', async (c) => {
  const user = requirePlayer(c);
  const b = await ownBooking(c, user);
  const body = await jsonBody(
    c,
    z.object({ body: z.string().trim().min(1, 'Write a message first.').max(MESSAGE_MAX_CHARS, `Keep messages under ${MESSAGE_MAX_CHARS} characters.`) }),
  );
  await enforceRateLimit(c.env.DB, `message:user:${user.id}`, 30, 5 * MINUTE);
  const now = Date.now();
  await postMessage(c.env, user, 'player', b, body.body, now);
  return c.json({ now, messages: await listMessages(c.env, b.id, { side: 'player', userId: user.id }, now) }, 201);
});
