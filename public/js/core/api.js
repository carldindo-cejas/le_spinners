import { abortError, requestGuard } from './lifecycle.js';
/** JSON API client. The server is the only authority on status, money and time. */

export class ApiError extends Error {
  constructor(status, code, message, details, requestId) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details || null;
    this.requestId = requestId || null;
  }
}

const unauthorizedListeners = new Set();

/** Called when a signed-in request comes back 401 (session ended). */
export function onUnauthorized(fn) {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

function networkError() {
  return new ApiError(
    0,
    'NETWORK',
    navigator.onLine === false ? "You're offline. Check your connection and try again." : "Couldn't reach Le Spinners. Check your connection and try again.",
  );
}

function toError(status, data) {
  const e = (data && data.error) || {};
  return new ApiError(status, e.code || `HTTP_${status}`, e.message || 'Something went wrong. Please try again.', e.details, e.requestId);
}

async function request(method, path, { body, signal, scope, quiet401 = false, headers: extra = {} } = {}) {
  const guard = requestGuard({ signal, scope });
  try {
    guard.check();
    const headers = { ...extra, Accept: 'application/json' };
    let payload;
    if (body !== undefined && method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    let res;
    try {
      res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin', signal: guard.signal, cache: 'no-store' });
    } catch (err) {
      guard.check();
      if (err && err.name === 'AbortError') throw err;
      throw networkError();
    }
    let data = null;
    guard.check();
    if ((res.headers.get('content-type') || '').includes('application/json')) data = await res.json().catch(() => null);
    guard.check();
    if (!res.ok) {
      const err = toError(res.status, data);
      if (res.status === 401 && !quiet401) for (const fn of unauthorizedListeners) fn(err);
      throw err;
    }
    return data;
  } finally { guard.release(); }
}

/** Multipart upload with progress (fetch can't report upload progress). */
function upload(path, form, { method = 'POST', onProgress, signal, scope, quiet401 = false } = {}) {
  const guard = requestGuard({ signal, scope });
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      guard.signal.removeEventListener('abort', cancel);
      guard.release();
      if (error) reject(error); else resolve(value);
    };
    const cancel = () => { xhr.abort(); finish(abortError()); };
    guard.signal.addEventListener('abort', cancel, { once: true });
    try { guard.check(); } catch (error) { finish(error); return; }
    xhr.open(method, path);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.withCredentials = true;
    xhr.timeout = 120_000;
    if (onProgress) {
      xhr.upload.addEventListener('progress', (e) => {
        if (!settled && !guard.signal.aborted && e.lengthComputable) onProgress(Math.min(99, Math.round((e.loaded / e.total) * 100)));
      });
    }
    xhr.addEventListener('load', () => {
      try { guard.check(); } catch (error) { finish(error); return; }
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        if (onProgress) onProgress(100);
        finish(null, data);
        return;
      }
      const err = toError(xhr.status, data);
      if (xhr.status === 401 && !quiet401) for (const fn of unauthorizedListeners) fn(err);
      finish(err);
    });
    const fail = () => finish(guard.signal.aborted ? abortError() : networkError());
    xhr.addEventListener('error', fail);
    xhr.addEventListener('timeout', fail);
    xhr.addEventListener('abort', fail);
    try { xhr.send(form); } catch (error) { finish(error); }
  });
}

export const api = {
  get: (path, opts) => request('GET', path, opts),
  post: (path, body = {}, opts) => request('POST', path, { ...opts, body }),
  put: (path, body = {}, opts) => request('PUT', path, { ...opts, body }),
  patch: (path, body = {}, opts) => request('PATCH', path, { ...opts, body }),
  delete: (path, opts) => request('DELETE', path, { ...opts, body: {} }),
  upload,
  forScope: scope => ({
    get: (path, opts) => request('GET', path, { ...opts, scope }),
    post: (path, body = {}, opts) => request('POST', path, { ...opts, body, scope }),
    put: (path, body = {}, opts) => request('PUT', path, { ...opts, body, scope }),
    patch: (path, body = {}, opts) => request('PATCH', path, { ...opts, body, scope }),
    delete: (path, opts) => request('DELETE', path, { ...opts, body: {}, scope }),
    upload: (path, form, opts) => upload(path, form, { ...opts, scope }),
  }),
};
