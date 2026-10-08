import * as z from 'zod';
import type { Bindings } from '../types';
import { conflict } from './errors';

export type PaymentMethodRow = {
  id: string; name: string; account_name: string | null; account_number: string | null;
  qr_key: string | null; enabled: number; deleted_at: number | null;
};

const optionalDetail = (max: number) => z.string().trim().max(max)
  .refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Use printable characters.').nullable().optional();
export const paymentMethodSchema = z.object({
  name: z.string().trim().min(1, 'Enter a payment method name.').max(80)
    .refine(value => !/[\u0000-\u001f\u007f]/.test(value), 'Use printable characters.'),
  accountName: optionalDetail(120),
  accountNumber: optionalDetail(100),
  enabled: z.boolean().default(true),
}).strict();

export function paymentMethodDTO(row: PaymentMethodRow) {
  return {
    id: row.id, name: row.name, accountName: row.account_name, accountNumber: row.account_number,
    enabled: Boolean(row.enabled), hasQr: Boolean(row.qr_key),
    qrUrl: row.qr_key ? `/api/facility/payment-methods/${encodeURIComponent(row.id)}/qr?v=${encodeURIComponent(row.qr_key.split('/').pop() ?? '')}` : null,
  };
}

export async function listPaymentMethods(db: D1Database, enabledOnly = false) {
  const { results } = await db.prepare(`SELECT * FROM payment_methods WHERE deleted_at IS NULL
    ${enabledOnly ? 'AND enabled=1' : ''} ORDER BY created_at, id`).all<PaymentMethodRow>();
  return results.map(paymentMethodDTO);
}

/** Omitted selection is supported only for old GCash clients. Never auto-select another method. */
export async function selectedPaymentMethod(env: Bindings, id = 'gcash') {
  const row = await env.DB.prepare('SELECT * FROM payment_methods WHERE id=? AND enabled=1 AND deleted_at IS NULL')
    .bind(id).first<PaymentMethodRow>();
  if (!row) throw conflict('PAYMENT_METHOD_UNAVAILABLE', 'This payment method is unavailable. Choose an enabled payment method and try again.');
  return row;
}
