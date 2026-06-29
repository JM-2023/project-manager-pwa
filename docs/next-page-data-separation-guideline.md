# Next Page Data Separation Guideline

## Goal

The Next page is an independent idea board. Its projects and ideas must be stored separately from the formal Projects page and the worklog task table.

This means:

- The Next page must not list rows from the `projects` table.
- The Next page must not store ideas as `tasks` rows with `source = "project_cache"`.
- Creating, renaming, deleting, or reordering a Next project must never mutate the formal `projects` table.
- Creating, editing, or deleting a Next idea must never mutate the formal `tasks` table.
- The formal Projects page remains the owner of real projects and real task progress.

## Production Data Privacy

Do not commit production row counts, project names, imported workbook samples, or migration verification snapshots. Keep this document limited to schema and behavior rules.

## Database Schema

### `next_projects`

Use this table for project-like buckets shown only on the Next page.

Important columns:

```sql
id TEXT PRIMARY KEY
user_id TEXT NOT NULL
name TEXT NOT NULL
description TEXT
color TEXT
sort_order INTEGER NOT NULL DEFAULT 0
source_project_id TEXT
archived INTEGER NOT NULL DEFAULT 0
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
deleted_at TEXT
version INTEGER NOT NULL DEFAULT 1
```

`source_project_id` is migration metadata only. Do not use it as a live link in the UI. A Next project may have the same display name as a formal project, but it is a separate object.

### `next_ideas`

Use this table for ideas or future tasks shown only on the Next page.

Important columns:

```sql
id TEXT PRIMARY KEY
user_id TEXT NOT NULL
next_project_id TEXT NOT NULL
title TEXT NOT NULL DEFAULT ''
note TEXT
sort_order INTEGER NOT NULL DEFAULT 0
source_task_id TEXT
extra_json TEXT
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
deleted_at TEXT
version INTEGER NOT NULL DEFAULT 1
```

`source_task_id` is migration metadata only. Do not use it as a live link in the UI.

## Frontend Behavior

### Next Page

The Next page should render only from:

- `nextProjects`
- `nextIdeas`

It should not derive its project sections from `projects`.

Each Next project section should support:

- Rename project.
- Delete project.
- Add idea.
- Delete idea.
- Edit idea text.
- Optional: reorder ideas.

Each idea only needs one main text field. A note field can be added later, but it should not be required for v1.

### Create Next Project

When the user taps the plus button on the Next page:

1. Create a local `NextProject` row immediately.
2. Generate a client UUID.
3. Give it a default name such as `New idea group` if the user has not typed a name yet.
4. Queue a `next_project` upsert mutation.
5. Sync in the same batched local-first queue used by tasks.

### Delete Next Project

Deleting a Next project must delete only:

- The row in `next_projects`.
- Its child rows in `next_ideas`.

It must not delete anything from:

- `projects`
- `tasks`
- `task_tags`
- `task_events`

The UI should remove the project and its ideas immediately from local state, then queue a server mutation.

### Create Next Idea

When the user adds an idea:

1. Create a local `NextIdea` row immediately.
2. Generate a client UUID.
3. Set `next_project_id` to the selected Next project.
4. Queue a `next_idea` upsert mutation.

### Delete Next Idea

Deleting an idea must delete only that `next_ideas` row.

It must not delete a formal task.

## API Contract

The cleanest implementation is to extend the existing bootstrap and mutation model instead of adding a second sync system.

### Bootstrap

Extend `GET /api/bootstrap` to include:

```ts
{
  nextProjects: NextProject[];
  nextIdeas: NextIdea[];
}
```

Because Next data is small, always return all live Next rows during bootstrap. This lets hard deletes sync cleanly across devices without keeping long-lived soft-deleted rows.

Filtering rules:

```sql
SELECT * FROM next_projects
WHERE user_id = ? AND deleted_at IS NULL AND archived = 0
ORDER BY sort_order, name;

SELECT * FROM next_ideas
WHERE user_id = ? AND deleted_at IS NULL
ORDER BY sort_order, created_at;
```

### Mutations

Extend `POST /api/mutations` with two new entities:

```ts
type MutationEntity =
  | "project"
  | "task"
  | "tag"
  | "task_tag"
  | "setting"
  | "next_project"
  | "next_idea";
```

Supported operations:

- `upsert`
- `purge`

For Next entities, use hard delete semantics in production D1:

- `purge next_idea`: delete from `next_ideas`.
- `purge next_project`: delete child `next_ideas`, then delete from `next_projects`.

The response should follow the existing mutation response shape:

```ts
{
  ok: true,
  serverTime: string,
  applied: [
    {
      id: string,
      entity: "next_project" | "next_idea",
      recordId: string,
      version?: number,
      updated_at?: string
    }
  ],
  conflicts: []
}
```

### Validation

For `next_project` upsert, allow only:

- `id`
- `name`
- `description`
- `color`
- `sort_order`
- `archived`

For `next_idea` upsert, allow only:

- `id`
- `next_project_id`
- `title`
- `note`
- `sort_order`
- `extra_json`

Server rules:

- Always set `user_id` from the authenticated session.
- Always set `updated_at` on the server.
- Increment `version` on every update.
- Reject `next_idea` if `next_project_id` does not belong to the current user.
- Do not accept `source_project_id` or `source_task_id` from the frontend. Those are migration fields.

## Local Cache and Sync

Add two IndexedDB collections:

- `nextProjects`
- `nextIdeas`

The Next page should be local-first:

1. Render from IndexedDB immediately.
2. Apply local edits immediately.
3. Queue mutations.
4. Push mutations in batches.
5. Refresh the full Next dataset from bootstrap after successful sync.

Because hard deletes have no tombstones, the client should treat the server's `nextProjects` and `nextIdeas` arrays as the authoritative live set whenever there are no pending local Next mutations.

If a local Next entity has pending mutations, keep the local copy until the server confirms the mutation.

## Search

Search may include Next ideas, but they should be displayed as a separate result type.

Recommended grouping:

- Tasks
- Projects
- Next ideas

Do not mix Next ideas into task progress calculations.

## Excel Import and Export

Do not import Next ideas automatically from the worklog workbook.

For export, add optional worksheets:

- `Next Projects`
- `Next Ideas`

Do not write Next ideas into the main `Tasks` worksheet.

## Important UI Rule

The label shown in Next can match a formal project name, but it is still independent.

Example:

- Formal project: `shared-label` in `projects`
- Next project: `shared-label` in `next_projects`

Deleting the Next project must not affect the formal project.

Deleting the formal project must not affect the Next project unless the user explicitly chooses a separate cleanup action.
