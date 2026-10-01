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

async function request(method, path, { body, signal, quiet401 = false } = {}) {
  const headers = { Accept: 'application/json' };
  let payload;
  if (body !== undefined && method !== 'GET') {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, { method, headers, body: payload, credentials: 'same-origin', signal, cache: 'no-store' });
  } catch (err) {
    if (err && err.name === 'AbortError') throw err;
    throw networkError();
  }
  let data = null;
  if ((res.headers.get('content-type') || '').includes('application/json')) data = await res.json().catch(() => null);
  if (!res.ok) {
    const err = toError(res.status, data);
    if (res.status === 401 && !quiet401) for (const fn of unauthorizedListeners) fn(err);
    throw err;
  }
  return data;
}

/** Multipart upload with progress (fetch can't report upload progress). */
function upload(path, form, { method = 'POST', onProgress, quiet401 = false } = {}) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, path);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.withCredentials = true;
    xhr.timeout = 120_000;
    if (onProgress) {
      xhr.upload.addEventListener('progress', (e) => {
        if (e.lengthComputable) onProgress(Math.min(99, Math.round((e.loaded / e.total) * 100)));
      });
    }
    xhr.addEventListener('load', () => {
      let data = null;
      try {
        data = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        if (onProgress) onProgress(100);
        resolve(data);
        return;
      }
      const err = toError(xhr.status, data);
      if (xhr.status === 401 && !quiet401) for (const fn of unauthorizedListeners) fn(err);
      reject(err);
    });
    const fail = () => reject(networkError());
    xhr.addEventListener('error', fail);
    xhr.addEventListener('timeout', fail);
    xhr.addEventListener('abort', fail);
    xhr.send(form);
  });
}

export const api = {
  get: (path, opts) => request('GET', path, opts),
  post: (path, body = {}, opts) => request('POST', path, { ...opts, body }),
  put: (path, body = {}, opts) => request('PUT', path, { ...opts, body }),
  patch: (path, body = {}, opts) => request('PATCH', path, { ...opts, body }),
  delete: (path, opts) => request('DELETE', path, { ...opts, body: {} }),
  upload,
};
