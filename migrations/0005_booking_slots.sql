-- A booking can hold several time slots on one court or table on one day, with gaps
-- between them (e.g. 4–5 PM and 7–8 PM): one booking, one payment, one reference.
--
--   booking_slots  the times a booking holds; back-to-back slots are stored as one row
--   booking_times  every booking's times: its booking_slots rows, or, for a booking
--                  with none (bookings made before this migration, seed data), its
--                  start_min–end_min block
--
-- bookings.start_min / end_min stay as the span (first start, last end) for sorting,
-- "has it started" and "is it over". Double-booking checks and availability read
-- booking_times, never the span.

CREATE TABLE booking_slots (
  booking_id  TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  resource_id TEXT NOT NULL REFERENCES resources(id),
  date        TEXT NOT NULL,
  start_min   INTEGER NOT NULL,
  end_min     INTEGER NOT NULL,
  PRIMARY KEY (booking_id, start_min),
  CHECK (end_min > start_min)
);
CREATE INDEX idx_booking_slots_day ON booking_slots(date, resource_id, start_min);

CREATE VIEW booking_times AS
  SELECT s.booking_id, s.resource_id, s.date, s.start_min, s.end_min
    FROM booking_slots s
  UNION ALL
  SELECT b.id, b.resource_id, b.date, b.start_min, b.end_min
    FROM bookings b
   WHERE NOT EXISTS (SELECT 1 FROM booking_slots s WHERE s.booking_id = b.id);
