import { Hono } from 'hono';
import * as z from 'zod';
import type { AppEnv, ResourceRow } from '../types';
import { audit, clientIp, requireAdmin } from '../lib/auth';
import { resourceStatus, type HoursRow } from '../lib/bookings';
import { newId } from '../lib/crypto';
import { ApiError, badRequest, unprocessable } from '../lib/errors';
import { sniffImage, stripMetadata } from '../lib/images';
import { invalidateSettings, loadSettings } from '../lib/settings';
import { dateLabel, hoursLabel, peso } from '../lib/time';
import { resourceUpdateSchema, updateResource } from '../lib/facility';
import { listOutbox } from '../lib/outbox';
import { beginUpload, commitQrUpload, markUploadStored, recoverUploadFailure, removeQr, storageHealth } from '../lib/storage';
import { jsonBody, parse, query, zId } from '../lib/validate';
import { zEmail } from './auth';

export const adminSettingsRoutes = new Hono<AppEnv>();

// Global configuration (GCash, prices, alert recipients, booking rules) and the outbox: admins only.
adminSettingsRoutes.use('*', async (c, next) => {
  requireAdmin(c);
  await next();
});

const QR_MAX_BYTES = 5 * 1024 * 1024;

adminSettingsRoutes.get('/settings', async (c) => {
  const user = requireAdmin(c);
  const db = c.env.DB;
  const s = await loadSettings(db);
  const [resources, hours] = await db.batch([
    db.prepare('SELECT * FROM resources ORDER BY activity, sort_order, name'),
    db.prepare('SELECT * FROM opening_hours ORDER BY weekday'),
  ]);
  return c.json({
    canEdit: user.role === 'admin',
    settings: {
      facilityName: s.facilityName,
      facilityAddress: s.facilityAddress,
      gcashName: s.gcashName,
      gcashNumber: s.gcashNumber,
      hasQr: Boolean(s.gcashQrKey),
      qrUrl: s.gcashQrKey ? '/api/facility/gcash-qr' : null,
      bookingWindowDays: s.bookingWindowDays,
      holdMinutes: s.holdMinutes,
      warnMinutes: s.warnMinutes,
      resubmitMinutes: s.resubmitMinutes,
      cancelCutoffHours: s.cancelCutoffHours,
      slotMinutes: s.slotMinutes,
      staffAlertEmails: s.staffAlertEmails,
      staffAlertSms: s.staffAlertSms,
    },
    delivery: {
      email: c.env.RESEND_API_KEY && c.env.EMAIL_FROM ? 'resend' : 'queued',
      sms: 'queued',
    },
    resources: ((resources?.results ?? []) as ResourceRow[]).map((r) => ({
      id: r.id,
      activity: r.activity,
      name: r.name,
      status: resourceStatus(r),
      maintenanceNote: r.maintenance_note,
      maintenanceUntil: r.maintenance_until,
      maintenanceUntilLabel: r.maintenance_until ? dateLabel(r.maintenance_until) : null,
      priceMember: r.price_member,
      priceNonMember: r.price_non_member,
      priceMemberLabel: peso(r.price_member),
      priceNonMemberLabel: peso(r.price_non_member),
    })),
    hours: ((hours?.results ?? []) as HoursRow[]).map((h) => ({
      weekday: h.weekday,
      isOpen: Boolean(h.is_open),
      open: h.open_min,
      close: h.close_min,
      label: h.is_open ? hoursLabel(h.open_min, h.close_min) : 'Closed',
    })),
  });
});

const zPhone = z
  .string()
  .trim()
  .regex(/^\+?[0-9][0-9 ()-]{6,19}$/, 'Enter a valid mobile number.');

const settingsSchema = z.object({
  facilityName: z.string().trim().min(2, 'Enter the facility name.').max(80).optional(),
  facilityAddress: z.string().trim().max(200).optional(),
  gcashName: z.string().trim().min(2, 'Enter the GCash account name.').max(80).optional(),
  gcashNumber: z
    .string()
    .trim()
    .regex(/^(\+?63|0)9\d{2}[ -]?\d{3}[ -]?\d{4}$/, 'Enter a GCash mobile number like 0917 123 4567.')
    .optional(),
  holdMinutes: z.number().int().min(5).max(30).optional(),
  resubmitMinutes: z.number().int().min(5).max(60).optional(),
  cancelCutoffHours: z.number().int().min(0).max(168).optional(),
  bookingWindowDays: z.number().int().min(1).max(60).optional(),
  staffAlertEmails: z.array(zEmail).max(5, 'Up to 5 addresses.').optional(),
  staffAlertSms: z.array(zPhone).max(5, 'Up to 5 numbers.').optional(),
});

const SETTING_KEYS: Record<keyof z.infer<typeof settingsSchema>, string> = {
  facilityName: 'facility_name',
  facilityAddress: 'facility_address',
  gcashName: 'gcash_name',
  gcashNumber: 'gcash_number',
  holdMinutes: 'hold_minutes',
  resubmitMinutes: 'resubmit_minutes',
  cancelCutoffHours: 'cancel_cutoff_hours',
  bookingWindowDays: 'booking_window_days',
  staffAlertEmails: 'staff_alert_emails',
  staffAlertSms: 'staff_alert_sms',
};

function upsertSetting(db: D1Database, key: string, value: string, now: number, by: string) {
  return db
    .prepare(
      `INSERT INTO settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    )
    .bind(key, value, now, by);
}

adminSettingsRoutes.put('/settings', async (c) => {
  const admin = requireAdmin(c);
  const body = await jsonBody(c, settingsSchema);
  const now = Date.now();
  const stmts: D1PreparedStatement[] = [];
  const changed: string[] = [];
  for (const [field, key] of Object.entries(SETTING_KEYS) as [keyof typeof SETTING_KEYS, string][]) {
    const value = body[field];
    if (value === undefined) continue;
    stmts.push(upsertSetting(c.env.DB, key, Array.isArray(value) ? value.join(',') : String(value), now, admin.id));
    changed.push(field);
  }
  if (!stmts.length) throw badRequest('Nothing to update.');
  await c.env.DB.batch(stmts);
  invalidateSettings();
  c.executionCtx.waitUntil(audit(c, admin.id, 'settings_updated', 'settings', undefined, changed.join(',')));
  return c.json({ ok: true, changed });
});

/** Upload the GCash QR image players scan on the payment screen. */
adminSettingsRoutes.put('/settings/gcash-qr', async (c) => {
  const admin = requireAdmin(c);
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    throw badRequest('Send the QR image as a file upload.');
  }
  const file = form.get('file');
  if (!(file instanceof File)) throw unprocessable('FILE_REQUIRED', 'Choose the QR image to upload.');
  if (file.size > QR_MAX_BYTES) throw new ApiError(413, 'FILE_TOO_LARGE', 'The QR image is too large. The limit is 5 MB.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniffImage(bytes);
  if (!kind) throw unprocessable('UNSUPPORTED_FILE_TYPE', 'Upload the QR code as a JPG, PNG or WEBP image.');
  const clean = stripMetadata(bytes,kind);
  const key = `settings/gcash-qr/${newId()}.${kind.ext}`;
  const upload = await beginUpload(c.env,key,'qr',admin.id,null);
  try {
    const object = await c.env.PROOFS.put(key,clean,{httpMetadata:{contentType:kind.type},customMetadata:{uploadId:upload.id}});
    if (!object) throw new Error('R2 upload was not stored');
    await markUploadStored(c.env,upload);
    await commitQrUpload(c.env,admin,upload,clientIp(c));
  } catch (error) {
    await recoverUploadFailure(c.env,upload);
    // The audit carries the intent identity, even if another administrator has since replaced it.
    let saved = false;
    try { saved = Boolean(await c.env.DB.prepare("SELECT id FROM audit_log WHERE action='gcash_qr_updated' AND detail=? LIMIT 1").bind(upload.id).first()); }
    catch { /* A durable staged/attached checkpoint survives unknown database state. */ }
    if (!saved) throw error;
    invalidateSettings();
  }
  return c.json({ ok: true, qrUrl: '/api/facility/gcash-qr' });
});

adminSettingsRoutes.delete('/settings/gcash-qr', async (c) => {
  const admin = requireAdmin(c);
  await removeQr(c.env,admin,clientIp(c));
  return c.json({ ok: true });
});

/** Prices (centavos) and status of one court or table. Same rules as /api/staff/facilities/:id. */
adminSettingsRoutes.patch('/resources/:id', async (c) => {
  const admin = requireAdmin(c);
  const id = parse(zId, c.req.param('id'));
  const body = await jsonBody(c, resourceUpdateSchema);
  return c.json({ ok: true, ...(await updateResource(c, admin, id, body)) });
});

/** Queue health and recent messages. Delivery states do not claim inbox delivery. */
adminSettingsRoutes.get('/outbox', async (c) => {
  const { state } = query(c, z.object({ state: z.enum(['all','ready','sending','retry','accepted','failed','needs_review','unsupported']).default('all') }));
  return c.json(await listOutbox(c.env, state));
});

adminSettingsRoutes.get('/storage-health', async c => c.json(await storageHealth(c.env)));
