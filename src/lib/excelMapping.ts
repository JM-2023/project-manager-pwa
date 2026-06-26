import { parseLooseDate } from "./dates";
import { importancePriority, normalizeImportance, normalizeProgressPercent } from "./progress";
import { normalizePriority, normalizeStatus, statusFromProgress } from "./validation";
import type { ImportRow, TaskPriority, TaskStatus } from "./types";

export type ImportField =
  | "skip"
  | "id"
  | "external_key"
  | "project"
  | "title"
  | "status"
  | "priority"
  | "importance"
  | "due_date"
  | "start_date"
  | "next_action"
  | "notes"
  | "description"
  | "tags"
  | "progress"
  | "blocker"
  | "output";

export interface ParsedSheet {
  name: string;
  rows: unknown[][];
  headerIndex: number;
  headers: string[];
}

export type ColumnMapping = Record<string, ImportField>;

const FIELD_ALIASES: Record<string, ImportField> = {
  id: "id",
  "task id": "id",
  external_key: "external_key",
  externalkey: "external_key",
  "external key": "external_key",
  项目: "project",
  project: "project",
  任务: "title",
  task: "title",
  title: "title",
  标题: "title",
  status: "status",
  状态: "status",
  priority: "priority",
  优先级: "priority",
  importance: "importance",
  重要程度: "importance",
  "due date": "due_date",
  duedate: "due_date",
  截止日期: "due_date",
  due: "due_date",
  日期: "start_date",
  "start date": "start_date",
  startdate: "start_date",
  明天第一步: "next_action",
  下一步: "next_action",
  "next action": "next_action",
  nextaction: "next_action",
  notes: "notes",
  note: "notes",
  备注: "notes",
  description: "description",
  描述: "description",
  tag: "tags",
  tags: "tags",
  标签: "tags",
  progress: "progress",
  进度: "progress",
  卡住的地方: "blocker",
  blocker: "blocker",
  blocked: "blocker",
  今日产出: "output",
  output: "output"
};

function normalizeHeader(value: unknown): string {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export function makeUniqueHeaders(cells: unknown[]): string[] {
  const counts = new Map<string, number>();

  return cells.map((cell, index) => {
    const base = String(cell || `Column ${index + 1}`).trim() || `Column ${index + 1}`;
    const count = (counts.get(base) ?? 0) + 1;
    counts.set(base, count);
    return count === 1 ? base : `${base} (${count})`;
  });
}

export function detectHeaderIndex(rows: unknown[][]): number {
  let bestIndex = 0;
  let bestScore = -1;

  rows.slice(0, 12).forEach((row, index) => {
    const score = row.reduce((total: number, cell: unknown): number => {
      const key = normalizeHeader(cell);
      return total + (FIELD_ALIASES[key] ? 1 : 0);
    }, 0);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  return bestIndex;
}

export function defaultMapping(headers: string[]): ColumnMapping {
  return Object.fromEntries(
    headers.map((header) => {
      const field = FIELD_ALIASES[normalizeHeader(header)] ?? "skip";
      return [header, field];
    })
  );
}

function readMapped(row: Record<string, unknown>, mapping: ColumnMapping, field: ImportField): unknown {
  const header = Object.entries(mapping).find(([, mapped]) => mapped === field)?.[0];
  return header ? row[header] : undefined;
}

function splitTags(value: unknown): string[] {
  return String(value ?? "")
    .split(/[,;，；、]/)
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function normalizeProjectCacheRows(sheet: ParsedSheet): ImportRow[] {
  const projectNames = (sheet.rows[0] ?? []).map((cell) => String(cell ?? "").trim());
  const rows: ImportRow[] = [];

  projectNames.forEach((project, columnIndex) => {
    if (!project) {
      return;
    }
    sheet.rows.slice(1).forEach((cells, rowOffset) => {
      const title = String(cells[columnIndex] ?? "").trim();
      if (!title) {
        return;
      }
      const sourceRow = rowOffset + 2;
      rows.push({
        external_key: `project-cache:${stableHash([sheet.name, project, sourceRow, title].join("|"))}`,
        source: "project_cache",
        project,
        title,
        status: "todo",
        priority: "medium",
        due_date: null,
        start_date: null,
        next_action: null,
        notes: null,
        description: null,
        tags: [],
        extra_json: {
          cache_item: true,
          source_sheet: sheet.name,
          source_row: sourceRow,
          cache_project: project,
          cache_column: columnIndex + 1
        }
      });
    });
  });

  return rows;
}

export function normalizeImportRows(sheet: ParsedSheet, mapping: ColumnMapping): ImportRow[] {
  const body = sheet.rows.slice(sheet.headerIndex + 1);
  return body
    .map((cells, bodyIndex) => {
      const raw = Object.fromEntries(sheet.headers.map((header, index) => [header, cells[index] ?? ""]));
      const id = String(readMapped(raw, mapping, "id") ?? "").trim();
      const explicitExternalKey = String(readMapped(raw, mapping, "external_key") ?? "").trim();
      const project = String(readMapped(raw, mapping, "project") ?? "").trim();
      const title = String(readMapped(raw, mapping, "title") ?? "").trim();
      const output = String(readMapped(raw, mapping, "output") ?? "").trim();
      const blocker = String(readMapped(raw, mapping, "blocker") ?? "").trim();
      const rawNotes = String(readMapped(raw, mapping, "notes") ?? "").trim();
      const notes = rawNotes;
      const statusValue = readMapped(raw, mapping, "status");
      const progress = readMapped(raw, mapping, "progress");
      const progressPercent = normalizeProgressPercent(progress);
      const status = statusValue ? normalizeStatus(statusValue) : statusFromProgress(progress, blocker);
      const importance = normalizeImportance(readMapped(raw, mapping, "importance"));
      const priority = importance ? importancePriority(importance) : normalizePriority(readMapped(raw, mapping, "priority"));
      const tags = splitTags(readMapped(raw, mapping, "tags"));
      const startDate = parseLooseDate(readMapped(raw, mapping, "start_date"));
      const dueDate = parseLooseDate(readMapped(raw, mapping, "due_date"));
      const sourceRow = sheet.headerIndex + bodyIndex + 2;
      const generatedExternalKey = `worklog:${stableHash([sheet.name, sourceRow, startDate, project, title].join("|"))}`;

      const knownHeaders = new Set(
        Object.entries(mapping)
          .filter(([, field]) => field !== "skip")
          .map(([header]) => header)
      );
      const extra_json: Record<string, unknown> = {
        ...Object.fromEntries(Object.entries(raw).filter(([header, value]) => !knownHeaders.has(header) && value !== "")),
        source_sheet: sheet.name,
        source_row: sourceRow
      };
      if (progressPercent !== null) {
        extra_json.progress_percent = progressPercent;
      }
      if (importance) {
        extra_json.importance = importance;
      }
      if (output) {
        extra_json.daily_output = output;
      }
      if (blocker) {
        extra_json.blocker = blocker;
      }

      return {
        id: id || undefined,
        external_key: explicitExternalKey || (!id ? generatedExternalKey : undefined),
        project: project || undefined,
        title,
        status: status as TaskStatus,
        priority: priority as TaskPriority,
        due_date: dueDate,
        start_date: startDate,
        next_action: String(readMapped(raw, mapping, "next_action") ?? "").trim() || null,
        notes: notes || null,
        description: String(readMapped(raw, mapping, "description") ?? "").trim() || null,
        tags,
        extra_json
      };
    })
    .filter((row) => row.title);
}
