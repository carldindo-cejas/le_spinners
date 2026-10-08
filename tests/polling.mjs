import test from 'node:test';
import assert from 'node:assert/strict';
import { poll } from '../public/js/core/poll.js';

function browser(t) {
  const doc = new EventTarget();
  doc.hidden = false;
  const win = new EventTarget();
  const nav = { onLine: true };
  for (const [key, value] of Object.entries({ document: doc, window: win, navigator: nav })) {
    const original = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, value });
    t.after(() => original ? Object.defineProperty(globalThis, key, original) : delete globalThis[key]);
  }
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1000000 });
  t.mock.method(console, 'warn', () => {});
  return { doc, win, nav, event: (target, name) => target.dispatchEvent(new Event(name)), tick: async ms => { t.mock.timers.tick(ms); await settle(); } };
}
const settle = async () => { for (let n = 0; n < 8; n++) await Promise.resolve(); };

test('poll coalesces visibility/online wakeups during an unfinished request', async t => {
  const b = browser(t);
  let calls = 0, resolve;
  const stop = poll(() => { calls++; return new Promise(r => { resolve = r; }); }, 1000, { immediate: true });
  for (let n = 0; n < 4; n++) { b.event(b.doc, 'visibilitychange'); b.event(b.win, 'online'); }
  await b.tick(10000);
  assert.equal(calls, 1);
  resolve(); await settle();
  await b.tick(1000);
  assert.equal(calls, 2);
  stop(); resolve(); await settle();
  await b.tick(100000);
  assert.equal(calls, 2);
});

test('poll pauses hidden/offline/idle and resumes once after user activity', async t => {
  const b = browser(t);
  let calls = 0;
  const stop = poll(async () => { calls++; }, 1000, { idleMs: 3000 });
  b.doc.hidden = true; b.event(b.doc, 'visibilitychange');
  await b.tick(10000); assert.equal(calls, 0);
  b.doc.hidden = false; b.event(b.doc, 'visibilitychange'); await settle(); assert.equal(calls, 1);
  b.nav.onLine = false; b.event(b.win, 'offline'); await b.tick(10000); assert.equal(calls, 1);
  b.nav.onLine = true; b.event(b.win, 'online'); await settle(); assert.equal(calls, 2);
  await b.tick(3000); const idleCalls = calls;
  await b.tick(10000); assert.equal(calls, idleCalls);
  b.event(b.doc, 'pointerdown'); await settle(); assert.equal(calls, idleCalls + 1);
  stop(); b.event(b.doc, 'keydown'); b.event(b.win, 'online'); await b.tick(5000);
  assert.equal(calls, idleCalls + 1);
});

test('poll backs off failures and resets its interval after success', async t => {
  const b = browser(t);
  let calls = 0;
  const stop = poll(async () => { if (++calls <= 2) throw Error('offline provider'); }, 1000, { immediate: true, idleMs: 60000 });
  await settle(); await b.tick(1000); assert.equal(calls, 1);
  await b.tick(1000); assert.equal(calls, 2);
  await b.tick(3000); assert.equal(calls, 2);
  await b.tick(1000); assert.equal(calls, 3);
  await b.tick(1000); assert.equal(calls, 4);
  stop();
});
