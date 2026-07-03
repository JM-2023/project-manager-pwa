export const TASK_STATUSES = ["inbox", "todo", "doing", "waiting", "blocked", "done", "cancelled"] as const;
export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export interface UserSession {
  email: string;
}

export interface AuthStatusResponse {
  authMode: string;
  needsSetup: boolean;
}

export interface SessionResponse {
  user: UserSession;
  serverTime: string;
  schemaVersion: number;
  features: {
    r2Backups: boolean;
    excelAutosync?: boolean;
    authMode: string;
  };
}

export interface Project {
  id: string;
  user_id?: string;
  name: string;
  description?: string | null;
  color?: string | null;
  sort_order: number;
  archived: number;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
  version: number;
}

export interface Task {
  id: string;
  user_id?: string;
  project_id?: string | null;
  title: string;
  description?: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due_date?: string | null;
  start_date?: string | null;
  completed_at?: string | null;
  next_action?: string | null;
  notes?: string | null;
  sort_order: number;
  parent_task_id?: string | null;
  source: string;
  external_key?: string | null;
  extra_json?: string | null;
  archived: number;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
  version: number;
}

// Next-page idea board. These rows live in their own tables (next_projects /
// next_ideas) and are intentionally independent of the formal `projects` and
// `tasks` data — see docs/next-page-data-separation-guideline.md.
export interface NextProject {
  id: string;
  user_id?: string;
  name: string;
  description?: string | null;
  color?: string | null;
  sort_order: number;
  // source_project_id is migration metadata only — never a live UI link.
  source_project_id?: string | null;
  archived: number;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
  version: number;
}

export interface NextIdea {
  id: string;
  user_id?: string;
  next_project_id: string;
  title: string;
  note?: string | null;
  sort_order: number;
  // source_task_id is migration metadata only — never a live UI link.
  source_task_id?: string | null;
  extra_json?: string | null;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
  version: number;
}

export interface BootstrapResponse {
  serverTime: string;
  projects: Project[];
  tasks: Task[];
  nextProjects: NextProject[];
  nextIdeas: NextIdea[];
  settings: Record<string, unknown>;
}

export type MutationEntity = "project" | "task" | "setting" | "next_project" | "next_idea";
// "purge" is an irreversible hard delete (row removed, no tombstone). Used for
// project deletion, which cascades to the project's tasks and their task_tags.
export type MutationOperation = "upsert" | "delete" | "purge";

export interface ClientMutation<T = unknown> {
  id: string;
  entity: MutationEntity;
  operation: MutationOperation;
  baseVersion?: number | null;
  data: T;
  createdAt?: string;
}

export interface MutationResult {
  id: string;
  entity: MutationEntity;
  recordId: string;
  version?: number;
  updated_at?: string;
}

export interface MutationConflict {
  id: string;
  entity: MutationEntity;
  recordId?: string;
  reason: string;
  permanent?: boolean;
  serverRecord?: unknown;
}

export interface MutationsResponse {
  ok: boolean;
  serverTime: string;
  applied: MutationResult[];
  conflicts: MutationConflict[];
}

export interface ImportRow {
  id?: string;
  external_key?: string;
  source?: string;
  project?: string;
  title: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  due_date?: string | null;
  start_date?: string | null;
  next_action?: string | null;
  notes?: string | null;
  description?: string | null;
  extra_json?: Record<string, unknown>;
}

export interface ImportResponse {
  ok: boolean;
  batchId: string;
  created: number;
  updated: number;
  skipped: number;
}

export interface ExportDataResponse extends BootstrapResponse {
  exportedAt: string;
}

export interface RestoreResponse {
  ok: true;
  projects: number;
  tasks: number;
  nextProjects: number;
  nextIdeas: number;
}

export interface BackupLog {
  id: string;
  format: string;
  row_count: number;
  r2_key: string | null;
  created_at: string;
}

export interface CloudExcelUploadResponse {
  ok: true;
  key: string;
  archiveKey: string;
  etag: string;
  updatedAt: string;
}
