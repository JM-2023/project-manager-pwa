-- A mutation ID makes request replay idempotent, but it cannot stop an older
-- create with a different mutation ID from arriving after its delete. Keep a
-- record-level deletion guard even when no entity row exists (or after purge)
-- so the normal create SQL can reject that delayed write atomically.
CREATE TABLE IF NOT EXISTS record_deletion_guards (
  user_id TEXT NOT NULL,
  entity TEXT NOT NULL CHECK (entity IN ('project', 'task', 'next_project', 'next_idea')),
  record_id TEXT NOT NULL,
  deleted_at TEXT NOT NULL,
  last_mutation_id TEXT,
  PRIMARY KEY (user_id, entity, record_id),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

-- Existing tombstones must receive the same protection immediately after the
-- migration; otherwise an old client create could still revive one of them.
INSERT OR IGNORE INTO record_deletion_guards (user_id, entity, record_id, deleted_at, last_mutation_id)
SELECT user_id, 'project', id, deleted_at, NULL FROM projects WHERE deleted_at IS NOT NULL;

INSERT OR IGNORE INTO record_deletion_guards (user_id, entity, record_id, deleted_at, last_mutation_id)
SELECT user_id, 'task', id, deleted_at, NULL FROM tasks WHERE deleted_at IS NOT NULL;

INSERT OR IGNORE INTO record_deletion_guards (user_id, entity, record_id, deleted_at, last_mutation_id)
SELECT user_id, 'next_project', id, deleted_at, NULL FROM next_projects WHERE deleted_at IS NOT NULL;

INSERT OR IGNORE INTO record_deletion_guards (user_id, entity, record_id, deleted_at, last_mutation_id)
SELECT user_id, 'next_idea', id, deleted_at, NULL FROM next_ideas WHERE deleted_at IS NOT NULL;
