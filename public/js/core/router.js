/**
 * History-API router. Views are async functions that render into the page and
 * may return a cleanup function (timers, polling, listeners).
 */

function compile(path) {
  const keys = [];
  const pattern = path
    .replace(/\/$/, '')
    .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:(\w+)/g, (_, key) => {
      keys.push(key);
      return '([^/]+)';
    });
  return { re: new RegExp(`^${pattern || ''}/?$`), keys };
}

export function createRouter({ routes, notFound, base = '', ignore = [] }) {
  const compiled = routes.map((r) => ({ ...r, ...compile(base + r.path) }));
  let current = null;
  let navId = 0;
  const scrollPositions = new Map();
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

  function depth() {
    return (history.state && history.state.depth) || 0;
  }

  async function resolve({ restoreScroll = false } = {}) {
    const url = new URL(location.href);
    const path = url.pathname;
    let match = null;
    let params = {};
    for (const r of compiled) {
      const m = r.re.exec(path);
      if (m) {
        match = r;
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        break;
      }
    }
    const id = ++navId;
    if (current && current.cleanup) {
      try {
        current.cleanup();
      } catch (err) {
        console.error(err);
      }
    }
    current = null;
    const route = match || { view: notFound, name: 'not-found' };
    const ctx = {
      params,
      query: url.searchParams,
      path,
      route,
      state: history.state || {},
      isCurrent: () => id === navId,
    };
    let result;
    try {
      result = await route.view(ctx);
    } catch (err) {
      console.error(err);
    }
    if (id !== navId) {
      if (typeof result === 'function') result();
      return;
    }
    current = { cleanup: typeof result === 'function' ? result : null };
    const key = history.state && history.state.key;
    window.scrollTo(0, restoreScroll && key && scrollPositions.has(key) ? scrollPositions.get(key) : 0);
  }

  function saveScroll() {
    const key = history.state && history.state.key;
    if (key) scrollPositions.set(key, window.scrollY);
  }

  function navigate(to, { replace = false, state = {} } = {}) {
    const url = new URL(to, location.origin);
    if (url.origin !== location.origin) {
      location.href = url.href;
      return;
    }
    saveScroll();
    const next = { ...state, key: Math.random().toString(36).slice(2), depth: replace ? depth() : depth() + 1 };
    if (replace) history.replaceState(next, '', url.pathname + url.search + url.hash);
    else history.pushState(next, '', url.pathname + url.search + url.hash);
    return resolve();
  }

  /** In-app back; falls back to a path when the page was opened directly. */
  function back(fallback) {
    if (depth() > 0) history.back();
    else navigate(fallback, { replace: true });
  }

  function handles(pathname) {
    if (base && !pathname.startsWith(base)) return false;
    return !ignore.some((prefix) => pathname.startsWith(prefix));
  }

  document.addEventListener('click', (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const a = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download') || a.hasAttribute('data-native')) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || !handles(url.pathname)) return;
    event.preventDefault();
    navigate(url.pathname + url.search + url.hash, { replace: a.hasAttribute('data-replace') });
  });

  window.addEventListener('popstate', () => resolve({ restoreScroll: true }));
  if (!history.state || !history.state.key) history.replaceState({ key: 'root', depth: 0 }, '', location.href);

  return { navigate, back, resolve, refresh: () => resolve({ restoreScroll: true }) };
}
