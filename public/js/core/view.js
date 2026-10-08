import { abortError, currentScope, isAbort } from './lifecycle.js';

/** Bind view capabilities once, before its first async boundary. */
export function createViewTools(capabilities) {
  return (context) => {
    const scope = context?.signal && context?.own ? context : currentScope();
    if (!scope) return { ...capabilities, setTimeout, setInterval };
    const active = () => scope.isCurrent();
    const own = dispose => scope.own(dispose);
    const safe = fn => (...args) => {
      if (!active()) return;
      try {
        const result = fn(...args);
        if (result?.catch) result.catch(error => { if (!isAbort(error)) console.error(error); });
        return result;
      } catch (error) { if (!isAbort(error)) console.error(error); }
    };
    const result = { scope };
    for (const [name, fn] of Object.entries(capabilities)) {
      if (name === 'api') result.api = fn.forScope(scope);
      else if (name === 'listen') result.listen = (root, type, handler, options) => active() ? fn(root, type, safe(handler), options) : () => {};
      else if (name === 'on') result.on = (root, type, selector, handler, options) => active() ? fn(root, type, selector, safe(handler), options) : () => {};
      else if (['poll', 'startCountdown', 'startCardCountdowns', 'onBadges'].includes(name)) result[name] = (...args) => active() ? own(fn(...args)) : () => {};
      else if (['show', 'frame', 'bare', 'openModal', 'openImage', 'openViewer', 'miniChat', 'openEditProfile', 'openChangePassword'].includes(name)) result[name] = (...args) => {
        if (!active()) throw abortError();
        return fn(...args);
      };
      else if (['refreshBadges', 'copyText'].includes(name)) result[name] = (...args) => {
        scope.assertCurrent();
        const promise = Promise.resolve(fn(...args)).then(value => { scope.assertCurrent(); return value; });
        // Some call sites intentionally trigger these in the background.
        promise.catch(error => { if (!isAbort(error)) console.error(error); });
        return promise;
      };
      else result[name] = (...args) => active() ? fn(...args) : name === 'toast' ? () => {} : name === 'render' ? args[0] : undefined;
    }
    result.setTimeout = (fn, delay, ...args) => {
      if (!active()) return null;
      let dispose;
      const timer = setTimeout(() => { dispose(); safe(fn)(...args); }, delay);
      dispose = own(() => clearTimeout(timer));
      return timer;
    };
    result.setInterval = (fn, delay, ...args) => {
      if (!active()) return null;
      const timer = setInterval(safe(fn), delay, ...args);
      own(() => clearInterval(timer));
      return timer;
    };
    return result;
  };
}
