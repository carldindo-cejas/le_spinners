import { createScope, isAbort, setCurrentScope } from './lifecycle.js';
import { localTarget } from './navigation.js';
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

/** Routes with `absolute: true` live outside `base` (e.g. /revenue/ in the admin console). */
export function createRouter({ routes, notFound, base = '', ignore = [], beforeView }) {
  const compiled = routes.map((r) => ({ ...r, ...compile(r.absolute ? r.path : base + r.path) }));
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
    const scope = createScope();
    setCurrentScope(scope);
    // Ownership exists before calling the async view, so early listeners/requests
    // can be disposed even while initial loading is still pending.
    current = { cleanup: () => scope.dispose() };
    const route = match || { view: notFound, name: 'not-found' };
    const ctx = {
      params,
      query: url.searchParams,
      path,
      route,
      state: history.state || {},
      ...scope,
      isCurrent: () => id === navId && scope.isCurrent(),
    };
    let result;
    try {
      if (!beforeView?.(ctx)) result = await route.view(ctx);
    } catch (err) {
      if (!isAbort(err)) console.error(err);
      scope.dispose();
    }
    if (id !== navId) {
      if (typeof result === 'function') scope.own(result);
      return;
    }
    if (typeof result === 'function') scope.own(result);
    if (!scope.isCurrent()) return;
    const key = history.state && history.state.key;
    let anchor = null;
    try { anchor = url.hash && document.getElementById(decodeURIComponent(url.hash.slice(1))); } catch { /* malformed fragment */ }
    if (anchor) anchor.scrollIntoView();
    else window.scrollTo(0, restoreScroll && key && scrollPositions.has(key) ? scrollPositions.get(key) : 0);
  }

  function saveScroll() {
    const key = history.state && history.state.key;
    if (key) scrollPositions.set(key, window.scrollY);
  }

  function navigate(to, { replace = false, state = {} } = {}) {
    const target = localTarget(to, { allowPath: handles }) || `${base}/`;
    saveScroll();
    const next = { ...state, key: Math.random().toString(36).slice(2), depth: replace ? depth() : depth() + 1 };
    if (replace) history.replaceState(next, '', target);
    else history.pushState(next, '', target);
    return resolve();
  }

  /** In-app back; falls back to a path when the page was opened directly. */
  function back(fallback) {
    if (depth() > 0) history.back();
    else navigate(fallback, { replace: true });
  }

  function handles(pathname) {
    if (base && pathname !== base && !pathname.startsWith(base + '/') && !compiled.some((r) => r.absolute && r.re.test(pathname))) return false;
    return !ignore.some((prefix) => prefix.endsWith('/') ? pathname.startsWith(prefix) : pathname === prefix || pathname.startsWith(prefix + '/'));
  }

  const onClick = (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const a = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!a || (a.target && a.target !== '_self') || a.hasAttribute('download') || a.hasAttribute('data-native')) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || !handles(url.pathname)) return;
    // Let same-page section links scroll without tearing down the active view.
    if (url.hash && url.pathname === location.pathname && url.search === location.search) return;
    event.preventDefault();
    navigate(url.pathname + url.search + url.hash, { replace: a.hasAttribute('data-replace') });
  };
  document.addEventListener('click', onClick);

  const onPop = () => resolve({ restoreScroll: true });
  window.addEventListener('popstate', onPop);
  if (!history.state || !history.state.key) history.replaceState({ key: 'root', depth: 0 }, '', location.href);

  return { navigate, back, resolve, refresh: () => resolve({ restoreScroll: true }),
    invalidate() { navId++; current?.cleanup(); current = null; setCurrentScope(null); },
    dispose() { navId++; current?.cleanup(); current = null; setCurrentScope(null); document.removeEventListener('click', onClick); window.removeEventListener('popstate', onPop); },
  };
}
