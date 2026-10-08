/** Shared collected-cash rule; booking credit and unchecked payments are excluded. */
export function collectedPaymentSql(alias = '') {
  const prefix = alias ? `${alias}.` : '';
  return `${prefix}status IN ('CONFIRMED', 'COMPLETED') AND ${prefix}confirmed_at IS NOT NULL AND ${prefix}payment_method != 'none'`;
}
