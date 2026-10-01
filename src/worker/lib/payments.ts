import type { Bindings, ProofRow, SessionUser } from '../types';
import { ApiError, conflict, notFound, unprocessable } from './errors';
import { newId, signValue, verifySignature } from './crypto';
import { MAX_UPLOAD_BYTES, sniffImage, stripMetadata } from './images';
import { outboxStmt, resolveStaffStmt, staffNoticeStmt, userNoticeStmt } from './notify';
import type { Settings } from './settings';
import { dateLabel, minutesLabel, peso } from './time';
import { activityLabel, changedAt, effectiveStatus, eventStmt, getBooking, slotLabel, systemMessageStmt, type BookingJoin } from './bookings';

/**
 * Proof links are signed for a 5-minute bucket and stay valid for 5–10 minutes.
 * Bucketing keeps the URL stable between polls, so an open chat or review
 * screen doesn't re-download the screenshot every few seconds.
 */
export const PROOF_LINK_BUCKET_MS = 5 * 60_000;

function amountMatches(b: BookingJoin, claimed: number | null): 'match' | 'differs' | 'unknown' {
  if (claimed == null) return 'unknown';
  return claimed === b.amount_due ? 'match' : 'differs';
}

/** Player uploads a GCash screenshot for a running hold (or during a resubmit window). */
export async function submitProof(
  env: Bindings,
  settings: Settings,
  user: SessionUser,
  bookingId: string,
  file: File,
  fields: { gcashRef: string | null; amount: number | null },
  now = Date.now(),
) {
  const db = env.DB;
  const b = await getBooking(db, bookingId);
  if (b.user_id !== user.id) throw notFound('Booking not found.');
  const status = effectiveStatus(b, now);
  if (status === 'PAYMENT_SUBMITTED') throw conflict('ALREADY_SUBMITTED', 'Payment proof was already submitted for this booking.');
  if (status === 'EXPIRED') throw conflict('HOLD_EXPIRED', 'Your temporary reservation expired before the proof arrived, so the slot was released.');
  if (status !== 'TEMPORARY' && status !== 'REJECTED') throw conflict('INVALID_STATUS', 'This booking is not waiting for payment.');

  if (file.size > MAX_UPLOAD_BYTES) {
    throw new ApiError(413, 'FILE_TOO_LARGE', 'This image is too large. The limit is 10 MB — a screenshot is usually well under that.');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length === 0) throw unprocessable('EMPTY_FILE', 'That file is empty. Choose your GCash screenshot again.');
  const kind = sniffImage(bytes);
  if (!kind) throw unprocessable('UNSUPPORTED_FILE_TYPE', "That file type isn't supported. Upload a JPG, PNG or WEBP screenshot.");
  const clean = stripMetadata(bytes, kind);

  const proofId = newId('p_');
  const key = `proofs/${bookingId}/${proofId}.${kind.ext}`;
  await env.PROOFS.put(key, clean, {
    httpMetadata: { contentType: kind.type },
    customMetadata: { bookingId, userId: user.id },
  });

  const g = changedAt(bookingId, 'submitted_at', now);
  const where = `${b.resource_name} · ${dateLabel(b.date)} · ${slotLabel(b)}`;
  const match = amountMatches(b, fields.amount);
  const resubmitted = b.status === 'REJECTED';
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE bookings SET status = 'PAYMENT_SUBMITTED', submitted_at = ?1, hold_expires_at = NULL, updated_at = ?1
          WHERE id = ?2 AND user_id = ?3 AND status IN ('TEMPORARY', 'REJECTED') AND hold_expires_at > ?1`,
      )
      .bind(now, bookingId, user.id),
    db
      .prepare(
        `INSERT INTO payment_proofs (id, booking_id, user_id, r2_key, content_type, size, original_name, gcash_ref, amount_claimed, status, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ? WHERE ${g.sql}`,
      )
      .bind(proofId, bookingId, user.id, key, kind.type, clean.length, (file.name || '').slice(0, 120) || null, fields.gcashRef, fields.amount, now, ...g.params),
    eventStmt(db, bookingId, 'proof_submitted', user.id, 'player', resubmitted ? 'New proof after rejection' : null, now, g),
    db
      .prepare(
        `INSERT INTO messages (id, booking_id, sender_id, sender_role, kind, body, proof_id, created_at)
         SELECT ?, ?, ?, 'player', 'proof', 'Payment screenshot', ?, ? WHERE ${g.sql}`,
      )
      .bind(newId('m_'), bookingId, user.id, proofId, now, ...g.params),
    systemMessageStmt(db, bookingId, 'Payment proof submitted', now, g),
    userNoticeStmt(db, user.id, {
      type: 'proof_submitted',
      title: 'Payment proof submitted',
      body: `Waiting for admin verification · ${where}`,
      link: `/bookings/${bookingId}`,
      bookingId,
    }, now, g),
    resolveStaffStmt(db, bookingId, ['new_booking', 'hold_expiring', 'proof_submitted'], now, g),
    staffNoticeStmt(db, {
      type: 'proof_submitted',
      title: `${user.name} sent payment proof`,
      body: `${activityLabel(b.activity)} · ${where} · ${peso(b.amount_due)}${match === 'differs' ? ` due, ${peso(fields.amount ?? 0)} entered` : ''}`,
      link: `/admin/verify/${bookingId}`,
      bookingId,
    }, now, g),
  ];

  const emailBody = [
    'A player submitted payment proof. Please verify it.',
    '',
    `Customer: ${user.name} (${user.membership === 'member' ? 'Member' : 'Non-member'})`,
    `Activity: ${activityLabel(b.activity)}`,
    `Resource: ${b.resource_name}`,
    `Date: ${dateLabel(b.date)}`,
    `Time: ${slotLabel(b)}`,
    `Amount due: ${peso(b.amount_due)}`,
    `Amount entered: ${fields.amount != null ? peso(fields.amount) : 'not entered'}${match === 'differs' ? ' (DIFFERS)' : ''}`,
    `GCash reference: ${fields.gcashRef ?? 'not entered'}`,
    `Booking: ${b.ref}`,
    '',
    `Review Booking: ${env.APP_ORIGIN}/admin/verify/${bookingId}`,
    '',
    'The screenshot is only visible inside the staff console.',
  ].join('\n');
  for (const email of settings.staffAlertEmails) {
    stmts.push(outboxStmt(db, 'email', email, 'Le Spinners — Booking Requires Payment Verification', emailBody, bookingId, now, g));
  }
  const sms = `Le Spinners: payment proof for ${b.ref} (${b.resource_name}, ${dateLabel(b.date)} ${minutesLabel(b.start_min)}) needs verification. ${env.APP_ORIGIN}/admin/verify/${bookingId}`;
  for (const phone of settings.staffAlertSms) {
    stmts.push(outboxStmt(db, 'sms', phone, null, sms, bookingId, now, g));
  }

  const [update] = await db.batch(stmts);
  if (!update?.meta.changes) {
    await env.PROOFS.delete(key);
    throw conflict('HOLD_EXPIRED', 'Your temporary reservation expired before the proof arrived, so the slot was released.');
  }
  return getBooking(db, bookingId);
}

/** Staff approve a submitted proof → CONFIRMED. */
export async function approvePayment(env: Bindings, staff: SessionUser, bookingId: string, now = Date.now(), chatMessage: string | null = null) {
  const db = env.DB;
  const b = await getBooking(db, bookingId);
  const g = changedAt(bookingId, 'confirmed_at', now);
  const where = `${b.resource_name} · ${dateLabel(b.date)} · ${slotLabel(b)}`;
  const extra: D1PreparedStatement[] = chatMessage
    ? [
        db
          .prepare(
            `INSERT INTO messages (id, booking_id, sender_id, sender_role, kind, body, created_at)
             SELECT ?, ?, ?, 'staff', 'text', ?, ? WHERE ${g.sql}`,
          )
          .bind(newId('m_'), bookingId, staff.id, chatMessage.slice(0, 1000), now + 1, ...g.params),
      ]
    : [];
  const [update] = await db.batch([
    db
      .prepare(`UPDATE bookings SET status = 'CONFIRMED', confirmed_at = ?1, confirmed_by = ?2, updated_at = ?1 WHERE id = ?3 AND status = 'PAYMENT_SUBMITTED'`)
      .bind(now, staff.id, bookingId),
    db
      .prepare(`UPDATE payment_proofs SET status = 'approved' WHERE booking_id = ? AND status = 'submitted' AND ${g.sql}`)
      .bind(bookingId, ...g.params),
    eventStmt(db, bookingId, 'approved', staff.id, 'staff', null, now, g),
    systemMessageStmt(db, bookingId, 'Payment verified · booking confirmed', now, g),
    ...extra,
    userNoticeStmt(db, b.user_id, { type: 'payment_verified', title: 'Payment verified', body: `Booking confirmed · ${where}`, link: `/bookings/${bookingId}`, bookingId }, now, g),
    resolveStaffStmt(db, bookingId, ['proof_submitted', 'new_booking', 'hold_expiring'], now, g),
    outboxStmt(db, 'email', b.user_email ?? '', 'Le Spinners — Booking confirmed',
      `Hi ${b.user_name},\n\nPayment verified. Your booking is confirmed.\n\n${activityLabel(b.activity)} · ${where}\nReference: ${b.ref}\nAmount: ${peso(b.amount_due)}\n\nView your ticket: ${env.APP_ORIGIN}/bookings/${bookingId}\n\nSee you on court!\nLe Spinners Recreational Hub`,
      bookingId, now, g),
  ]);
  if (!update?.meta.changes) throw conflict('INVALID_STATUS', 'This booking is no longer waiting for verification. Someone may have handled it already.');
}

/** Staff reject a submitted proof. With keepHold the player gets a resubmit window. */
export async function rejectPayment(
  env: Bindings,
  settings: Settings,
  staff: SessionUser,
  bookingId: string,
  input: { reason: string; message: string | null; keepHold: boolean },
  now = Date.now(),
) {
  const db = env.DB;
  const b = await getBooking(db, bookingId);
  const g = changedAt(bookingId, 'rejected_at', now);
  const holdUntil = input.keepHold ? now + settings.resubmitMinutes * 60_000 : null;
  const nextStatus = input.keepHold ? 'REJECTED' : 'EXPIRED';
  const where = `${b.resource_name} · ${dateLabel(b.date)} · ${slotLabel(b)}`;
  const chatText = input.message?.trim() ||
    `${input.reason}${input.keepHold ? ` Please send a new screenshot within ${settings.resubmitMinutes} minutes.` : ''}`;
  const [update] = await db.batch([
    db
      .prepare(
        `UPDATE bookings SET status = ?1, rejected_at = ?2, rejected_by = ?3, reject_reason = ?4, hold_expires_at = ?5, warned_at = NULL, updated_at = ?2
          WHERE id = ?6 AND status = 'PAYMENT_SUBMITTED'`,
      )
      .bind(nextStatus, now, staff.id, input.reason, holdUntil, bookingId),
    db
      .prepare(`UPDATE payment_proofs SET status = 'rejected' WHERE booking_id = ? AND status = 'submitted' AND ${g.sql}`)
      .bind(bookingId, ...g.params),
    eventStmt(db, bookingId, 'rejected', staff.id, 'staff', input.reason, now, g),
    db
      .prepare(
        `INSERT INTO messages (id, booking_id, sender_id, sender_role, kind, body, created_at)
         SELECT ?, ?, ?, 'staff', 'text', ?, ? WHERE ${g.sql}`,
      )
      .bind(newId('m_'), bookingId, staff.id, chatText.slice(0, 1000), now, ...g.params),
    systemMessageStmt(db, bookingId, input.keepHold ? `Payment proof rejected · ${settings.resubmitMinutes} minutes to send new proof` : 'Payment proof rejected · slot released', now, g),
    userNoticeStmt(db, b.user_id, {
      type: 'proof_rejected',
      title: 'Payment proof rejected',
      body: `${input.reason}${input.keepHold ? ` · send new proof within ${settings.resubmitMinutes} minutes` : ' · the slot was released'}`,
      link: `/bookings/${bookingId}`,
      bookingId,
    }, now, g),
    resolveStaffStmt(db, bookingId, ['proof_submitted', 'new_booking', 'hold_expiring'], now, g),
    outboxStmt(db, 'email', b.user_email ?? '', 'Le Spinners — Payment proof rejected',
      `Hi ${b.user_name},\n\nWe couldn't verify your payment for ${where} (${b.ref}).\n\nReason: ${input.reason}\n\n${input.keepHold ? `Your slot is held for ${settings.resubmitMinutes} more minutes. Send a new screenshot here: ${env.APP_ORIGIN}/bookings/${bookingId}` : 'The slot was released. You can book again anytime.'}\n\nLe Spinners Recreational Hub`,
      bookingId, now, g),
  ]);
  if (!update?.meta.changes) throw conflict('INVALID_STATUS', 'This booking is no longer waiting for verification. Someone may have handled it already.');
}

/** Staff cancel any active booking with a reason. */
export async function staffCancel(env: Bindings, staff: SessionUser, bookingId: string, reason: string, now = Date.now()) {
  const db = env.DB;
  const b = await getBooking(db, bookingId);
  const g = changedAt(bookingId, 'cancelled_at', now);
  const where = `${b.resource_name} · ${dateLabel(b.date)} · ${slotLabel(b)}`;
  const [update] = await db.batch([
    db
      .prepare(
        `UPDATE bookings SET status = 'CANCELLED', cancelled_at = ?1, cancelled_by = ?2, cancel_reason = ?3, hold_expires_at = NULL, updated_at = ?1
          WHERE id = ?4 AND status IN ('TEMPORARY', 'REJECTED')`,
      )
      .bind(now, staff.id, reason, bookingId),
    eventStmt(db, bookingId, 'cancelled', staff.id, 'staff', reason, now, g),
    systemMessageStmt(db, bookingId, `Booking cancelled by staff · ${reason}`, now, g),
    userNoticeStmt(db, b.user_id, { type: 'booking_cancelled', title: 'Booking cancelled by Le Spinners', body: `${where} · ${reason}`, link: `/bookings/${bookingId}`, bookingId }, now, g),
    resolveStaffStmt(db, bookingId, ['proof_submitted', 'new_booking', 'hold_expiring', 'booking_cancelled'], now, g),
    outboxStmt(db, 'email', b.user_email ?? '', 'Le Spinners — Booking cancelled',
      `Hi ${b.user_name},\n\nYour booking ${b.ref} (${where}) was cancelled by Le Spinners.\nReason: ${reason}\n\nQuestions? Reply in the booking chat: ${env.APP_ORIGIN}/bookings/${bookingId}/chat\n\nLe Spinners Recreational Hub`,
      bookingId, now, g),
  ]);
  if (!update?.meta.changes) throw conflict('NOT_CANCELLABLE', 'Only unpaid holds can be cancelled. Bookings with a submitted payment or a confirmation stay as they are.');
}

// ── Private proof images ───────────────────────────────────────────────────

export async function proofLink(env: Bindings, proofId: string, now = Date.now()) {
  const exp = (Math.floor(now / PROOF_LINK_BUCKET_MS) + 2) * PROOF_LINK_BUCKET_MS;
  const sig = await signValue(env.FILE_SIGNING_SECRET, `proof:${proofId}:${exp}`);
  return { url: `/api/files/proofs/${encodeURIComponent(proofId)}?exp=${exp}&sig=${sig}`, expiresAt: exp };
}

export async function checkProofSignature(env: Bindings, proofId: string, exp: number, sig: string, now = Date.now()) {
  if (!Number.isInteger(exp) || exp < now || exp > now + 2 * PROOF_LINK_BUCKET_MS + 60_000) return false;
  if (!sig || sig.length > 100) return false;
  return verifySignature(env.FILE_SIGNING_SECRET, `proof:${proofId}:${exp}`, sig);
}

export async function getProof(db: D1Database, proofId: string): Promise<ProofRow & { booking_user_id: string }> {
  const row = await db
    .prepare('SELECT p.*, b.user_id AS booking_user_id FROM payment_proofs p JOIN bookings b ON b.id = p.booking_id WHERE p.id = ?')
    .bind(proofId)
    .first<ProofRow & { booking_user_id: string }>();
  if (!row) throw notFound('File not found.');
  return row;
}

export async function listProofs(env: Bindings, bookingId: string) {
  const { results } = await env.DB.prepare(
    'SELECT id, content_type, size, original_name, gcash_ref, amount_claimed, status, created_at FROM payment_proofs WHERE booking_id = ? ORDER BY created_at DESC',
  )
    .bind(bookingId)
    .all<Omit<ProofRow, 'booking_id' | 'user_id' | 'r2_key'>>();
  return results.map((p) => ({
    id: p.id,
    contentType: p.content_type,
    size: p.size,
    fileName: p.original_name,
    gcashRef: p.gcash_ref,
    amountClaimed: p.amount_claimed,
    status: p.status,
    createdAt: p.created_at,
  }));
}
