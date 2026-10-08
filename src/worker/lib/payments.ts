import type { Bindings, ProofRow, SessionUser } from '../types';
import { ApiError, conflict, notFound, unprocessable } from './errors';
import { newId, signValue, verifySignature } from './crypto';
import { MAX_UPLOAD_BYTES, sniffImage, stripMetadata } from './images';
import { outboxStmt, resolveStaffStmt, staffNoticeStmt, userNoticeStmt } from './notify';
import type { Settings } from './settings';
import { dateLabel, minutesLabel, peso } from './time';
import { activityLabel, bookingTransition, effectiveStatus, eventStmt, getBooking, slotLabel, systemMessageStmt, type BookingJoin } from './bookings';
import { releaseStmts } from './credits';
import { attachUploadStmt, beginUpload, markUploadStored, recoverUploadFailure } from './storage';
import { selectedPaymentMethod } from './payment-methods';
import { authorizedBatch } from './authorized-mutations';

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

/** Reconcile a lost D1 response using this decision's unique committed token. */
async function paymentDecisionBatch(db: D1Database, staff: SessionUser, bookingId: string, transitionId: string, statements: D1PreparedStatement[]): Promise<boolean> {
  try {
    const [update] = await authorizedBatch(db, staff, statements);
    return Boolean(update?.meta.changes);
  } catch (error) {
    if (error instanceof ApiError) throw error;
    try {
      const committed = await db.prepare('SELECT 1 FROM bookings WHERE id = ? AND transition_id = ?').bind(bookingId, transitionId).first();
      if (committed) return true;
    } catch { /* An unknown outcome must retain the original error. */ }
    throw error;
  }
}

/** Player uploads payment proof for a running hold (or during a resubmit window). */
export async function submitProof(
  env: Bindings,
  settings: Settings,
  user: SessionUser,
  bookingId: string,
  file: File,
  fields: { gcashRef: string | null; amount: number | null; paymentMethodId?: string },
  now = Date.now(),
) {
  const db = env.DB;
  const b = await getBooking(db, bookingId);
  if (b.user_id !== user.id) throw notFound('Booking not found.');
  const status = effectiveStatus(b, now);
  if (status === 'PAYMENT_SUBMITTED') throw conflict('ALREADY_SUBMITTED', 'Payment proof was already submitted for this booking.');
  if (status === 'EXPIRED') throw conflict('HOLD_EXPIRED', 'Your temporary reservation expired before the proof arrived, so the slot was released.');
  if (status !== 'TEMPORARY' && status !== 'REJECTED') throw conflict('INVALID_STATUS', 'This booking is not waiting for payment.');
  const method = await selectedPaymentMethod(env, fields.paymentMethodId);

  if (file.size > MAX_UPLOAD_BYTES) {
    throw new ApiError(413, 'FILE_TOO_LARGE', 'This image is too large. The limit is 10 MB — a screenshot is usually well under that.');
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.length === 0) throw unprocessable('EMPTY_FILE', 'That file is empty. Choose your payment screenshot again.');
  const kind = sniffImage(bytes);
  if (!kind) throw unprocessable('UNSUPPORTED_FILE_TYPE', "That file type isn't supported. Upload a JPG, PNG or WEBP screenshot.");
  const clean = stripMetadata(bytes, kind);

  const proofId = newId('p_');
  const key = `proofs/${bookingId}/${proofId}.${kind.ext}`;
  const upload = await beginUpload(env,key,'proof',user.id,bookingId,Date.now());
  try {
    const object = await env.PROOFS.put(key, clean, {
      httpMetadata: { contentType: kind.type },
      customMetadata: { bookingId, userId: user.id, uploadId:upload.id },
    });
    if (!object) throw new Error('R2 upload was not stored');
    await markUploadStored(env,upload);
  } catch (error) { await recoverUploadFailure(env,upload); throw error; }

  now = Date.now();

  const g = bookingTransition(bookingId);
  const where = `${b.resource_name} · ${dateLabel(b.date)} · ${slotLabel(b)}`;
  const match = amountMatches(b, fields.amount);
  const resubmitted = b.status === 'REJECTED';
  // Initial holds never return to TEMPORARY, so a warning may safely advance
  // their transition token during upload. REJECTED can recur: fence that exact
  // rejection cycle to stop an old upload from becoming a later resubmission.
  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE bookings SET status = 'PAYMENT_SUBMITTED', submitted_at = ?1, hold_expires_at = NULL, updated_at = ?1, transition_id = ?4,
            payment_method_id=?9, payment_method_name=?10
          WHERE id = ?2 AND user_id = ?3 AND status IN ('TEMPORARY', 'REJECTED') AND hold_expires_at > ?1
            AND status = ?7 AND (?7 = 'TEMPORARY' OR transition_id IS ?8)
            AND EXISTS (SELECT 1 FROM storage_uploads WHERE id = ?5 AND state='staged' AND claim_id = ?6 AND lease_until > ?1)
            AND EXISTS (SELECT 1 FROM payment_methods WHERE id=?9 AND enabled=1 AND deleted_at IS NULL
              AND name=?10 AND account_name IS ?11 AND account_number IS ?12 AND qr_key IS ?13)`,
      )
      .bind(now, bookingId, user.id, g.id,upload.id,upload.token,b.status,b.transition_id, method.id, method.name, method.account_name, method.account_number, method.qr_key),
    db
      .prepare(
        `INSERT INTO payment_proofs (id, booking_id, user_id, r2_key, content_type, size, original_name, gcash_ref, amount_claimed, status, created_at,
          payment_method_id, payment_method_name, account_name, account_number)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?, ?, ?, ? WHERE ${g.sql}`,
      )
      .bind(proofId, bookingId, user.id, key, kind.type, clean.length, (file.name || '').slice(0, 120) || null, fields.gcashRef, fields.amount, now,
        method.id, method.name, method.account_name, method.account_number, ...g.params),
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
    `Payment method: ${method.name}`,
    `Payment reference: ${fields.gcashRef ?? 'not entered'}`,
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

  stmts.push(attachUploadStmt(env,upload,now));
  let update: D1Result | undefined;
  try { [update] = await db.batch(stmts); }
  catch (error) {
    // Fencing cleanup is safe even if D1 committed but its response was lost.
    await recoverUploadFailure(env,upload);
    try {
      const saved = await db.prepare('SELECT id FROM payment_proofs WHERE id=? AND r2_key=?').bind(proofId,key).first();
      if (saved) return getBooking(db,bookingId);
    } catch { /* Unknown state stays durably tracked; do not blindly delete. */ }
    throw error;
  }
  if (!update?.meta.changes) {
    await recoverUploadFailure(env,upload);
    const current = await getBooking(db,bookingId);
    if (current.status === 'PAYMENT_SUBMITTED') throw conflict('ALREADY_SUBMITTED','Payment proof was already submitted for this booking.');
    if (effectiveStatus(current,Date.now()) === 'EXPIRED') throw conflict('HOLD_EXPIRED', 'Your temporary reservation expired before the proof arrived, so the slot was released.');
    if (current.status !== b.status || current.transition_id !== b.transition_id) throw conflict('BOOKING_CHANGED','This booking changed while the image was uploading. Refresh it and submit the current payment proof.');
    const currentMethod = await selectedPaymentMethod(env, method.id);
    if (currentMethod.name !== method.name || currentMethod.account_name !== method.account_name || currentMethod.account_number !== method.account_number || currentMethod.qr_key !== method.qr_key) {
      throw conflict('PAYMENT_METHOD_UNAVAILABLE', 'Payment instructions changed during the upload. Refresh the payment methods before submitting again.');
    }
    throw conflict('UPLOAD_EXPIRED','The image could not be saved. Refresh this booking and upload the screenshot again.');
  }
  return getBooking(db, bookingId);
}

/** Staff approve a submitted proof → CONFIRMED. */
export async function approvePayment(env: Bindings, staff: SessionUser, bookingId: string, now = Date.now(), chatMessage: string | null = null, proofId: string | null = null) {
  const db = env.DB;
  const b = await getBooking(db, bookingId);
  const g = bookingTransition(bookingId);
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
  const changed = await paymentDecisionBatch(db, staff, bookingId, g.id, [
    db
      .prepare(`UPDATE bookings SET status = 'CONFIRMED', confirmed_at = ?1, confirmed_by = ?2, updated_at = ?1, transition_id = ?4
        WHERE id = ?3 AND status = 'PAYMENT_SUBMITTED' AND transition_id IS ?5
          AND (?6 IS NULL OR EXISTS (SELECT 1 FROM payment_proofs WHERE id = ?6 AND booking_id = ?3 AND status = 'submitted'))`)
      .bind(now, staff.id, bookingId, g.id,b.transition_id,proofId),
    db
      .prepare(`UPDATE payment_proofs SET status = 'approved' WHERE booking_id = ? AND status = 'submitted' AND ${g.sql}`)
      .bind(bookingId, ...g.params),
    eventStmt(db, bookingId, 'approved', staff.id, 'staff', null, now, g),
    systemMessageStmt(db, bookingId, 'Payment verified · booking confirmed', now, g),
    ...extra,
    userNoticeStmt(db, b.user_id, { type: 'payment_verified', title: 'Payment verified', body: `Booking confirmed · ${where}`, link: `/bookings/${bookingId}`, bookingId }, now, g),
    resolveStaffStmt(db, bookingId, ['proof_submitted', 'new_booking', 'hold_expiring'], now, g),
    outboxStmt(db, 'email', b.user_email ?? '', 'Le Spinners — Booking confirmed',
      `Hi ${b.user_name},\n\nPayment verified. Your booking is confirmed.\n\n${activityLabel(b.activity)} · ${where}\nReference: ${b.ref}\nAmount: ${peso(b.amount_due)}${b.credit_applied > 0 ? ` ${b.payment_method_name || 'GCash'} + ${peso(b.credit_applied)} booking credit` : ''}\n\nView your ticket: ${env.APP_ORIGIN}/bookings/${bookingId}\n\nSee you on court!\nLe Spinners Recreational Hub`,
      bookingId, now, g),
  ]);
  if (!changed) {
    const current = await getBooking(db,bookingId);
    if (current.status === 'PAYMENT_SUBMITTED') throw conflict('PROOF_CHANGED','The payment proof changed. Refresh this booking and review the current screenshot before deciding.');
    throw conflict('INVALID_STATUS', 'This booking is no longer waiting for verification. Someone may have handled it already.');
  }
}

/** Staff reject a submitted proof. With keepHold the player gets a resubmit window. */
export async function rejectPayment(
  env: Bindings,
  settings: Settings,
  staff: SessionUser,
  bookingId: string,
  input: { reason: string; message: string | null; keepHold: boolean; proofId?: string },
  now = Date.now(),
) {
  const db = env.DB;
  const b = await getBooking(db, bookingId);
  const g = bookingTransition(bookingId);
  const holdUntil = input.keepHold ? now + settings.resubmitMinutes * 60_000 : null;
  const nextStatus = input.keepHold ? 'REJECTED' : 'EXPIRED';
  const where = `${b.resource_name} · ${dateLabel(b.date)} · ${slotLabel(b)}`;
  const chatText = input.message?.trim() ||
    `${input.reason}${input.keepHold ? ` Please send a new screenshot within ${settings.resubmitMinutes} minutes.` : ''}`;
  const changed = await paymentDecisionBatch(db, staff, bookingId, g.id, [
    db
      .prepare(
        `UPDATE bookings SET status = ?1, rejected_at = ?2, rejected_by = ?3, reject_reason = ?4, hold_expires_at = ?5, warned_at = NULL, updated_at = ?2, transition_id = ?7
          WHERE id = ?6 AND status = 'PAYMENT_SUBMITTED' AND transition_id IS ?8
            AND (?9 IS NULL OR EXISTS (SELECT 1 FROM payment_proofs WHERE id = ?9 AND booking_id = ?6 AND status = 'submitted'))`,
      )
      .bind(nextStatus, now, staff.id, input.reason, holdUntil, bookingId, g.id,b.transition_id,input.proofId ?? null),
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
    // Without a resubmit window the booking is over: any booking credit it used comes back.
    ...releaseStmts(db, 'b.id = ? AND b.transition_id = ?', [bookingId, g.id], now),
  ]);
  if (!changed) {
    const current = await getBooking(db,bookingId);
    if (current.status === 'PAYMENT_SUBMITTED') throw conflict('PROOF_CHANGED','The payment proof changed. Refresh this booking and review the current screenshot before deciding.');
    throw conflict('INVALID_STATUS', 'This booking is no longer waiting for verification. Someone may have handled it already.');
  }
}

/** Staff cancel any active booking with a reason. */
export async function staffCancel(env: Bindings, staff: SessionUser, bookingId: string, reason: string, now = Date.now()) {
  const db = env.DB;
  const b = await getBooking(db, bookingId);
  const g = bookingTransition(bookingId);
  const where = `${b.resource_name} · ${dateLabel(b.date)} · ${slotLabel(b)}`;
  const [update] = await authorizedBatch(db, staff, [
    db
      .prepare(
        `UPDATE bookings SET status = 'CANCELLED', cancelled_at = ?1, cancelled_by = ?2, cancel_reason = ?3, hold_expires_at = NULL, updated_at = ?1, transition_id = ?5
          WHERE id = ?4 AND status IN ('TEMPORARY', 'REJECTED')`,
      )
      .bind(now, staff.id, reason, bookingId, g.id),
    eventStmt(db, bookingId, 'cancelled', staff.id, 'staff', reason, now, g),
    systemMessageStmt(db, bookingId, `Booking cancelled by staff · ${reason}`, now, g),
    userNoticeStmt(db, b.user_id, { type: 'booking_cancelled', title: 'Booking cancelled by Le Spinners', body: `${where} · ${reason}`, link: `/bookings/${bookingId}`, bookingId }, now, g),
    resolveStaffStmt(db, bookingId, ['proof_submitted', 'new_booking', 'hold_expiring', 'booking_cancelled'], now, g),
    outboxStmt(db, 'email', b.user_email ?? '', 'Le Spinners — Booking cancelled',
      `Hi ${b.user_name},\n\nYour booking ${b.ref} (${where}) was cancelled by Le Spinners.\nReason: ${reason}\n\nQuestions? Reply in the booking chat: ${env.APP_ORIGIN}/bookings/${bookingId}/chat\n\nLe Spinners Recreational Hub`,
      bookingId, now, g),
    ...releaseStmts(db, 'b.id = ? AND b.transition_id = ?', [bookingId, g.id], now),
  ]);
  if (!update?.meta.changes) {
    throw conflict('NOT_CANCELLABLE', 'Only unpaid holds can be cancelled here. For a paid or confirmed booking, use "Cancel & credit": it issues the player a booking credit.');
  }
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
    'SELECT id, content_type, size, original_name, gcash_ref, amount_claimed, status, created_at, payment_method_id, payment_method_name, account_name, account_number FROM payment_proofs WHERE booking_id = ? ORDER BY created_at DESC, rowid DESC',
  )
    .bind(bookingId)
    .all<Omit<ProofRow, 'booking_id' | 'user_id' | 'r2_key'>>();
  return results.map((p) => ({
    id: p.id,
    contentType: p.content_type,
    size: p.size,
    fileName: p.original_name,
    gcashRef: p.gcash_ref,
    paymentMethodId: p.payment_method_id ?? 'gcash',
    paymentMethodName: p.payment_method_name ?? 'GCash',
    accountName: p.account_name ?? null,
    accountNumber: p.account_number ?? null,
    amountClaimed: p.amount_claimed,
    status: p.status,
    createdAt: p.created_at,
  }));
}
