-- Read-only preflight for migration 0019. This query must return zero rows.
-- Review bookings for every listed resource before choosing a repair.
SELECT activity, MIN(name) AS resource_name, COUNT(*) AS duplicate_count,
       json_group_array(id) AS resource_ids
  FROM resources
 GROUP BY activity, name COLLATE NOCASE
HAVING COUNT(*) > 1;
