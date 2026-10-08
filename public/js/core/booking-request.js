import { api, ApiError } from './api.js';

const pending = new Map();

/** Keep the exact intent's key through network/server failures and a tab reload. */
export async function postBooking(path, body, actorId) {
  const payload = { ...body, starts: body.starts ? [...new Set(body.starts)].sort((a, b) => a - b) : body.starts };
  // A committed credit-funded booking changes the next quote. Recover the
  // pending court/time intent before accepting that newly calculated payload.
  const intent = path === '/api/bookings' ? { resourceId: payload.resourceId, date: payload.date, starts: payload.starts } : payload;
  const storageKey = `booking-request:${actorId}:${path}:${JSON.stringify(intent)}`;
  let record = pending.get(storageKey);
  try { record ||= JSON.parse(sessionStorage.getItem(storageKey) || 'null'); } catch { /* memory fallback */ }
  if (!record?.key || !record?.payload) record = { key: crypto.randomUUID(), payload };
  pending.set(storageKey, record);
  try { sessionStorage.setItem(storageKey, JSON.stringify(record)); } catch { /* memory fallback */ }
  const clear = () => {
    pending.delete(storageKey);
    try { sessionStorage.removeItem(storageKey); } catch { /* memory fallback */ }
  };
  try {
    const result = await api.post(path, record.payload, { headers: { 'Idempotency-Key': record.key } });
    if (!result?.booking?.id) throw new ApiError(0, 'NETWORK', "Couldn't confirm the booking response. Try again to recover your booking.");
    clear();
    return result;
  } catch (error) {
    // These responses definitively reject the intent. Network, timeout, throttle,
    // malformed success and server failures retain the key for recovery.
    if (error.status >= 400 && error.status < 500 && ![408, 429].includes(error.status)) clear();
    throw error;
  }
}
