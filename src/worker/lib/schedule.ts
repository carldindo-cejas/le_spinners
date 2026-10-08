import { conflict } from './errors';
import type { SessionUser } from '../types';
import { authorizedBatch } from './authorized-mutations';

/** Capture BEFORE the reads used to decide a booking/schedule mutation. */
export async function scheduleVersion(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT version FROM schedule_revision WHERE id = 1').first<{ version: number }>();
  if (!row) throw new Error('Missing schedule revision; apply database migrations.');
  return row.version;
}

/** Booking INSERT rechecks occupancy atomically; only its configuration reads need a revision guard. */
export async function bookingConfigurationVersion(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT version FROM booking_configuration_revision WHERE id = 1').first<{ version: number }>();
  if (!row) throw new Error('Missing booking configuration revision; apply database migrations.');
  return row.version;
}

/** Unrelated holds, payment transitions and cron work must not reject a free slot. */
export async function bookingConfigurationBatch(db: D1Database, version: number, statements: D1PreparedStatement[], actor?: SessionUser): Promise<D1Result[]> {
  try {
    const batch = [
      db.prepare('UPDATE booking_configuration_revision SET version = CASE WHEN version = ? THEN version ELSE -1 END WHERE id = 1').bind(version),
      ...statements,
    ];
    const results = actor ? await authorizedBatch(db, actor, batch) : await db.batch(batch);
    return results.slice(1);
  } catch (error) {
    if (String(error).includes('booking_configuration_revision_nonnegative')) {
      throw conflict('SCHEDULE_CHANGED', 'Facility settings changed. Reload the available times, then try again.');
    }
    throw error;
  }
}

/**
 * Fail the entire D1 transaction if any schedule writer ran after planning.
 * The CHECK deliberately aborts, so neither the mutation nor its effects commit.
 * D1 batches are transactional: https://developers.cloudflare.com/d1/worker-api/d1-database/#batch
 * The revision is facility-wide: safe false conflicts are preferable to omitted
 * bookings. Measure contention before replacing it with narrower scope revisions.
 */
export async function scheduleBatch(db: D1Database, version: number, statements: D1PreparedStatement[], actor?: SessionUser): Promise<D1Result[]> {
  try {
    const batch = [
      db.prepare('UPDATE schedule_revision SET version = CASE WHEN version = ? THEN version ELSE -1 END WHERE id = 1').bind(version),
      ...statements,
    ];
    const results = actor ? await authorizedBatch(db, actor, batch) : await db.batch(batch);
    return results.slice(1);
  } catch (error) {
    if (String(error).includes('schedule_revision_nonnegative')) {
      throw conflict('SCHEDULE_CHANGED', 'Bookings or facility settings changed. Reload the available times or affected bookings, then try again.');
    }
    throw error;
  }
}
