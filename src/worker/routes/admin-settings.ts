import { Hono } from 'hono';
import * as z from 'zod';
import type { AppEnv, ResourceRow } from '../types';
import { audit, requireAdmin, requireStaff } from '../lib/auth';
import type { HoursRow } from '../lib/bookings';
import { newId } from '../lib/crypto';
import { ApiError, badRequest, notFound, unprocessable } from '../lib/errors';
import { sniffImage, stripMetadata } from '../lib/images';
import { invalidateSettings, loadSettings } from '../lib/settings';
import { dateLabel, hoursLabel, peso } from '../lib/time';
import { jsonBody, parse, zDate, zId } from '../lib/validate';
import { zEmail } from './auth';

export const adminSettingsRoutes = new Hono<AppEnv>();

adminSettingsRoutes.use('*', async (c, next) => {
  requireStaff(c);
  await next();
});

const QR_MAX_BYTES = 5 * 1024 * 1024;

adminSettingsRoutes.get('/settings', async (c) => {
  const user = requireStaff(c);
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
      status: r.status,
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
  const key = `settings/gcash-qr/${newId()}.${kind.ext}`;
  await c.env.PROOFS.put(key, stripMetadata(bytes, kind), { httpMetadata: { contentType: kind.type } });
  const previous = (await loadSettings(c.env.DB)).gcashQrKey;
  await upsertSetting(c.env.DB, 'gcash_qr_key', key, Date.now(), admin.id).run();
  invalidateSettings();
  if (previous && previous !== key) c.executionCtx.waitUntil(c.env.PROOFS.delete(previous));
  c.executionCtx.waitUntil(audit(c, admin.id, 'gcash_qr_updated', 'settings', 'gcash_qr_key'));
  return c.json({ ok: true, qrUrl: '/api/facility/gcash-qr' });
});

adminSettingsRoutes.delete('/settings/gcash-qr', async (c) => {
  const admin = requireAdmin(c);
  const previous = (await loadSettings(c.env.DB)).gcashQrKey;
  await upsertSetting(c.env.DB, 'gcash_qr_key', '', Date.now(), admin.id).run();
  invalidateSettings();
  if (previous) c.executionCtx.waitUntil(c.env.PROOFS.delete(previous));
  c.executionCtx.waitUntil(audit(c, admin.id, 'gcash_qr_removed', 'settings', 'gcash_qr_key'));
  return c.json({ ok: true });
});

const resourceSchema = z.object({
  name: z.string().trim().min(2).max(40).optional(),
  priceMember: z.number().int().min(0).max(10_000_000).optional(),
  priceNonMember: z.number().int().min(0).max(10_000_000).optional(),
  status: z.enum(['active', 'maintenance', 'disabled']).optional(),
  maintenanceNote: z.string().trim().max(120).nullable().optional(),
  maintenanceUntil: zDate.nullable().optional(),
});

/** Prices (centavos) and maintenance status of one court or table. */
adminSettingsRoutes.patch('/resources/:id', async (c) => {
  const admin = requireAdmin(c);
  const id = parse(zId, c.req.param('id'));
  const body = await jsonBody(c, resourceSchema);
  const db = c.env.DB;
  const current = await db.prepare('SELECT * FROM resources WHERE id = ?').bind(id).first<ResourceRow>();
  if (!current) throw notFound('Court or table not found.');
  const next = {
    name: body.name ?? current.name,
    price_member: body.priceMember ?? current.price_member,
    price_non_member: body.priceNonMember ?? current.price_non_member,
    status: body.status ?? current.status,
    maintenance_note: body.maintenanceNote === undefined ? current.maintenance_note : body.maintenanceNote || null,
    maintenance_until: body.maintenanceUntil === undefined ? current.maintenance_until : body.maintenanceUntil,
  };
  if (next.status !== 'maintenance') {
    next.maintenance_note = null;
    next.maintenance_until = null;
  }
  await db
    .prepare(
      `UPDATE resources SET name = ?, price_member = ?, price_non_member = ?, status = ?, maintenance_note = ?, maintenance_until = ?, updated_at = ?
        WHERE id = ?`,
    )
    .bind(next.name, next.price_member, next.price_non_member, next.status, next.maintenance_note, next.maintenance_until, Date.now(), id)
    .run();
  c.executionCtx.waitUntil(audit(c, admin.id, 'resource_updated', 'resource', id, Object.keys(body).join(',')));
  return c.json({ ok: true });
});

/** Recent email/SMS notifications, so staff can see what was queued or sent. */
adminSettingsRoutes.get('/outbox', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT id, channel, recipient, subject, status, attempts, last_error, booking_id, created_at, sent_at
       FROM outbox ORDER BY created_at DESC LIMIT 50`,
  ).all<{
    id: string;
    channel: string;
    recipient: string;
    subject: string | null;
    status: string;
    attempts: number;
    last_error: string | null;
    booking_id: string | null;
    created_at: number;
    sent_at: number | null;
  }>();
  return c.json({
    items: results.map((o) => ({
      id: o.id,
      channel: o.channel,
      recipient: o.recipient,
      subject: o.subject,
      status: o.status,
      attempts: o.attempts,
      lastError: o.last_error,
      bookingId: o.booking_id,
      createdAt: o.created_at,
      sentAt: o.sent_at,
    })),
  });
});
