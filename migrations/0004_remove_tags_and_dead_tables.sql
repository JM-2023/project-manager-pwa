-- The tag feature was removed from the product (it never had a UI entry point),
-- so its tables go away entirely. task_events and import_batches were never
-- written by any endpoint — dead schema from the initial migration.
DROP TABLE IF EXISTS task_tags;
DROP TABLE IF EXISTS tags;
DROP TABLE IF EXISTS task_events;
DROP TABLE IF EXISTS import_batches;
