CREATE TABLE IF NOT EXISTS next_projects (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  color TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  source_project_id TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (source_project_id) REFERENCES projects(id)
);

CREATE INDEX IF NOT EXISTS idx_next_projects_user_updated ON next_projects(user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_next_projects_user_archived ON next_projects(user_id, archived);
CREATE INDEX IF NOT EXISTS idx_next_projects_source_project ON next_projects(user_id, source_project_id);

CREATE TABLE IF NOT EXISTS next_ideas (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  next_project_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  note TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  source_task_id TEXT,
  extra_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (next_project_id) REFERENCES next_projects(id)
);

CREATE INDEX IF NOT EXISTS idx_next_ideas_user_updated ON next_ideas(user_id, updated_at);
CREATE INDEX IF NOT EXISTS idx_next_ideas_project_sort ON next_ideas(next_project_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_next_ideas_source_task ON next_ideas(user_id, source_task_id);

INSERT OR IGNORE INTO next_projects (
  id,
  user_id,
  name,
  description,
  color,
  sort_order,
  source_project_id,
  archived,
  created_at,
  updated_at,
  deleted_at,
  version
)
SELECT
  'next-project:' || p.id,
  p.user_id,
  p.name,
  p.description,
  p.color,
  p.sort_order,
  p.id,
  0,
  MIN(t.created_at),
  MAX(t.updated_at),
  NULL,
  1
FROM projects p
JOIN tasks t ON t.project_id = p.id
WHERE
  t.deleted_at IS NULL
  AND t.archived = 0
  AND (
    t.source = 'project_cache'
    OR instr(COALESCE(t.extra_json, ''), '项目缓存') > 0
    OR instr(COALESCE(t.extra_json, ''), 'cache_item') > 0
  )
GROUP BY p.id;

INSERT OR IGNORE INTO next_ideas (
  id,
  user_id,
  next_project_id,
  title,
  note,
  sort_order,
  source_task_id,
  extra_json,
  created_at,
  updated_at,
  deleted_at,
  version
)
SELECT
  'next-idea:' || t.id,
  t.user_id,
  'next-project:' || t.project_id,
  t.title,
  COALESCE(t.notes, t.description),
  t.sort_order,
  t.id,
  t.extra_json,
  t.created_at,
  t.updated_at,
  NULL,
  1
FROM tasks t
WHERE
  t.deleted_at IS NULL
  AND t.archived = 0
  AND t.project_id IS NOT NULL
  AND (
    t.source = 'project_cache'
    OR instr(COALESCE(t.extra_json, ''), '项目缓存') > 0
    OR instr(COALESCE(t.extra_json, ''), 'cache_item') > 0
  )
  AND EXISTS (
    SELECT 1
    FROM next_projects np
    WHERE np.id = 'next-project:' || t.project_id
  );

DELETE FROM task_tags
WHERE task_id IN (
  SELECT source_task_id
  FROM next_ideas
  WHERE source_task_id IS NOT NULL
);

DELETE FROM task_events
WHERE task_id IN (
  SELECT source_task_id
  FROM next_ideas
  WHERE source_task_id IS NOT NULL
);

DELETE FROM tasks
WHERE id IN (
  SELECT source_task_id
  FROM next_ideas
  WHERE source_task_id IS NOT NULL
);
