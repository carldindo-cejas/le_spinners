-- Who made a booking, and how it was paid.
--   source          'online' — the player booked in the app
--                   'staff' / 'admin' — booked in a console (the role at the time it was made)
--   created_by      the account that made the booking (the player for online bookings)
--   payment_method  'gcash'   — GCash screenshot verified by staff (the online flow)
--                   'on_site' — paid at the front desk; confirmed when the booking is made
--                   'none'    — no charge (e.g. a staff member's personal booking)
-- Bookings can now span several consecutive slots; end_min already allows that.

ALTER TABLE bookings ADD COLUMN source TEXT NOT NULL DEFAULT 'online' CHECK (source IN ('online', 'staff', 'admin'));
ALTER TABLE bookings ADD COLUMN created_by TEXT REFERENCES users(id);
ALTER TABLE bookings ADD COLUMN payment_method TEXT NOT NULL DEFAULT 'gcash' CHECK (payment_method IN ('gcash', 'on_site', 'none'));

UPDATE bookings SET created_by = user_id WHERE created_by IS NULL;
