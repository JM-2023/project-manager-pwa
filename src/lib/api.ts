import type {
  AuthStatusResponse,
  BackupLog,
  BootstrapResponse,
  CloudExcelUploadResponse,
  ClientMutation,
  ExportDataResponse,
  ImportResponse,
  ImportRow,
  MutationsResponse,
  RestoreResponse,
  SessionResponse,
  Task
} from "./types";

export class AuthRequiredError extends Error {
  constructor() {
    super("Authentication required");
  }
}

export class ApiResponseError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = "ApiResponseError";
  }

  get retryable(): boolean {
    return this.status === 408 || this.status === 409 || this.status === 425 || this.status === 429 || this.status >= 500;
  }
}

const API_TIMEOUT_MS = 15_000;
// A full bootstrap (first run, forced resync, epoch rotation after a purge)
// streams the entire dataset; on a slow link the default deadline would abort
// it, and the sync engine's retry starts another full pull — a loop that never
// completes. Delta pulls share the budget harmlessly: they finish early.
const BOOTSTRAP_TIMEOUT_MS = 60_000;

async function apiFetch<T>(path: string, init: RequestInit = {}, timeoutMs = API_TIMEOUT_MS): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
  const abortFromCaller = () => controller.abort(init.signal?.reason);
  if (init.signal?.aborted) controller.abort(init.signal.reason);
  else init.signal?.addEventListener("abort", abortFromCaller, { once: true });
  try {
    const response = await fetch(path, {
      credentials: "same-origin",
      ...init,
      headers,
      signal: controller.signal
    });

    if (response.status === 401) {
      throw new AuthRequiredError();
    }

    if (!response.ok) {
      const details = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string };
      throw new ApiResponseError(String(details.error ?? response.statusText), response.status);
    }

    return await response.json() as T;
  } finally {
    // Keep both cancellation sources attached until the response body has
    // finished. fetch() may resolve as soon as headers arrive while a large
    // JSON body is still streaming.
    window.clearTimeout(timeout);
    init.signal?.removeEventListener("abort", abortFromCaller);
  }
}

export function getSession(): Promise<SessionResponse> {
  return apiFetch<SessionResponse>("/api/session");
}

export function getAuthStatus(): Promise<AuthStatusResponse> {
  return apiFetch<AuthStatusResponse>("/api/auth/status");
}

export function login(password: string): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ password })
  });
}

export function setupPassword(password: string, setupToken: string): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>("/api/auth/setup", {
    method: "POST",
    body: JSON.stringify({ password, setupToken })
  });
}

export function changePassword(currentPassword: string, newPassword: string): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>("/api/auth/change-password", {
    method: "POST",
    body: JSON.stringify({ currentPassword, newPassword })
  });
}

export function logout(): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>("/api/auth/logout", { method: "POST" });
}

export function bootstrap(syncEpoch?: string | null, syncCursor?: number | null): Promise<BootstrapResponse> {
  const params = new URLSearchParams();
  if (syncEpoch) params.set("epoch", syncEpoch);
  if (syncCursor !== null && syncCursor !== undefined) params.set("cursor", String(syncCursor));
  const query = params.size > 0 ? `?${params.toString()}` : "";
  return apiFetch<BootstrapResponse>(`/api/bootstrap${query}`, {}, BOOTSTRAP_TIMEOUT_MS);
}

export function sendMutations(clientId: string, mutations: ClientMutation[]): Promise<MutationsResponse> {
  return apiFetch<MutationsResponse>("/api/mutations", {
    method: "POST",
    body: JSON.stringify({ clientId, mutations })
  });
}

const IMPORT_CHUNK_SIZE = 5;

export async function importRows(filename: string, rows: ImportRow[], mode = "create_or_update"): Promise<ImportResponse> {
  const chunks: ImportRow[][] = [];
  for (let index = 0; index < rows.length; index += IMPORT_CHUNK_SIZE) {
    chunks.push(rows.slice(index, index + IMPORT_CHUNK_SIZE));
  }

  const responses: ImportResponse[] = [];
  for (const chunk of chunks) {
    responses.push(
      await apiFetch<ImportResponse>("/api/import", {
        method: "POST",
        body: JSON.stringify({ filename, mode, rows: chunk })
      })
    );
  }

  return {
    ok: true,
    batchId: responses.map((response) => response.batchId).join(","),
    created: responses.reduce((total, response) => total + response.created, 0),
    updated: responses.reduce((total, response) => total + response.updated, 0),
    skipped: responses.reduce((total, response) => total + response.skipped, 0)
  };
}

export function getExportData(signal?: AbortSignal): Promise<ExportDataResponse> {
  return apiFetch<ExportDataResponse>("/api/export-data", { signal });
}

const RESTORE_CHUNK_SIZE = 20;

/**
 * Keep every in-backup parent ahead of its descendants before the task list is
 * split into restore requests. References to parents outside this backup stay
 * valid candidates because the restore endpoint may already have those rows.
 */
export function orderRestoreTasksParentFirst(tasks: Task[]): Task[] {
  const byId = new Map<string, Task>();
  for (const task of tasks) {
    if (byId.has(task.id)) throw new Error(`Invalid backup: duplicate task id ${task.id}`);
    byId.set(task.id, task);
  }

  const inDegree = new Map(tasks.map((task) => [task.id, 0]));
  const children = new Map<string, string[]>();
  for (const task of tasks) {
    const parentId = task.parent_task_id;
    if (!parentId || !byId.has(parentId)) continue;
    inDegree.set(task.id, (inDegree.get(task.id) ?? 0) + 1);
    const siblings = children.get(parentId) ?? [];
    siblings.push(task.id);
    children.set(parentId, siblings);
  }

  const ready = tasks.filter((task) => inDegree.get(task.id) === 0).map((task) => task.id);
  const ordered: Task[] = [];
  let readyIndex = 0;
  while (readyIndex < ready.length) {
    const id = ready[readyIndex++];
    ordered.push(byId.get(id)!);
    const descendants = children.get(id) ?? [];
    for (const childId of descendants) {
      const remaining = (inDegree.get(childId) ?? 0) - 1;
      inDegree.set(childId, remaining);
      if (remaining === 0) ready.push(childId);
    }
  }

  if (ordered.length !== tasks.length) {
    const cyclicIds = tasks.filter((task) => (inDegree.get(task.id) ?? 0) > 0).map((task) => task.id);
    throw new Error(`Invalid backup: cyclic task parents (${cyclicIds.join(", ")})`);
  }
  return ordered;
}

/** Merge a JSON backup in parent-first, D1-Free-safe atomic request chunks. */
export async function restoreData(
  data: Pick<BootstrapResponse, "projects" | "tasks" | "nextProjects" | "nextIdeas">,
  signal?: AbortSignal
): Promise<RestoreResponse> {
  type RestoreChunk = Pick<BootstrapResponse, "projects" | "tasks" | "nextProjects" | "nextIdeas">;
  const orderedData = { ...data, tasks: orderRestoreTasksParentFirst(data.tasks) };
  const chunks: RestoreChunk[] = [];
  const empty = (): RestoreChunk => ({ projects: [], tasks: [], nextProjects: [], nextIdeas: [] });
  for (const key of ["projects", "tasks", "nextProjects", "nextIdeas"] as const) {
    for (let index = 0; index < orderedData[key].length; index += RESTORE_CHUNK_SIZE) {
      const chunk = empty();
      (chunk[key] as typeof orderedData[typeof key]) = orderedData[key].slice(index, index + RESTORE_CHUNK_SIZE);
      chunks.push(chunk);
    }
  }

  const restoreId = crypto.randomUUID();
  const total: RestoreResponse = { ok: true, projects: 0, tasks: 0, nextProjects: 0, nextIdeas: 0 };
  for (let index = 0; index < chunks.length; index += 1) {
    const request = () =>
      apiFetch<RestoreResponse>("/api/restore", {
        method: "POST",
        body: JSON.stringify({ ...chunks[index], restoreId, chunkIndex: index }),
        signal
      });
    let response: RestoreResponse;
    try {
      response = await request();
    } catch (error) {
      // A lost response can happen after D1 committed the idempotent upserts.
      // Retry network/timeout failures with the same stable restore chunk id.
      if (signal?.aborted) throw signal.reason ?? new DOMException("Restore aborted", "AbortError");
      if (!(error instanceof TypeError) && !(error instanceof DOMException && error.name === "AbortError")) throw error;
      response = await request();
    }
    total.projects += response.projects;
    total.tasks += response.tasks;
    total.nextProjects += response.nextProjects;
    total.nextIdeas += response.nextIdeas;
  }
  return total;
}

export async function uploadCloudExcel(
  file: Blob,
  filename: string,
  rowCount: number,
  sourceSyncEpoch: string,
  sourceSyncCursor: number,
  signal?: AbortSignal
): Promise<CloudExcelUploadResponse> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30_000);
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) controller.abort(signal.reason);
  else signal?.addEventListener("abort", abortFromCaller, { once: true });
  try {
    const response = await fetch("/api/excel-state", {
      method: "POST",
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "X-File-Name": filename,
        "X-Row-Count": String(rowCount),
        "X-Source-Sync-Epoch": sourceSyncEpoch,
        "X-Source-Sync-Cursor": String(sourceSyncCursor)
      },
      body: file,
      credentials: "same-origin",
      signal: controller.signal
    });
    if (response.status === 401) throw new AuthRequiredError();
    if (!response.ok) {
      const details = (await response.json().catch(() => null)) as { error?: string } | null;
      throw new ApiResponseError(details?.error ?? "Cloud Excel upload failed", response.status);
    }
    return await response.json() as CloudExcelUploadResponse;
  } finally {
    window.clearTimeout(timeout);
    signal?.removeEventListener("abort", abortFromCaller);
  }
}

export async function uploadBackup(file: Blob, filename: string): Promise<{ ok: true; id: string; r2Key: string }> {
  const response = await fetch("/api/backups", {
    method: "POST",
    headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "X-File-Name": filename },
    body: file,
    credentials: "same-origin"
  });
  if (response.status === 401) throw new AuthRequiredError();
  if (!response.ok) {
    const details = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ApiResponseError(details?.error ?? "Backup upload failed", response.status);
  }
  return response.json();
}

export function listBackups(): Promise<{ backups: BackupLog[] }> {
  return apiFetch<{ backups: BackupLog[] }>("/api/backups");
}
