import test from 'node:test';
import assert from 'node:assert/strict';
import { postBooking } from '../public/js/core/booking-request.js';

test('booking client retains its key for a lost response, reload, and malformed success', async t => {
  const data = new Map();
  const storage = { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  const original = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
  t.after(() => original ? Object.defineProperty(globalThis, 'sessionStorage', original) : delete globalThis.sessionStorage);
  const keys = [];
  const payloads = [];
  let call = 0;
  t.mock.method(globalThis, 'fetch', async (_path, options) => {
    keys.push(options.headers['Idempotency-Key']);
    payloads.push(JSON.parse(options.body));
    if (++call === 1) throw Error('Response lost');
    if (call === 2) return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
    return Response.json({ booking: { id: 'original-booking' } });
  });
  const body = { resourceId: 'court-1', date: '2026-10-08', starts: [660, 600], useCredit: true, expectedCredit: 50000 };
  await assert.rejects(postBooking('/api/bookings', body, 'player'));
  assert.equal(data.size, 1);
  const freshModule = await import('../public/js/core/booking-request.js?reload=1');
  await assert.rejects(freshModule.postBooking('/api/bookings', { ...body, starts: [600, 660], useCredit: false, expectedCredit: null }, 'player'));
  const replay = await freshModule.postBooking('/api/bookings', body, 'player');
  assert.equal(replay.booking.id, 'original-booking');
  assert.equal(new Set(keys).size, 1);
  assert.deepEqual(payloads[0], payloads[1]);
  assert.deepEqual(payloads[1], payloads[2]);
  assert.equal(data.size, 0);
});
