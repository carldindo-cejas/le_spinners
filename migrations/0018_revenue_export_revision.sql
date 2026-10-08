-- A monotonic export revision covers every table used by the ledger query.
-- Triggers share the writer's transaction: a failed batch rolls the revision back.
-- Metadata and CSV rows are read in one D1 batch; later parts detect any committed
-- source change, including equal-millisecond updates and customer/facility renames.
CREATE TABLE revenue_export_revision (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
);
INSERT INTO revenue_export_revision(id, revision) VALUES (1, 0);

CREATE TRIGGER revenue_revision_bookings_insert
AFTER INSERT ON bookings
BEGIN
  UPDATE revenue_export_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER revenue_revision_bookings_update
AFTER UPDATE ON bookings
BEGIN
  UPDATE revenue_export_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER revenue_revision_bookings_delete
AFTER DELETE ON bookings
BEGIN
  UPDATE revenue_export_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER revenue_revision_booking_slots_insert
AFTER INSERT ON booking_slots
BEGIN
  UPDATE revenue_export_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER revenue_revision_booking_slots_update
AFTER UPDATE ON booking_slots
BEGIN
  UPDATE revenue_export_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER revenue_revision_booking_slots_delete
AFTER DELETE ON booking_slots
BEGIN
  UPDATE revenue_export_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER revenue_revision_users_insert
AFTER INSERT ON users
BEGIN
  UPDATE revenue_export_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER revenue_revision_users_update
AFTER UPDATE ON users
BEGIN
  UPDATE revenue_export_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER revenue_revision_users_delete
AFTER DELETE ON users
BEGIN
  UPDATE revenue_export_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER revenue_revision_resources_insert
AFTER INSERT ON resources
BEGIN
  UPDATE revenue_export_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER revenue_revision_resources_update
AFTER UPDATE ON resources
BEGIN
  UPDATE revenue_export_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER revenue_revision_resources_delete
AFTER DELETE ON resources
BEGIN
  UPDATE revenue_export_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER revenue_revision_payment_proofs_insert
AFTER INSERT ON payment_proofs
BEGIN
  UPDATE revenue_export_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER revenue_revision_payment_proofs_update
AFTER UPDATE ON payment_proofs
BEGIN
  UPDATE revenue_export_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER revenue_revision_payment_proofs_delete
AFTER DELETE ON payment_proofs
BEGIN
  UPDATE revenue_export_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER revenue_revision_booking_credits_insert
AFTER INSERT ON booking_credits
BEGIN
  UPDATE revenue_export_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER revenue_revision_booking_credits_update
AFTER UPDATE ON booking_credits
BEGIN
  UPDATE revenue_export_revision SET revision = revision + 1 WHERE id = 1;
END;

CREATE TRIGGER revenue_revision_booking_credits_delete
AFTER DELETE ON booking_credits
BEGIN
  UPDATE revenue_export_revision SET revision = revision + 1 WHERE id = 1;
END;

