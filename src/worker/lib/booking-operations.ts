import { newId, sha256Hex } from './crypto';
import { conflict } from './errors';

/** HTTP callers must supply a key. Omission is only for one-off internal calls. */
export async function bookingOperation(db: D1Database, actorId: string, kind: 'player' | 'console', key: string | undefined, payload: unknown) {
  const idempotencyKey = key ?? newId('op_');
  const hash = await sha256Hex(JSON.stringify(payload));
  const replay = async (): Promise<string | null> => {
    const row = await db.prepare(`SELECT request_hash, booking_id FROM booking_operations
      WHERE actor_id = ? AND kind = ? AND idempotency_key = ?`)
      .bind(actorId, kind, idempotencyKey).first<{ request_hash: string; booking_id: string }>();
    if (!row) return null;
    if (row.request_hash !== hash) throw conflict('IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different booking. Start a new booking request.');
    return row.booking_id;
  };
  return {
    replay,
    statement: (bookingId: string, now: number) => db.prepare(`
      INSERT INTO booking_operations (actor_id, kind, idempotency_key, request_hash, booking_id, created_at)
      SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM bookings WHERE id = ?)`)
      .bind(actorId, kind, idempotencyKey, hash, bookingId, now, bookingId),
  };
}
