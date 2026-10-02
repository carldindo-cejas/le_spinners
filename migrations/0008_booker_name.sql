-- The name of the person a console booking is for, typed by staff or an admin when
-- they book on site (required by the console from now on). The booking still
-- belongs to the staff account (user_id), so this is a reference only: the
-- console shows it as the customer, and searches it.
--
--   booker_name  NULL for online bookings, and for console bookings made before
--                this migration.

ALTER TABLE bookings ADD COLUMN booker_name TEXT;
