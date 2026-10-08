-- A conservative facility-wide revision makes precomputed booking/schedule
-- plans safe across D1 batches. Triggers enlist every writer, including cron,
-- console bookings, disruption resolution, and maintenance scripts.
CREATE TABLE schedule_revision (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL CONSTRAINT schedule_revision_nonnegative CHECK (version >= 0)
);
INSERT INTO schedule_revision (id, version) VALUES (1, 0);

CREATE TRIGGER schedule_bookings_insert AFTER INSERT ON bookings
BEGIN UPDATE schedule_revision SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER schedule_bookings_update AFTER UPDATE ON bookings
BEGIN UPDATE schedule_revision SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER schedule_bookings_delete AFTER DELETE ON bookings
BEGIN UPDATE schedule_revision SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER schedule_slots_insert AFTER INSERT ON booking_slots
BEGIN UPDATE schedule_revision SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER schedule_slots_update AFTER UPDATE ON booking_slots
BEGIN UPDATE schedule_revision SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER schedule_slots_delete AFTER DELETE ON booking_slots
BEGIN UPDATE schedule_revision SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER schedule_resources_insert AFTER INSERT ON resources
BEGIN UPDATE schedule_revision SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER schedule_resources_update AFTER UPDATE ON resources
BEGIN UPDATE schedule_revision SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER schedule_resources_delete AFTER DELETE ON resources
BEGIN UPDATE schedule_revision SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER schedule_hours_insert AFTER INSERT ON opening_hours
BEGIN UPDATE schedule_revision SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER schedule_hours_update AFTER UPDATE ON opening_hours
BEGIN UPDATE schedule_revision SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER schedule_hours_delete AFTER DELETE ON opening_hours
BEGIN UPDATE schedule_revision SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER schedule_closures_insert AFTER INSERT ON closures
BEGIN UPDATE schedule_revision SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER schedule_closures_update AFTER UPDATE ON closures
BEGIN UPDATE schedule_revision SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER schedule_closures_delete AFTER DELETE ON closures
BEGIN UPDATE schedule_revision SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER schedule_items_insert AFTER INSERT ON disruption_items
BEGIN UPDATE schedule_revision SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER schedule_items_update AFTER UPDATE ON disruption_items
BEGIN UPDATE schedule_revision SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER schedule_items_delete AFTER DELETE ON disruption_items
BEGIN UPDATE schedule_revision SET version = version + 1 WHERE id = 1; END;
