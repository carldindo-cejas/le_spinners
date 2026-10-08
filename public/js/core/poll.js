/** One request at a time, paused in hidden/offline/idle tabs, with failure backoff. */
export function poll(fn, ms, { immediate = false, idleMs = 300_000, maxBackoffMs = 300_000 } = {}) {
  let timer = null;
  let stopped = false;
  let inFlight = false;
  let failures = 0;
  let lastActivity = Date.now();
  const available = () => !stopped && !document.hidden && navigator.onLine !== false && Date.now() - lastActivity < idleMs;
  const cancel = () => { clearTimeout(timer); timer = null; };
  const schedule = () => {
    cancel();
    if (available()) timer = setTimeout(run, Math.min(ms * 2 ** failures, Math.max(ms, maxBackoffMs)));
  };
  const run = async () => {
    if (!available() || inFlight) return;
    cancel();
    inFlight = true;
    try { await fn(); failures = 0; }
    catch (err) { failures = Math.min(failures + 1, 8); console.warn('poll failed', err); }
    finally { inFlight = false; if (!stopped) schedule(); }
  };
  const wake = () => {
    cancel();
    if (!document.hidden && navigator.onLine !== false) { lastActivity = Date.now(); run(); }
  };
  const activity = () => {
    const wasIdle = Date.now() - lastActivity >= idleMs;
    lastActivity = Date.now();
    if (wasIdle) run();
    else if (!inFlight && timer === null) schedule();
  };
  const events = ['pointerdown', 'keydown', 'scroll'];
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('online', wake);
  window.addEventListener('offline', cancel);
  for (const event of events) document.addEventListener(event, activity, { passive: true });
  if (immediate) run(); else schedule();
  return () => {
    stopped = true;
    cancel();
    document.removeEventListener('visibilitychange', wake);
    window.removeEventListener('online', wake);
    window.removeEventListener('offline', cancel);
    for (const event of events) document.removeEventListener(event, activity);
  };
}
