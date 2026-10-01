-- Open play: a court or table that is in service but free for all. Players see it
-- in the booking flow marked OPEN PLAY, and it can't be booked.
--
--   open_play  1 = open play. Only meaningful while status = 'active'; the API
--              reports such a resource with status 'open_play'. Setting maintenance
--              or disabled clears it.
--
-- A flag rather than a new status value: SQLite can't change the CHECK on
-- resources.status without rebuilding the table, and the rebuild's implicit
-- DELETE would cascade into per-court closures.

ALTER TABLE resources ADD COLUMN open_play INTEGER NOT NULL DEFAULT 0 CHECK (open_play IN (0, 1));
