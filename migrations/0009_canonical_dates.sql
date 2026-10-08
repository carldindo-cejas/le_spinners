-- Reject new noncanonical dates without rewriting historical rows. Run the
-- read-only readiness inventory and review historical corrections separately.
-- '+0 days' forces SQLite to normalize e.g. November 31 before comparing.
CREATE TRIGGER bookings_date_insert BEFORE INSERT ON bookings
WHEN NEW.date IS NULL OR length(NEW.date) != 10 OR date(NEW.date, '+0 days') IS NOT NEW.date
BEGIN SELECT RAISE(ABORT, 'invalid_calendar_date'); END;
CREATE TRIGGER bookings_date_update BEFORE UPDATE OF date ON bookings
WHEN NEW.date IS NULL OR length(NEW.date) != 10 OR date(NEW.date, '+0 days') IS NOT NEW.date
BEGIN SELECT RAISE(ABORT, 'invalid_calendar_date'); END;
CREATE TRIGGER booking_slots_date_insert BEFORE INSERT ON booking_slots
WHEN NEW.date IS NULL OR length(NEW.date) != 10 OR date(NEW.date, '+0 days') IS NOT NEW.date
BEGIN SELECT RAISE(ABORT, 'invalid_calendar_date'); END;
CREATE TRIGGER booking_slots_date_update BEFORE UPDATE OF date ON booking_slots
WHEN NEW.date IS NULL OR length(NEW.date) != 10 OR date(NEW.date, '+0 days') IS NOT NEW.date
BEGIN SELECT RAISE(ABORT, 'invalid_calendar_date'); END;
CREATE TRIGGER closures_date_insert BEFORE INSERT ON closures
WHEN NEW.date IS NULL OR length(NEW.date) != 10 OR date(NEW.date, '+0 days') IS NOT NEW.date
BEGIN SELECT RAISE(ABORT, 'invalid_calendar_date'); END;
CREATE TRIGGER closures_date_update BEFORE UPDATE OF date ON closures
WHEN NEW.date IS NULL OR length(NEW.date) != 10 OR date(NEW.date, '+0 days') IS NOT NEW.date
BEGIN SELECT RAISE(ABORT, 'invalid_calendar_date'); END;
CREATE TRIGGER disruptions_date_insert BEFORE INSERT ON disruptions
WHEN NEW.date IS NOT NULL AND (length(NEW.date) != 10 OR date(NEW.date, '+0 days') IS NOT NEW.date)
BEGIN SELECT RAISE(ABORT, 'invalid_calendar_date'); END;
CREATE TRIGGER disruptions_date_update BEFORE UPDATE OF date ON disruptions
WHEN NEW.date IS NOT NULL AND (length(NEW.date) != 10 OR date(NEW.date, '+0 days') IS NOT NEW.date)
BEGIN SELECT RAISE(ABORT, 'invalid_calendar_date'); END;
CREATE TRIGGER resources_date_insert BEFORE INSERT ON resources
WHEN NEW.maintenance_until IS NOT NULL AND (length(NEW.maintenance_until) != 10 OR date(NEW.maintenance_until, '+0 days') IS NOT NEW.maintenance_until)
BEGIN SELECT RAISE(ABORT, 'invalid_calendar_date'); END;
CREATE TRIGGER resources_date_update BEFORE UPDATE OF maintenance_until ON resources
WHEN NEW.maintenance_until IS NOT NULL AND (length(NEW.maintenance_until) != 10 OR date(NEW.maintenance_until, '+0 days') IS NOT NEW.maintenance_until)
BEGIN SELECT RAISE(ABORT, 'invalid_calendar_date'); END;
