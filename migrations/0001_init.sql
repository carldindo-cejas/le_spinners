-- Le Spinners Recreational Hub — initial schema
-- Times: *_at columns are epoch milliseconds (UTC). Booking dates are local
-- (Asia/Manila) 'YYYY-MM-DD' strings; start_min/end_min are minutes from local midnight.
-- Money: centavos (₱500 = 50000).

-- ── People and sign-in ──────────────────────────────────────────────────────

CREATE TABLE users (
  id            TEXT PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name          TEXT NOT NULL,
  phone         TEXT,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'player' CHECK (role IN ('player', 'staff', 'admin')),
  membership    TEXT NOT NULL DEFAULT 'none' CHECK (membership IN ('none', 'pending', 'member')),
  member_code   TEXT,
  member_until  TEXT,
  status        TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled')),
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- Only the SHA-256 of the session token is stored; the token lives in an HttpOnly cookie.
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  user_agent   TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- Fixed-window counters for sign-in / registration throttling.
CREATE TABLE rate_limits (
  key          TEXT PRIMARY KEY,
  count        INTEGER NOT NULL,
  window_start INTEGER NOT NULL
);

-- ── Facility ───────────────────────────────────────────────────────────────

CREATE TABLE resources (
  id                TEXT PRIMARY KEY,
  activity          TEXT NOT NULL CHECK (activity IN ('pickleball', 'table_tennis')),
  name              TEXT NOT NULL,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  status            TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'maintenance', 'disabled')),
  maintenance_note  TEXT,
  maintenance_until TEXT,
  price_member      INTEGER NOT NULL CHECK (price_member >= 0),
  price_non_member  INTEGER NOT NULL CHECK (price_non_member >= 0),
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

-- Facility-wide weekly hours. weekday: 0 = Sunday … 6 = Saturday.
CREATE TABLE opening_hours (
  weekday   INTEGER PRIMARY KEY CHECK (weekday BETWEEN 0 AND 6),
  is_open   INTEGER NOT NULL DEFAULT 1 CHECK (is_open IN (0, 1)),
  open_min  INTEGER NOT NULL CHECK (open_min BETWEEN 0 AND 1440),
  close_min INTEGER NOT NULL CHECK (close_min BETWEEN 0 AND 1440)
);

-- Special unavailable dates. resource_id NULL = every resource; start/end NULL = all day.
CREATE TABLE closures (
  id          TEXT PRIMARY KEY,
  date        TEXT NOT NULL,
  resource_id TEXT REFERENCES resources(id) ON DELETE CASCADE,
  start_min   INTEGER,
  end_min     INTEGER,
  reason      TEXT,
  created_by  TEXT REFERENCES users(id),
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_closures_date ON closures(date);

-- ── Bookings ───────────────────────────────────────────────────────────────

CREATE TABLE bookings (
  id             TEXT PRIMARY KEY,
  ref            TEXT NOT NULL UNIQUE,
  user_id        TEXT NOT NULL REFERENCES users(id),
  resource_id    TEXT NOT NULL REFERENCES resources(id),
  date           TEXT NOT NULL,
  start_min      INTEGER NOT NULL,
  end_min        INTEGER NOT NULL,
  status         TEXT NOT NULL CHECK (status IN ('TEMPORARY', 'PAYMENT_SUBMITTED', 'CONFIRMED', 'EXPIRED', 'REJECTED', 'CANCELLED', 'COMPLETED')),
  amount_due     INTEGER NOT NULL,
  rate           TEXT NOT NULL CHECK (rate IN ('member', 'non_member')),
  hold_expires_at INTEGER,          -- TEMPORARY: payment window end; REJECTED: resubmit window end
  warned_at      INTEGER,           -- 2-minute warning sent
  submitted_at   INTEGER,
  confirmed_at   INTEGER,
  confirmed_by   TEXT REFERENCES users(id),
  rejected_at    INTEGER,
  rejected_by    TEXT REFERENCES users(id),
  reject_reason  TEXT,
  cancelled_at   INTEGER,
  cancelled_by   TEXT REFERENCES users(id),
  cancel_reason  TEXT,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  CHECK (end_min > start_min)
);

-- Backstop against double booking: one active booking per resource slot.
CREATE UNIQUE INDEX uq_bookings_active_slot
  ON bookings(resource_id, date, start_min)
  WHERE status IN ('TEMPORARY', 'PAYMENT_SUBMITTED', 'CONFIRMED', 'REJECTED');
CREATE INDEX idx_bookings_user ON bookings(user_id, date, start_min);
CREATE INDEX idx_bookings_day ON bookings(date, resource_id, start_min);
CREATE INDEX idx_bookings_status ON bookings(status, hold_expires_at);

-- Timeline + audit trail for each booking.
CREATE TABLE booking_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  type       TEXT NOT NULL,
  actor_id   TEXT REFERENCES users(id),
  actor_role TEXT NOT NULL CHECK (actor_role IN ('player', 'staff', 'system')),
  note       TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_events_booking ON booking_events(booking_id, created_at);

CREATE TABLE payment_proofs (
  id             TEXT PRIMARY KEY,
  booking_id     TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  user_id        TEXT NOT NULL REFERENCES users(id),
  r2_key         TEXT NOT NULL UNIQUE,
  content_type   TEXT NOT NULL,
  size           INTEGER NOT NULL,
  original_name  TEXT,
  gcash_ref      TEXT,
  amount_claimed INTEGER,
  status         TEXT NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'approved', 'rejected')),
  created_at     INTEGER NOT NULL
);
CREATE INDEX idx_proofs_booking ON payment_proofs(booking_id, created_at);

-- ── Booking chat ───────────────────────────────────────────────────────────

CREATE TABLE messages (
  id          TEXT PRIMARY KEY,
  booking_id  TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  sender_id   TEXT REFERENCES users(id),
  sender_role TEXT NOT NULL CHECK (sender_role IN ('player', 'staff', 'system')),
  kind        TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'system', 'proof')),
  body        TEXT NOT NULL,
  proof_id    TEXT REFERENCES payment_proofs(id),
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_messages_booking ON messages(booking_id, created_at);

-- Read markers: one for the player, one shared by staff.
CREATE TABLE message_reads (
  booking_id   TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  reader       TEXT NOT NULL CHECK (reader IN ('player', 'staff')),
  last_read_at INTEGER NOT NULL,
  PRIMARY KEY (booking_id, reader)
);

-- ── Notifications ──────────────────────────────────────────────────────────

-- audience 'user' → one player's inbox; audience 'staff' → shared staff notification center.
CREATE TABLE notifications (
  id          TEXT PRIMARY KEY,
  audience    TEXT NOT NULL CHECK (audience IN ('user', 'staff')),
  user_id     TEXT REFERENCES users(id) ON DELETE CASCADE,
  booking_id  TEXT REFERENCES bookings(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  link        TEXT,
  read_at     INTEGER,
  resolved_at INTEGER,
  created_at  INTEGER NOT NULL
);
CREATE INDEX idx_notifications_user ON notifications(audience, user_id, created_at);
CREATE INDEX idx_notifications_booking ON notifications(booking_id, type);

-- Email/SMS queue. Without a provider configured, rows stay 'queued'.
CREATE TABLE outbox (
  id         TEXT PRIMARY KEY,
  channel    TEXT NOT NULL CHECK (channel IN ('email', 'sms')),
  recipient  TEXT NOT NULL,
  subject    TEXT,
  body       TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'sent', 'failed')),
  attempts   INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  booking_id TEXT REFERENCES bookings(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL,
  sent_at    INTEGER
);
CREATE INDEX idx_outbox_status ON outbox(status, created_at);

-- ── Settings and audit ─────────────────────────────────────────────────────

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by TEXT REFERENCES users(id)
);

CREATE TABLE audit_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id   TEXT,
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  TEXT,
  detail     TEXT,
  ip         TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_audit_created ON audit_log(created_at);

-- ── Defaults every install needs ───────────────────────────────────────────

INSERT INTO settings (key, value, updated_at) VALUES
  ('facility_name', 'Le Spinners Recreational Hub', 0),
  ('facility_address', '[Facility address, City]', 0),
  ('gcash_name', 'Le Spinners Recreational Hub', 0),
  ('gcash_number', '0917 123 4567', 0),
  ('booking_window_days', '14', 0),
  ('hold_minutes', '10', 0),
  ('warn_minutes', '2', 0),
  ('resubmit_minutes', '10', 0),
  ('cancel_cutoff_hours', '24', 0),
  ('slot_minutes', '60', 0),
  ('staff_alert_emails', '', 0),
  ('staff_alert_sms', '', 0);

-- Mon–Thu 4–10 PM, Fri 4–11 PM, Sat 8 AM–11 PM, Sun 8 AM–10 PM.
INSERT INTO opening_hours (weekday, is_open, open_min, close_min) VALUES
  (0, 1, 480, 1320),
  (1, 1, 960, 1320),
  (2, 1, 960, 1320),
  (3, 1, 960, 1320),
  (4, 1, 960, 1320),
  (5, 1, 960, 1380),
  (6, 1, 480, 1380);
