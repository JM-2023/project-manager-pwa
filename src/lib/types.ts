export const TASK_STATUSES = ["inbox", "todo", "doing", "waiting", "blocked", "done", "cancelled"] as const;
export const TASK_PRIORITIES = ["low", "medium", "high", "urgent"] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export interface UserSession {
  email: string;
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

export interface Tag {
  id: string;
  user_id?: string;
  name: string;
  color?: string | null;
  created_at: string;
  updated_at: string;
  deleted_at?: string | null;
  version: number;
}

export interface TaskTag {
  task_id: string;
  tag_id: string;
  user_id?: string;
  created_at: string;
  deleted_at?: string | null;
}

export interface BootstrapResponse {
  serverTime: string;
  projects: Project[];
  tasks: Task[];
  tags: Tag[];
  taskTags: TaskTag[];
  settings: Record<string, unknown>;
}

export type MutationEntity = "project" | "task" | "tag" | "task_tag" | "setting";
export type MutationOperation = "upsert" | "delete";

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
  tags?: string[];
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

export interface BackupLog {
  id: string;
  format: string;
  row_count: number;
  r2_key: string | null;
  created_at: string;
}

export interface CloudExcelState {
  etag: string | null;
  key: string | null;
  updatedAt: string | null;
  size: number | null;
}

export interface CloudExcelUploadResponse {
  ok: true;
  key: string;
  archiveKey: string;
  etag: string;
  updatedAt: string;
}
