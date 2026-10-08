-- Run scripts/audit-resource-names.sql before applying this migration.
-- Existing duplicate names fail this index creation; resolve their physical
-- resource mapping and booking history explicitly, never delete rows blindly.
-- Disabled resources retain their identity and may be re-enabled later.
CREATE UNIQUE INDEX uq_resources_activity_name
  ON resources(activity, name COLLATE NOCASE);
