import { authenticate, isResponse } from "./_utils/auth";
import { apiError, json, requireSameOrigin } from "./_utils/response";
import { nowIso } from "./_utils/time";
import type { AppContext } from "./_utils/types";

const LATEST_EXCEL_KEY = "latest/project-manager-latest.xlsx";
const D1_EXCEL_STATE_KEY = "cloud_excel_latest";
const EXCEL_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

interface D1ExcelState {
  dataBase64: string;
  etag: string;
  filename: string;
  updatedAt: string;
  size: number;
}

function r2ExcelStateEnabled(context: AppContext): boolean {
  return context.env.ENABLE_R2_BACKUPS === "true" && Boolean(context.env.BACKUPS);
}

function d1ExcelStateEnabled(context: AppContext): boolean {
  return context.env.ENABLE_D1_EXCEL_STATE === "true";
}

function excelStateEnabled(context: AppContext): boolean {
  return r2ExcelStateEnabled(context) || d1ExcelStateEnabled(context);
}

function datedBackupKey(timestamp: string): string {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const stamp = timestamp.replace(/[:.]/g, "-");
  return `exports/${year}/${month}/project-manager-${stamp}.xlsx`;
}

function objectHeaders(object: R2Object): Headers {
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Type", headers.get("Content-Type") ?? EXCEL_CONTENT_TYPE);
  headers.set("ETag", object.httpEtag);
  headers.set("Cache-Control", "no-store");
  headers.set("X-R2-Key", object.key);
  headers.set("X-Excel-Updated-At", object.uploaded.toISOString());
  headers.set("X-Excel-Size", String(object.size));
  return headers;
}

function d1StateHeaders(state: D1ExcelState): Headers {
  const headers = new Headers();
  headers.set("Content-Type", EXCEL_CONTENT_TYPE);
  headers.set("ETag", state.etag);
  headers.set("Cache-Control", "no-store");
  headers.set("X-R2-Key", "d1:cloud_excel_latest");
  headers.set("X-Excel-Updated-At", state.updatedAt);
  headers.set("X-Excel-Size", String(state.size));
  return headers;
}

function bytesToBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let index = 0; index < view.length; index += 0x8000) {
    binary += String.fromCharCode(...view.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

async function sha256Etag(bytes: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `"${hex}"`;
}

async function readD1ExcelState(context: AppContext, userId: string): Promise<D1ExcelState | null> {
  const row = await context.env.DB.prepare("SELECT value_json FROM app_settings WHERE user_id = ? AND key = ?")
    .bind(userId, D1_EXCEL_STATE_KEY)
    .first<{ value_json: string }>();
  return row ? (JSON.parse(row.value_json) as D1ExcelState) : null;
}

export async function onRequestHead(context: AppContext): Promise<Response> {
  const user = await authenticate(context);
  if (isResponse(user)) return user;

  if (!excelStateEnabled(context)) {
    return apiError(404, "Cloud Excel sync is disabled");
  }

  if (r2ExcelStateEnabled(context) && context.env.BACKUPS) {
    const object = await context.env.BACKUPS.head(LATEST_EXCEL_KEY);
    if (object) {
      return new Response(null, { headers: objectHeaders(object) });
    }
  }

  const d1State = await readD1ExcelState(context, user.id);
  if (!d1State) {
    return apiError(404, "Cloud Excel file not found");
  }
  return new Response(null, { headers: d1StateHeaders(d1State) });
}

export async function onRequestGet(context: AppContext): Promise<Response> {
  const user = await authenticate(context);
  if (isResponse(user)) return user;

  if (!excelStateEnabled(context)) {
    return apiError(404, "Cloud Excel sync is disabled");
  }

  if (r2ExcelStateEnabled(context) && context.env.BACKUPS) {
    const object = await context.env.BACKUPS.get(LATEST_EXCEL_KEY);
    if (object) {
      const headers = objectHeaders(object);
      headers.set("Content-Disposition", 'attachment; filename="project-manager-latest.xlsx"');
      return new Response(object.body, { headers });
    }
  }

  const d1State = await readD1ExcelState(context, user.id);
  if (!d1State) {
    return apiError(404, "Cloud Excel file not found");
  }
  const headers = d1StateHeaders(d1State);
  headers.set("Content-Disposition", 'attachment; filename="project-manager-latest.xlsx"');
  const body = base64ToBytes(d1State.dataBase64);
  const arrayBuffer = new ArrayBuffer(body.byteLength);
  new Uint8Array(arrayBuffer).set(body);
  return new Response(arrayBuffer, { headers });
}

export async function onRequestPost(context: AppContext): Promise<Response> {
  const originError = requireSameOrigin(context.request);
  if (originError) return originError;

  const user = await authenticate(context);
  if (isResponse(user)) return user;

  if (!excelStateEnabled(context)) {
    return apiError(404, "Cloud Excel sync is disabled");
  }

  const bytes = await context.request.arrayBuffer();
  if (bytes.byteLength === 0) {
    return apiError(400, "Missing Excel file body");
  }
  if (bytes.byteLength > 10_000_000) {
    return apiError(413, "Excel file is too large");
  }

  const timestamp = nowIso();
  const rowCount = Number(context.request.headers.get("X-Row-Count") ?? "0");
  const filename = context.request.headers.get("X-File-Name") ?? "project-manager-latest.xlsx";
  const metadata = {
    userId: user.id,
    filename,
    updatedAt: timestamp,
    rowCount: Number.isFinite(rowCount) ? String(rowCount) : "0"
  };
  const httpMetadata = {
    contentType: EXCEL_CONTENT_TYPE,
    contentDisposition: 'attachment; filename="project-manager-latest.xlsx"'
  };

  let etag = await sha256Etag(bytes);
  let archiveKey = "d1:cloud_excel_latest";

  if (r2ExcelStateEnabled(context) && context.env.BACKUPS) {
    const latest = await context.env.BACKUPS.put(LATEST_EXCEL_KEY, bytes, {
      httpMetadata,
      customMetadata: metadata
    });
    archiveKey = datedBackupKey(timestamp);
    await context.env.BACKUPS.put(archiveKey, bytes, {
      httpMetadata,
      customMetadata: metadata
    });
    etag = latest.httpEtag;
  } else {
    if (bytes.byteLength > 2_000_000) {
      return apiError(413, "Excel file is too large for D1 fallback. Enable R2 for larger files.");
    }
    const state: D1ExcelState = {
      dataBase64: bytesToBase64(bytes),
      etag,
      filename,
      updatedAt: timestamp,
      size: bytes.byteLength
    };
    await context.env.DB.prepare(
      `INSERT INTO app_settings (user_id, key, value_json, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(user_id, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`
    )
      .bind(user.id, D1_EXCEL_STATE_KEY, JSON.stringify(state), timestamp)
      .run();
  }

  return json({
    ok: true,
    key: LATEST_EXCEL_KEY,
    archiveKey,
    etag,
    updatedAt: timestamp
  });
}
