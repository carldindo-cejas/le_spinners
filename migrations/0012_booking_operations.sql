-- Creation identity and its booking/effects commit together. Retain for the lifetime
-- of the booking; do not prune keys independently of booking retention policy.
CREATE TABLE booking_operations (
  actor_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('player', 'console')),
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  booking_id TEXT NOT NULL UNIQUE REFERENCES bookings(id),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (actor_id, kind, idempotency_key)
);

-- LIMIT bounds the changed rows. These indexes also bound candidate discovery
-- across closed history; staging row-read metrics must still verify the plans.
CREATE INDEX idx_maintenance_expiry ON bookings(hold_expires_at, id)
  WHERE status IN ('TEMPORARY', 'REJECTED');
CREATE INDEX idx_maintenance_warning ON bookings(hold_expires_at, id)
  WHERE status = 'TEMPORARY' AND warned_at IS NULL;
CREATE INDEX idx_maintenance_completion ON bookings(date, end_min, id)
  WHERE status = 'CONFIRMED';
CREATE INDEX idx_maintenance_deferred ON disruption_items(disruption_id, booking_id)
  WHERE outcome = 'deferred';
CREATE INDEX idx_rate_limits_window ON rate_limits(window_start, key);
