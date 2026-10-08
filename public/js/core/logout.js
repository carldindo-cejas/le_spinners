import { api } from './api.js';
import { abortError } from './lifecycle.js';

export const LOGOUT_KEY = 'ls.logout.v1';
export const LOGIN_ACK_KEY = 'ls.logout.login-ack.v1';
export const AUTH_LOCK = 'ls.session-mutation.v1';
const phases = new Set(['pending', 'failed', 'confirmed']);
function parseRecord(text) {
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    if (typeof value.id === 'string' && value.id && value.id.length <= 128 && phases.has(value.phase)) return {
      id: value.id, phase: value.phase, updatedAt: Number.isFinite(value.updatedAt) ? value.updatedAt : 0,
      ...(['network', 'timeout', 'response', 'server'].includes(value.error) ? { error: value.error } : {}),
    };
  } catch { /* A damaged marker must not restore private screens. */ }
  return { id: 'damaged-logout-marker', phase: 'failed', error: 'response' };
}

/** Only logout intent/status is stored: no cookie, credentials, user or API response. */
export function createLogoutManager({ storage, sharedStorage = true, locks, send, broadcast = () => {}, timeout = 10000, uuid = () => crypto.randomUUID() }) {
  let memory = null, loginAfter = null, persisted = true, inFlight = null, lastNotification = null, localAuthTail = Promise.resolve();
  const listeners = new Set();
  const read = () => {
    try { if (persisted) { memory = parseRecord(storage.getItem(LOGOUT_KEY)); loginAfter = storage.getItem(LOGIN_ACK_KEY); } }
    catch { persisted = false; }
    return memory?.phase === 'confirmed' && loginAfter === memory.id ? null : memory;
  };
  const notification = record => JSON.stringify({ record, busy: !!inFlight, persisted });
  const notify = () => {
    const record = read(), key = notification(record);
    if (key === lastNotification) return;
    lastNotification = key;
    for (const listener of listeners) listener(record);
  };
  function write(record) {
    memory = record;
    try { storage.setItem(LOGOUT_KEY, JSON.stringify(record)); } catch { persisted = false; }
    notify(); broadcast({ record, loginAfter });
  }
  const blocked = () => { const record = read(); return !!record && record.phase !== 'confirmed'; };
  const same = id => read()?.id === id;
  const lock = (signal, fn) => {
    if (locks?.request) return locks.request(AUTH_LOCK, { signal }, fn);
    const task = localAuthTail.then(() => { if (signal?.aborted) throw abortError(); return fn(); });
    localAuthTail = task.catch(() => {});
    return task;
  };
  async function attempt(id) {
    const controller = new AbortController();
    const expired = new Promise((_, reject) => controller.signal.addEventListener('abort', () => reject(abortError()), { once: true }));
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      await Promise.race([expired, lock(controller.signal, async () => {
        if (!same(id) || read().phase === 'confirmed') return;
        const response = await Promise.race([send(controller.signal), expired]);
        if (controller.signal.aborted) throw abortError();
        if (response?.ok !== true) throw new Error('UNCONFIRMED_RESPONSE');
        if (same(id) && read().phase !== 'confirmed') write({ id, phase: 'confirmed', updatedAt: Date.now() });
      })]);
    } catch (error) {
      if (same(id) && read().phase !== 'confirmed') write({ id, phase: 'failed', updatedAt: Date.now(),
        error: controller.signal.aborted ? 'timeout' : error.code === 'NETWORK' ? 'network' : error.message === 'UNCONFIRMED_RESPONSE' ? 'response' : 'server' });
    } finally { clearTimeout(timer); }
  }
  const manager = {
    read, blocked,
    get busy() { return !!inFlight; },
    get persisted() { return persisted; },
    sharedStorage,
    subscribe(listener) { const record = read(); listeners.add(listener); if (lastNotification === null) lastNotification = notification(record); listener(record); return () => listeners.delete(listener); },
    receive(message) {
      // Storage is authoritative; messages supply a fallback when storage is denied.
      if (message?.record) {
        const incoming = parseRecord(JSON.stringify(message.record));
        const older = memory && memory.id !== incoming.id && (incoming.updatedAt < memory.updatedAt
          || (incoming.updatedAt === memory.updatedAt && memory.phase !== 'confirmed' && incoming.phase === 'confirmed'));
        if (!older && (memory?.id !== incoming.id || memory?.phase !== 'confirmed')) memory = incoming;
      }
      if (typeof message?.loginAfter === 'string') loginAfter = message.loginAfter;
      if (!sharedStorage && message?.record) {
        try { storage.setItem(LOGOUT_KEY, JSON.stringify(memory)); if (loginAfter) storage.setItem(LOGIN_ACK_KEY, loginAfter); } catch { persisted = false; }
      }
      notify();
    },
    start() {
      if (inFlight) return inFlight;
      const record = read();
      if (record?.phase === 'confirmed') return Promise.resolve();
      const id = record?.id || uuid();
      // Ownership starts before private routes are invalidated. The request itself
      // belongs to the operation, so navigation cannot cancel server revocation.
      const task = Promise.resolve().then(() => attempt(id)).finally(() => {
        if (inFlight === task) { inFlight = null; notify(); }
      });
      inFlight = task;
      write({ id, phase: 'pending', updatedAt: Date.now() });
      return task;
    },
    async authenticate(sendLogin, { signal } = {}) {
      const before = read()?.id || null;
      const check = () => { if (signal?.aborted || blocked() || (read()?.id || null) !== before) throw abortError(); };
      check();
      return lock(signal, async () => {
        check();
        const result = await sendLogin();
        check();
        if (typeof result?.user?.id !== 'string' || !result.user.id) throw new Error('Sign-in was not confirmed. Please try again.');
        if (before) {
          // A separate acknowledgement cannot erase a newer logout intent.
          loginAfter = before;
          try { storage.setItem(LOGIN_ACK_KEY, before); } catch { persisted = false; }
          notify(); broadcast({ record: memory, loginAfter });
          if (read()) throw abortError();
        }
        return result;
      });
    },
  };
  return manager;
}

let instance;
export function getLogout() {
  if (instance) return instance;
  const stores = [];
  for (const name of ['localStorage', 'sessionStorage']) {
    try { const store = window[name]; const key = 'ls.logout.storage-probe'; store.setItem(key, '1'); store.removeItem(key); stores.push({ name, store }); } catch { /* try tab storage */ }
  }
  const storage = stores[0]?.store || { getItem() { throw new Error('Storage unavailable'); }, setItem() { throw new Error('Storage unavailable'); } };
  let channel;
  try { channel = new BroadcastChannel('ls.logout.v1'); } catch { /* storage events still coordinate tabs */ }
  instance = createLogoutManager({ storage, sharedStorage: stores[0]?.name === 'localStorage', locks: navigator.locks,
    send: signal => api.post('/api/auth/logout', {}, { scope: null, signal, quiet401: true }),
    broadcast: message => channel?.postMessage(message) });
  window.addEventListener('storage', event => { if (!event.key || [LOGOUT_KEY, LOGIN_ACK_KEY].includes(event.key)) instance.receive(); });
  if (channel) channel.onmessage = event => instance.receive(event.data);
  window.addEventListener('online', () => { if (instance.blocked()) instance.start(); });
  window.addEventListener('pageshow', () => instance.receive());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) instance.receive(); });
  return instance;
}
