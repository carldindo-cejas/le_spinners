/** Route ownership and session generations. No credentials or response data live here. */
let current = null;
let authController = new AbortController();
let authGeneration = 0;
const elementScopes = new WeakMap();
export const setElementScope = (element, scope) => elementScopes.set(element, scope);
export function elementScope(element) {
  for (let node = element; node; node = node.parentNode) if (elementScopes.has(node)) return elementScopes.get(node);
  return current;
}
export const abortError = () => new DOMException('This view is no longer active.', 'AbortError');
export const isAbort = error => error?.name === 'AbortError';
export const currentScope = () => current;
export const setCurrentScope = scope => { current = scope; };

export function createScope(parent = null) {
  const controller = new AbortController();
  const sessionSignal = authController.signal;
  const disposers = new Set();
  const scope = {
    signal: controller.signal,
    isCurrent: () => !controller.signal.aborted && !sessionSignal.aborted && (!parent || parent.isCurrent()),
    assertCurrent() { if (!scope.isCurrent()) throw abortError(); },
    own(dispose) {
      let done = false;
      const cleanup = () => {
        if (done) return;
        done = true;
        disposers.delete(cleanup);
        try { dispose(); } catch (error) { console.error(error); }
      };
      if (scope.isCurrent()) disposers.add(cleanup); else cleanup();
      return cleanup;
    },
    dispose() {
      if (controller.signal.aborted) return;
      controller.abort();
      for (const dispose of [...disposers]) dispose();
    },
  };
  if (parent) {
    const detach = parent.own(() => scope.dispose());
    scope.own(detach);
  }
  if (scope.isCurrent()) {
    sessionSignal.addEventListener('abort', scope.dispose, { once: true });
    scope.own(() => sessionSignal.removeEventListener('abort', scope.dispose));
  }
  return scope;
}

export function advanceAuth() {
  authGeneration++;
  authController.abort();
  authController = new AbortController();
}

/** Combine caller, route and session cancellation, including already completed fetches. */
export function requestGuard({ signal, scope = currentScope() } = {}) {
  const controller = new AbortController();
  const generation = authGeneration;
  const sources = [...new Set([signal, scope?.signal, authController.signal].filter(Boolean))];
  const abort = () => controller.abort();
  for (const source of sources) {
    if (source.aborted) abort();
    else source.addEventListener('abort', abort, { once: true });
  }
  return {
    signal: controller.signal,
    check() {
      if (controller.signal.aborted || generation !== authGeneration || (scope && !scope.isCurrent())) throw abortError();
    },
    release() { for (const source of sources) source.removeEventListener('abort', abort); },
  };
}

/** Identity changes invalidate old API work; profile edits for the same identity do not. */
export function sessionState(initial, onChange) {
  let user = initial.user;
  Object.defineProperty(initial, 'user', { enumerable: true, get: () => user, set(next) {
    const changed = user?.id !== next?.id || user?.role !== next?.role;
    user = next;
    if (changed) { advanceAuth(); onChange?.(); }
  } });
  return initial;
}
