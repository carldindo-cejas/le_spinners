-- Booking creation checks occupancy, player overlap and hold limits in its
-- atomic INSERT. Its precomputed resource/hour/closure reads need a separate
-- guard so unrelated booking and cron writes do not reject distinct free slots.
-- Retain schedule_revision for facility/disruption plans: those plans must
-- detect every intervening booking and include it in their affected set.
CREATE TABLE booking_configuration_revision (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  version INTEGER NOT NULL CONSTRAINT booking_configuration_revision_nonnegative CHECK (version >= 0)
);
INSERT INTO booking_configuration_revision (id, version) VALUES (1, 0);

CREATE TRIGGER booking_configuration_resources_insert AFTER INSERT ON resources
BEGIN UPDATE booking_configuration_revision SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER booking_configuration_resources_update AFTER UPDATE ON resources
BEGIN UPDATE booking_configuration_revision SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER booking_configuration_resources_delete AFTER DELETE ON resources
BEGIN UPDATE booking_configuration_revision SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER booking_configuration_hours_insert AFTER INSERT ON opening_hours
BEGIN UPDATE booking_configuration_revision SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER booking_configuration_hours_update AFTER UPDATE ON opening_hours
BEGIN UPDATE booking_configuration_revision SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER booking_configuration_hours_delete AFTER DELETE ON opening_hours
BEGIN UPDATE booking_configuration_revision SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER booking_configuration_closures_insert AFTER INSERT ON closures
BEGIN UPDATE booking_configuration_revision SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER booking_configuration_closures_update AFTER UPDATE ON closures
BEGIN UPDATE booking_configuration_revision SET version = version + 1 WHERE id = 1; END;
CREATE TRIGGER booking_configuration_closures_delete AFTER DELETE ON closures
BEGIN UPDATE booking_configuration_revision SET version = version + 1 WHERE id = 1; END;
