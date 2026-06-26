import type {
  BackupLog,
  BootstrapResponse,
  CloudExcelState,
  CloudExcelUploadResponse,
  ClientMutation,
  ExportDataResponse,
  ImportResponse,
  ImportRow,
  MutationsResponse,
  SessionResponse
} from "./types";

export class AuthRequiredError extends Error {
  constructor() {
    super("Authentication required");
  }
}

async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const response = await fetch(path, {
    credentials: "same-origin",
    ...init,
    headers
  });

  if (response.status === 401) {
    throw new AuthRequiredError();
  }

  if (!response.ok) {
    const details = (await response.json().catch(() => ({ error: response.statusText }))) as { error?: string };
    throw new Error(String(details.error ?? response.statusText));
  }

  return response.json() as Promise<T>;
}

export function getSession(): Promise<SessionResponse> {
  return apiFetch<SessionResponse>("/api/session");
}

export function login(password: string): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>("/api/auth/login", {
    method: "POST",
    body: JSON.stringify({ password })
  });
}

export function logout(): Promise<{ ok: true }> {
  return apiFetch<{ ok: true }>("/api/auth/logout", { method: "POST" });
}

export function bootstrap(since?: string | null): Promise<BootstrapResponse> {
  const query = since ? `?since=${encodeURIComponent(since)}` : "";
  return apiFetch<BootstrapResponse>(`/api/bootstrap${query}`);
}

export function sendMutations(clientId: string, mutations: ClientMutation[]): Promise<MutationsResponse> {
  return apiFetch<MutationsResponse>("/api/mutations", {
    method: "POST",
    body: JSON.stringify({ clientId, mutations })
  });
}

const IMPORT_CHUNK_SIZE = 40;

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

export function getExportData(): Promise<ExportDataResponse> {
  return apiFetch<ExportDataResponse>("/api/export-data");
}

export async function getCloudExcelState(): Promise<CloudExcelState | null> {
  const response = await fetch("/api/excel-state", {
    method: "HEAD",
    credentials: "same-origin"
  });
  if (response.status === 401) throw new AuthRequiredError();
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(response.statusText || "Cloud Excel status failed");
  }

  return {
    etag: response.headers.get("ETag"),
    key: response.headers.get("X-R2-Key"),
    updatedAt: response.headers.get("X-Excel-Updated-At"),
    size: Number(response.headers.get("X-Excel-Size") ?? "") || null
  };
}

export async function downloadCloudExcel(): Promise<Blob | null> {
  const response = await fetch("/api/excel-state", {
    method: "GET",
    credentials: "same-origin"
  });
  if (response.status === 401) throw new AuthRequiredError();
  if (response.status === 404) return null;
  if (!response.ok) {
    throw new Error(response.statusText || "Cloud Excel download failed");
  }
  return response.blob();
}

export async function uploadCloudExcel(file: Blob, filename: string, rowCount: number): Promise<CloudExcelUploadResponse> {
  const response = await fetch("/api/excel-state", {
    method: "POST",
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "X-File-Name": filename,
      "X-Row-Count": String(rowCount)
    },
    body: file,
    credentials: "same-origin"
  });
  if (response.status === 401) throw new AuthRequiredError();
  if (!response.ok) {
    const details = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new Error(details?.error ?? "Cloud Excel upload failed");
  }
  return response.json();
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
    throw new Error(details?.error ?? "Backup upload failed");
  }
  return response.json();
}

export function listBackups(): Promise<{ backups: BackupLog[] }> {
  return apiFetch<{ backups: BackupLog[] }>("/api/backups");
}
