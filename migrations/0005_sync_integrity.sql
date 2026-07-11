-- Monotonic per-user synchronization state. Wall-clock timestamps remain useful
-- display metadata, while `seq` is the only incremental-sync cursor.
CREATE TABLE IF NOT EXISTS sync_state (
  user_id TEXT PRIMARY KEY,
  epoch TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  last_operation_id TEXT,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

INSERT OR IGNORE INTO sync_state (user_id, epoch, seq, last_operation_id)
SELECT id, lower(hex(randomblob(16))), 0, NULL
FROM users;

ALTER TABLE projects ADD COLUMN sync_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE tasks ADD COLUMN sync_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE next_projects ADD COLUMN sync_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE next_ideas ADD COLUMN sync_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE app_settings ADD COLUMN sync_seq INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_projects_user_sync_seq ON projects(user_id, sync_seq);
CREATE INDEX IF NOT EXISTS idx_tasks_user_sync_seq ON tasks(user_id, sync_seq);
CREATE INDEX IF NOT EXISTS idx_next_projects_user_sync_seq ON next_projects(user_id, sync_seq);
CREATE INDEX IF NOT EXISTS idx_next_ideas_user_sync_seq ON next_ideas(user_id, sync_seq);
CREATE INDEX IF NOT EXISTS idx_app_settings_user_sync_seq ON app_settings(user_id, sync_seq);

-- Import de-duplication hot paths. These keep a five-row import within the D1
-- Free query budget without turning each lookup into a user-wide table scan.
CREATE INDEX IF NOT EXISTS idx_projects_user_name_deleted ON projects(user_id, name, deleted_at);
CREATE INDEX IF NOT EXISTS idx_tasks_import_identity
  ON tasks(user_id, source, title, project_id, start_date, due_date, deleted_at, updated_at DESC);

-- Login throttling is deliberately durable across isolate restarts.
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  window_started TEXT NOT NULL,
  blocked_until TEXT,
  updated_at TEXT NOT NULL,
  last_reservation_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_updated_at ON auth_rate_limits(updated_at);

-- A restore chunk can be re-delivered after D1 committed but the HTTP response
-- was lost. Store its response in the same transaction as the restored rows so
-- a retry returns the original result without replaying the backup over newer
-- edits from another device.
CREATE TABLE IF NOT EXISTS processed_restore_chunks (
  user_id TEXT NOT NULL,
  restore_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  projects_count INTEGER NOT NULL DEFAULT 0,
  tasks_count INTEGER NOT NULL DEFAULT 0,
  next_projects_count INTEGER NOT NULL DEFAULT 0,
  next_ideas_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, restore_id, chunk_index),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Foreign keys prove that a project id exists, but older writes could still
-- leave a live task pointing at another user's project or at a tombstone. Keep
-- the task as unassigned so a full bootstrap never contains a child whose
-- project is absent.
UPDATE tasks AS child
SET project_id = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    version = version + 1,
    sync_seq = 0
WHERE deleted_at IS NULL
  AND project_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM projects AS parent
    WHERE parent.id = child.project_id
      AND parent.user_id = child.user_id
      AND parent.deleted_at IS NULL
  );

-- next_ideas.next_project_id is required, so an invalid live idea cannot be
-- detached. Tombstone it before the live/same-owner trigger is installed.
UPDATE next_ideas AS child
SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    version = version + 1,
    sync_seq = 0
WHERE deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM next_projects AS parent
    WHERE parent.id = child.next_project_id
      AND parent.user_id = child.user_id
      AND parent.deleted_at IS NULL
  );

-- Older clients could also persist self references, cross-owner references,
-- or references to deleted/missing task parents because parent_task_id had no
-- foreign key. Normalize those rows before enforcing the live-parent invariant.
UPDATE tasks AS child
SET parent_task_id = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    version = version + 1,
    sync_seq = 0
WHERE parent_task_id IS NOT NULL AND (
  parent_task_id = id OR NOT EXISTS (
    SELECT 1 FROM tasks AS parent
    WHERE parent.id = child.parent_task_id
      AND parent.user_id = child.user_id
      AND parent.deleted_at IS NULL
  )
);

-- The remaining live graph has valid edges, but older writes could still have
-- formed multi-node cycles. Detach each node that participates in a cycle;
-- UNION de-duplicates visited (start, ancestor) pairs and guarantees that the
-- recursive walk terminates even on corrupt data.
WITH RECURSIVE ancestry(start_id, user_id, current_id) AS (
  SELECT id, user_id, parent_task_id
  FROM tasks
  WHERE parent_task_id IS NOT NULL AND deleted_at IS NULL
  UNION
  SELECT ancestry.start_id, ancestry.user_id, parent.parent_task_id
  FROM ancestry
  JOIN tasks AS parent
    ON parent.id = ancestry.current_id
   AND parent.user_id = ancestry.user_id
  WHERE parent.parent_task_id IS NOT NULL AND parent.deleted_at IS NULL
), cycle_nodes AS (
  SELECT DISTINCT start_id
  FROM ancestry
  WHERE current_id = start_id
)
UPDATE tasks
SET parent_task_id = NULL,
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    version = version + 1,
    sync_seq = 0
WHERE id IN (SELECT start_id FROM cycle_nodes);

CREATE INDEX IF NOT EXISTS idx_tasks_live_parent
  ON tasks(user_id, parent_task_id)
  WHERE parent_task_id IS NOT NULL AND deleted_at IS NULL;

-- The original schema's single-column foreign keys ensure that a parent ID
-- exists, but do not ensure that parent and child belong to the same owner.
CREATE TRIGGER IF NOT EXISTS trg_tasks_project_owner_insert
BEFORE INSERT ON tasks
WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM projects
  WHERE id = NEW.project_id AND user_id = NEW.user_id AND deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'task project owner mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_project_owner_update
BEFORE UPDATE OF project_id, user_id ON tasks
WHEN NEW.project_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM projects
  WHERE id = NEW.project_id AND user_id = NEW.user_id AND deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'task project owner mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_next_ideas_project_owner_insert
BEFORE INSERT ON next_ideas
WHEN NOT EXISTS (
  SELECT 1 FROM next_projects
  WHERE id = NEW.next_project_id AND user_id = NEW.user_id AND deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'next idea project owner mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_next_ideas_project_owner_update
BEFORE UPDATE OF next_project_id, user_id ON next_ideas
WHEN NOT EXISTS (
  SELECT 1 FROM next_projects
  WHERE id = NEW.next_project_id AND user_id = NEW.user_id AND deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'next idea project owner mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_parent_owner_insert
BEFORE INSERT ON tasks
WHEN NEW.parent_task_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM tasks
  WHERE id = NEW.parent_task_id AND user_id = NEW.user_id AND deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'task parent owner mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_parent_owner_update
BEFORE UPDATE OF parent_task_id, user_id ON tasks
WHEN NEW.parent_task_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM tasks
  WHERE id = NEW.parent_task_id AND user_id = NEW.user_id AND deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'task parent owner mismatch');
END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_parent_cycle_insert
BEFORE INSERT ON tasks
WHEN NEW.parent_task_id IS NOT NULL AND EXISTS (
  WITH RECURSIVE ancestors(id) AS (
    SELECT NEW.parent_task_id
    UNION
    SELECT parent.parent_task_id
    FROM tasks AS parent
    JOIN ancestors ON parent.id = ancestors.id
    WHERE parent.user_id = NEW.user_id
      AND parent.deleted_at IS NULL
      AND parent.parent_task_id IS NOT NULL
  )
  SELECT 1 FROM ancestors WHERE id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'task parent cycle');
END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_parent_cycle_update
BEFORE UPDATE OF parent_task_id, user_id ON tasks
WHEN NEW.parent_task_id IS NOT NULL AND EXISTS (
  WITH RECURSIVE ancestors(id) AS (
    SELECT NEW.parent_task_id
    UNION
    SELECT parent.parent_task_id
    FROM tasks AS parent
    JOIN ancestors ON parent.id = ancestors.id
    WHERE parent.user_id = NEW.user_id
      AND parent.deleted_at IS NULL
      AND parent.parent_task_id IS NOT NULL
  )
  SELECT 1 FROM ancestors WHERE id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'task parent cycle');
END;

-- Keep live children valid when any code path tombstones or purges a task.
-- Project cascades are covered because they update/delete task rows too.
CREATE TRIGGER IF NOT EXISTS trg_tasks_parent_detach_after_soft_delete
AFTER UPDATE OF deleted_at ON tasks
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL
BEGIN
  UPDATE tasks
  SET parent_task_id = NULL,
      updated_at = NEW.updated_at,
      version = version + 1,
      sync_seq = NEW.sync_seq
  WHERE user_id = NEW.user_id
    AND parent_task_id = NEW.id
    AND deleted_at IS NULL;
END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_parent_detach_after_purge
AFTER DELETE ON tasks
BEGIN
  UPDATE tasks
  SET parent_task_id = NULL,
      updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
      version = version + 1,
      sync_seq = COALESCE(
        (SELECT seq FROM sync_state WHERE user_id = OLD.user_id),
        sync_seq
      )
  WHERE user_id = OLD.user_id
    AND parent_task_id = OLD.id
    AND deleted_at IS NULL;
END;
