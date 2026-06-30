-- task_tags previously tracked only created_at + deleted_at. Re-linking a tag
-- (deleted_at: value -> NULL via ON CONFLICT) left created_at untouched, so the
-- incremental bootstrap cursor never picked the re-link up and other live
-- devices stayed out of sync until a full cold-start bootstrap. Track updated_at
-- so every change (add, remove, re-add) advances the cursor.
ALTER TABLE task_tags ADD COLUMN updated_at TEXT;
UPDATE task_tags SET updated_at = COALESCE(deleted_at, created_at) WHERE updated_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_task_tags_user_updated ON task_tags(user_id, updated_at);

-- Server-side idempotency ledger. A mutation batch can be delivered more than
-- once (keepalive beacon on pagehide, then the regular sync on next load). The
-- mutations endpoint records every applied client mutation id here and skips any
-- it has already processed, so re-delivery never double-bumps version /
-- updated_at or re-marks the cloud Excel dirty.
CREATE TABLE IF NOT EXISTS processed_mutations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_processed_mutations_created ON processed_mutations(created_at);
