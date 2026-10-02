-- Booking disruptions, operator cancellations and booking credits (see REBOOKING.md).
--
--   disruptions          one row per staff/admin action: some bookings cancelled or credited
--                        (kind 'bookings'), or a time window closed on some courts or tables
--                        (kind 'window'). Every operator cancellation has one, even for one booking.
--   disruption_items     what happened to each affected booking, with the inputs of the credit
--                        calculation (minutes booked and affected, value paid)
--   booking_credits      a credit owed to a player: value issued, value left, where it came from.
--                        `remaining` is always recomputed from the ledger, never adjusted by hand.
--   credit_transactions  append-only ledger of every change to a credit (issue, redeem, release,
--                        void, refund…). SUM(amount) per credit = booking_credits.remaining.
--
-- Bookings gain:
--   credit_applied       credit value used to pay for the booking. amount_due stays the CASH part
--                        (what GCash or the front desk collects), so revenue keeps counting cash
--                        only. payment_method 'none' with credit_applied > 0 = paid with credit.
--   compensated_amount   value already credited back for this booking (never more than it was paid)
--   disruption_id        the disruption that last changed this booking
-- Closures gain disruption_id when a disruption created them.
--
-- Money is in centavos. No existing column or CHECK constraint changes, so no table rebuild.

CREATE TABLE disruptions (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN ('bookings', 'window')),
  category        TEXT NOT NULL CHECK (category IN ('weather', 'unsafe_conditions', 'maintenance', 'equipment_failure',
                                                    'emergency', 'facility_error', 'customer_request', 'other')),
  reason          TEXT NOT NULL,
  staff_note      TEXT,
  date            TEXT,
  start_min       INTEGER,
  end_min         INTEGER,
  activity        TEXT CHECK (activity IN ('pickleball', 'table_tennis')),
  resource_id     TEXT REFERENCES resources(id),
  effective_from  INTEGER,
  compensation    TEXT NOT NULL DEFAULT 'credit' CHECK (compensation IN ('credit', 'none')),
  created_by      TEXT NOT NULL REFERENCES users(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  request_hash    TEXT NOT NULL,
  item_count      INTEGER NOT NULL DEFAULT 0,
  credited_total  INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL,
  CHECK (kind = 'bookings' OR (date IS NOT NULL AND start_min IS NOT NULL AND end_min > start_min))
);
CREATE INDEX idx_disruptions_created ON disruptions(created_at);
CREATE INDEX idx_disruptions_date ON disruptions(date) WHERE date IS NOT NULL;

CREATE TABLE booking_credits (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL REFERENCES users(id),
  origin            TEXT NOT NULL CHECK (origin IN ('disruption', 'manual')),
  source_booking_id TEXT REFERENCES bookings(id),
  disruption_id     TEXT REFERENCES disruptions(id),
  amount            INTEGER NOT NULL CHECK (amount > 0),
  remaining         INTEGER NOT NULL CHECK (remaining >= 0 AND remaining <= amount),
  state             TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'expired', 'voided')),
  expires_at        INTEGER,
  reason            TEXT NOT NULL,
  created_by        TEXT REFERENCES users(id),
  idempotency_key   TEXT UNIQUE,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  UNIQUE (source_booking_id, disruption_id),
  CHECK (origin = 'manual' OR (source_booking_id IS NOT NULL AND disruption_id IS NOT NULL))
);
CREATE INDEX idx_credits_user ON booking_credits(user_id, state, remaining);
CREATE INDEX idx_credits_created ON booking_credits(created_at);

CREATE TABLE disruption_items (
  disruption_id     TEXT NOT NULL REFERENCES disruptions(id),
  booking_id        TEXT NOT NULL REFERENCES bookings(id),
  user_id           TEXT NOT NULL REFERENCES users(id),
  planned_action    TEXT NOT NULL CHECK (planned_action IN ('cancel', 'keep', 'defer')),
  outcome           TEXT NOT NULL CHECK (outcome IN ('pending', 'cancelled', 'partial', 'deferred', 'skipped')),
  skip_reason       TEXT,
  status_before     TEXT NOT NULL,
  version_before    INTEGER NOT NULL,
  booked_min        INTEGER NOT NULL,
  affected_min      INTEGER NOT NULL,
  affected_segments TEXT NOT NULL,
  paid_value        INTEGER NOT NULL,
  credit_amount     INTEGER NOT NULL DEFAULT 0 CHECK (credit_amount >= 0),
  flags             TEXT,
  where_label       TEXT NOT NULL,
  created_at        INTEGER NOT NULL,
  resolved_at       INTEGER,
  PRIMARY KEY (disruption_id, booking_id)
);
CREATE INDEX idx_disruption_items_booking ON disruption_items(booking_id);
CREATE INDEX idx_disruption_items_open ON disruption_items(outcome) WHERE outcome IN ('pending', 'deferred', 'skipped');

CREATE TABLE credit_transactions (
  id             TEXT PRIMARY KEY,
  credit_id      TEXT NOT NULL REFERENCES booking_credits(id),
  user_id        TEXT NOT NULL REFERENCES users(id),
  kind           TEXT NOT NULL CHECK (kind IN ('issue', 'redeem', 'release', 'expire', 'adjust', 'void', 'refund')),
  amount         INTEGER NOT NULL,
  booking_id     TEXT REFERENCES bookings(id),
  related_txn_id TEXT REFERENCES credit_transactions(id),
  actor_id       TEXT REFERENCES users(id),
  actor_role     TEXT NOT NULL CHECK (actor_role IN ('player', 'staff', 'system')),
  note           TEXT,
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_credit_txn_credit ON credit_transactions(credit_id, created_at);
CREATE INDEX idx_credit_txn_booking ON credit_transactions(booking_id, kind);
CREATE UNIQUE INDEX uq_credit_issue ON credit_transactions(credit_id) WHERE kind = 'issue';
CREATE UNIQUE INDEX uq_credit_release ON credit_transactions(related_txn_id) WHERE kind = 'release';

ALTER TABLE bookings ADD COLUMN credit_applied INTEGER NOT NULL DEFAULT 0 CHECK (credit_applied >= 0);
ALTER TABLE bookings ADD COLUMN compensated_amount INTEGER NOT NULL DEFAULT 0 CHECK (compensated_amount >= 0);
ALTER TABLE bookings ADD COLUMN disruption_id TEXT REFERENCES disruptions(id);
CREATE INDEX idx_bookings_disruption ON bookings(disruption_id) WHERE disruption_id IS NOT NULL;

ALTER TABLE closures ADD COLUMN disruption_id TEXT REFERENCES disruptions(id);
CREATE INDEX idx_closures_disruption ON closures(disruption_id) WHERE disruption_id IS NOT NULL;
