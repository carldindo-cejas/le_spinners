import type { Bindings } from '../types';
import { completePast, sweepExpired, warnExpiringHolds } from './bookings';
import { reconcileCreditHolds } from './credits';
import { closeUnpaidDeferred } from './disruptions';
import { flushOutbox } from './notify';
import { reconcileUploads } from './storage';
import { loadSettings } from './settings';
import { HOUSEKEEPING_BATCH_SIZE } from './limits';
import { DAY_MS } from './time';

type Task = [name: string, run: () => Promise<unknown>];

/**
 * Time-driven work: expire lapsed holds, warn holds that are about to lapse,
 * complete past bookings, and (from cron) send queued email and tidy tables.
 * Each task is isolated so one failure doesn't stop the others.
 */
export async function runMaintenance(env: Bindings, now = Date.now(), opts: { cron?: boolean } = {}) {
  const settings = await loadSettings(env.DB);
  const tasks: Task[] = [
    ['expired', () => sweepExpired(env, now)],
    ['warned', () => warnExpiringHolds(env, settings, now)],
    ['completed', () => completePast(env, now)],
  ];
  if (opts.cron) {
    // Safety nets: every path that ends a hold already returns its credit in the same batch.
    tasks.push(['creditsReturned', () => reconcileCreditHolds(env, now)]);
    tasks.push(['deferredClosed', () => closeUnpaidDeferred(env, now)]);
    tasks.push(['outbox', () => flushOutbox(env)]);
    tasks.push(['uploads', () => reconcileUploads(env)]);
    if (new Date(now).getUTCMinutes() === 0) tasks.push(['housekeeping', () => housekeeping(env, now)]);
  }
  const report: Record<string, unknown> = {};
  for (const [name, run] of tasks) {
    try {
      report[name] = await run();
    } catch (err) {
      console.error(JSON.stringify({ msg: 'maintenance task failed', task: name, err: String(err) }));
      report[name] = 'error';
    }
  }
  return report;
}

let lastLazyRun = 0;
const LAZY_EVERY_MS = 15_000;

/**
 * Also run the transitions from busy read paths (throttled per isolate), so
 * holds expire and warnings go out on time even between cron ticks and in
 * local development where cron doesn't fire on its own.
 */
export function lazyMaintenance(env: Bindings, now = Date.now()): Promise<unknown> {
  if (now - lastLazyRun < LAZY_EVERY_MS) return Promise.resolve();
  lastLazyRun = now;
  return runMaintenance(env, now).catch((err) => console.error('lazy maintenance failed', err));
}

async function housekeeping(env: Bindings, now: number) {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM sessions WHERE id IN (SELECT id FROM sessions WHERE expires_at < ? ORDER BY expires_at LIMIT ?)').bind(now, HOUSEKEEPING_BATCH_SIZE),
    env.DB.prepare('DELETE FROM rate_limits WHERE key IN (SELECT key FROM rate_limits WHERE window_start < ? ORDER BY window_start LIMIT ?)').bind(now - DAY_MS, HOUSEKEEPING_BATCH_SIZE),
  ]);
  return 'ok';
}
