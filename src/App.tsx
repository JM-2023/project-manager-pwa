import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { BottomNav } from "./components/BottomNav";
import { OfflineBanner } from "./components/OfflineBanner";
import {
  AuthRequiredError,
  bootstrap,
  downloadCloudExcel,
  getCloudExcelState,
  getExportData,
  getSession,
  importRows,
  login,
  logout,
  sendMutations,
  uploadCloudExcel
} from "./lib/api";
import { nowIso } from "./lib/dates";
import { getOrCreateClientId, newId, newMutationId } from "./lib/ids";
import {
  deleteEntity,
  getPendingMutations,
  loadLocalSnapshot,
  queueMutation,
  removePendingMutations,
  saveBootstrapSnapshot,
  saveEntity
} from "./lib/localDb";
import { parseTaskExtra, stringifyTaskExtra, summarizeWorklogOverview } from "./lib/progress";
import { visibleProjects, visibleTasks } from "./lib/sync";
import type { BootstrapResponse, ClientMutation, ImportRow, Project, Tag, Task, TaskTag } from "./lib/types";
import { LoginPage } from "./pages/LoginPage";
import { NextPage } from "./pages/NextPage";
import type { TaskPageProps } from "./pages/pageProps";
import { ProjectsPage } from "./pages/ProjectsPage";
import { SearchPage } from "./pages/SearchPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TodayPage } from "./pages/TodayPage";
import { appReducer, initialState, sortedProjects, sortedTasks, type AppState } from "./state/appStore";

const PROJECT_COLORS = ["#1f6f68", "#a64b2a", "#5b6c5d", "#3f5f8f", "#7a5c99", "#8a6a23"];
const CLOUD_EXCEL_ETAG_KEY = "project-manager-cloud-excel-etag";
const CLOUD_EXCEL_FILENAME = "project-manager-latest.xlsx";
const SYNC_DEBOUNCE_MS = 850;
const KEEPALIVE_MAX_BYTES = 60_000;
const EXCEL_DIRTY_SETTING_KEY = "excel_dirty_at";

interface PendingMutationGroup {
  mutation: ClientMutation;
  sourceIds: string[];
}

function mutationData(mutation: ClientMutation): Record<string, unknown> {
  return mutation.data && typeof mutation.data === "object" ? (mutation.data as Record<string, unknown>) : {};
}

function mutationCreatedAt(mutation: ClientMutation): string {
  return String(mutation.createdAt ?? "");
}

function mutationRecordKey(mutation: ClientMutation): string | null {
  const data = mutationData(mutation);
  if (mutation.entity === "task_tag") {
    const taskId = data.task_id ? String(data.task_id) : "";
    const tagId = data.tag_id ? String(data.tag_id) : "";
    return taskId && tagId ? `${mutation.entity}:${taskId}:${tagId}` : null;
  }
  if (mutation.entity === "setting") {
    const key = data.key ?? data.id;
    return key ? `${mutation.entity}:${String(key)}` : null;
  }
  const id = data.id;
  return id ? `${mutation.entity}:${String(id)}` : null;
}

function compactPendingMutations(mutations: ClientMutation[]): PendingMutationGroup[] {
  const groups: PendingMutationGroup[] = [];
  const groupByRecord = new Map<string, PendingMutationGroup>();
  const ordered = mutations
    .map((mutation, index) => ({ mutation, index }))
    .sort(
      (left, right) =>
        mutationCreatedAt(left.mutation).localeCompare(mutationCreatedAt(right.mutation)) || left.index - right.index
    );

  for (const { mutation } of ordered) {
    const key = mutationRecordKey(mutation);
    if (!key) {
      groups.push({ mutation, sourceIds: [mutation.id] });
      continue;
    }

    const existing = groupByRecord.get(key);
    if (!existing) {
      const group = { mutation, sourceIds: [mutation.id] };
      groupByRecord.set(key, group);
      groups.push(group);
      continue;
    }

    existing.sourceIds.push(mutation.id);
    existing.mutation = mutation;
  }

  return groups;
}

function mergePendingMutations(...lists: ClientMutation[][]): ClientMutation[] {
  const byId = new Map<string, ClientMutation>();
  for (const list of lists) {
    for (const mutation of list) {
      byId.set(mutation.id, mutation);
    }
  }
  return [...byId.values()].sort((left, right) => mutationCreatedAt(left).localeCompare(mutationCreatedAt(right)));
}

function excelDirtyAt(settings: Record<string, unknown>): string | null {
  const value = settings[EXCEL_DIRTY_SETTING_KEY];
  return typeof value === "string" && value ? value : null;
}

function keepaliveBody(clientId: string, groups: PendingMutationGroup[]): Blob | null {
  let selected = groups;
  while (selected.length > 0) {
    const payload = JSON.stringify({
      clientId,
      flush: true,
      mutations: selected.map((group) => group.mutation)
    });
    const blob = new Blob([payload], { type: "application/json" });
    if (blob.size <= KEEPALIVE_MAX_BYTES) {
      return blob;
    }
    selected = selected.slice(Math.ceil(selected.length / 2));
  }
  return null;
}

function stateWithBootstrap(state: AppState, snapshot: BootstrapResponse): AppState {
  return {
    ...state,
    projects: snapshot.projects,
    tasks: snapshot.tasks,
    tags: snapshot.tags,
    taskTags: snapshot.taskTags,
    settings: snapshot.settings,
    lastSync: snapshot.serverTime,
    syncStatus: "idle"
  };
}

function upsertRecord<T extends { id: string }>(records: T[], record: T): T[] {
  const index = records.findIndex((item) => item.id === record.id);
  if (index < 0) {
    return [record, ...records];
  }
  const next = records.slice();
  next[index] = record;
  return next;
}

function removeRecord<T extends { id: string }>(records: T[], id: string): T[] {
  return records.filter((item) => item.id !== id);
}

function taskTagKey(tag: TaskTag): string {
  return `${tag.task_id}:${tag.tag_id}`;
}

function upsertTaskTagRecord(records: TaskTag[], record: TaskTag): TaskTag[] {
  const key = taskTagKey(record);
  const index = records.findIndex((item) => taskTagKey(item) === key);
  if (index < 0) {
    return [...records, record];
  }
  const next = records.slice();
  next[index] = record;
  return next;
}

async function rowsFromWorkbookBlob(blob: Blob): Promise<ImportRow[]> {
  const [{ parseWorkbook }, mappingModule] = await Promise.all([import("./lib/excelImport"), import("./lib/excelMapping")]);
  const sheets = await parseWorkbook(blob);
  const scoredSheets = sheets.map((sheet) => {
    const mapping = mappingModule.defaultMapping(sheet.headers);
    return { sheet, mapping, rows: mappingModule.normalizeImportRows(sheet, mapping) };
  });
  if (scoredSheets.length === 0) {
    return [];
  }
  const best = scoredSheets.reduce((winner, candidate) => (candidate.rows.length > winner.rows.length ? candidate : winner), scoredSheets[0]);
  const cacheRows = sheets
    .filter((sheet) => sheet.name === "项目缓存")
    .flatMap((sheet) => mappingModule.normalizeProjectCacheRows(sheet));
  return [...(best?.rows ?? []), ...cacheRows];
}

export function App() {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const stateRef = useRef(state);
  const syncTimer = useRef<number | null>(null);
  const syncInFlight = useRef(false);
  const syncAgainAfterCurrent = useRef(false);
  const excelUploadTimer = useRef<number | null>(null);
  const excelUploadInFlight = useRef(false);
  const cloudExcelChecked = useRef(false);
  const cloudExcelImporting = useRef(false);
  const pendingMutationsRef = useRef<ClientMutation[]>([]);
  const pendingWritePromises = useRef<Set<Promise<void>>>(new Set());
  const clientId = useMemo(() => getOrCreateClientId(), []);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const applyBootstrapSnapshot = useCallback(async (snapshot: BootstrapResponse) => {
    stateRef.current = stateWithBootstrap(stateRef.current, snapshot);
    dispatch({ type: "replaceBootstrap", payload: snapshot });
    await saveBootstrapSnapshot(snapshot);
  }, []);

  const updatePendingCount = useCallback(async () => {
    const persisted = await getPendingMutations();
    pendingMutationsRef.current = mergePendingMutations(persisted, pendingMutationsRef.current);
    const compactedCount = compactPendingMutations(pendingMutationsRef.current).length;
    dispatch({ type: "setPendingCount", payload: compactedCount });
    return pendingMutationsRef.current;
  }, []);

  const rememberPendingMutation = useCallback((mutation: ClientMutation) => {
    pendingMutationsRef.current = mergePendingMutations(pendingMutationsRef.current, [mutation]);
    dispatch({ type: "setPendingCount", payload: compactPendingMutations(pendingMutationsRef.current).length });
  }, []);

  const forgetPendingMutations = useCallback((ids: string[]) => {
    if (ids.length === 0) {
      return;
    }
    const removed = new Set(ids);
    pendingMutationsRef.current = pendingMutationsRef.current.filter((mutation) => !removed.has(mutation.id));
    dispatch({ type: "setPendingCount", payload: compactPendingMutations(pendingMutationsRef.current).length });
  }, []);

  const trackPendingWrite = useCallback((promise: Promise<void>) => {
    pendingWritePromises.current.add(promise);
    void promise.finally(() => {
      pendingWritePromises.current.delete(promise);
    });
  }, []);

  const settlePendingWrites = useCallback(async () => {
    const writes = [...pendingWritePromises.current];
    if (writes.length > 0) {
      await Promise.allSettled(writes);
    }
  }, []);

  const scheduleCloudExcelUpload = useCallback((delayMs = 5000) => {
    if (!stateRef.current.session?.features.excelAutosync) {
      return;
    }
    if (!navigator.onLine) {
      return;
    }
    if (excelUploadTimer.current) {
      window.clearTimeout(excelUploadTimer.current);
    }

    excelUploadTimer.current = window.setTimeout(async () => {
      if (excelUploadInFlight.current) {
        scheduleCloudExcelUpload(delayMs);
        return;
      }
      excelUploadInFlight.current = true;
      try {
        const data = await getExportData();
        const { workbookBlob } = await import("./lib/excelExport");
        const blob = workbookBlob(data);
        const result = await uploadCloudExcel(blob, CLOUD_EXCEL_FILENAME, visibleTasks(data.tasks).length);
        localStorage.setItem(CLOUD_EXCEL_ETAG_KEY, result.etag);
        dispatch({ type: "setLastExport", payload: result.updatedAt });
      } catch (error) {
        dispatch({
          type: "setError",
          payload: error instanceof Error ? `Cloud Excel sync failed: ${error.message}` : "Cloud Excel sync failed"
        });
      } finally {
        excelUploadInFlight.current = false;
      }
    }, delayMs);
  }, []);

  const flushPendingWithKeepalive = useCallback(() => {
    if (!navigator.onLine || !stateRef.current.session || pendingMutationsRef.current.length === 0) {
      return;
    }

    const body = keepaliveBody(clientId, compactPendingMutations(pendingMutationsRef.current));
    if (!body) {
      return;
    }

    if (navigator.sendBeacon?.("/api/mutations", body)) {
      return;
    }

    void fetch("/api/mutations", {
      method: "POST",
      body,
      credentials: "same-origin",
      keepalive: true
    }).catch(() => undefined);
  }, [clientId]);

  const syncNow = useCallback(async () => {
    if (syncTimer.current) {
      window.clearTimeout(syncTimer.current);
      syncTimer.current = null;
    }

    if (!navigator.onLine) {
      dispatch({ type: "setSyncStatus", payload: "offline" });
      return;
    }
    if (syncInFlight.current) {
      syncAgainAfterCurrent.current = true;
      return;
    }

    syncInFlight.current = true;
    let canRunQueuedSync = true;
    dispatch({ type: "setSyncStatus", payload: "syncing" });
    dispatch({ type: "setError", payload: null });

    try {
      let shouldUploadCloudExcel = false;
      let session = stateRef.current.session;
      if (!session) {
        session = await getSession();
        dispatch({ type: "setSession", payload: session });
      }

      await settlePendingWrites();
      const pending = mergePendingMutations(await getPendingMutations(), pendingMutationsRef.current);
      pendingMutationsRef.current = pending;
      const pendingGroups = compactPendingMutations(pending);
      if (pendingGroups.length > 0) {
        const result = await sendMutations(
          clientId,
          pendingGroups.map((group) => group.mutation)
        );
        const appliedIds = new Set(result.applied.map((item) => item.id));
        const sourceIdsToRemove = pendingGroups.flatMap((group) => (appliedIds.has(group.mutation.id) ? group.sourceIds : []));
        await removePendingMutations(sourceIdsToRemove);
        forgetPendingMutations(sourceIdsToRemove);
        dispatch({ type: "setConflicts", payload: result.conflicts.length });
        shouldUploadCloudExcel = result.applied.length > 0;
      }

      const refreshed = await bootstrap(null);
      await applyBootstrapSnapshot(refreshed);
      shouldUploadCloudExcel = shouldUploadCloudExcel || Boolean(excelDirtyAt(refreshed.settings));
      await updatePendingCount();
      dispatch({ type: "setAuthRequired", payload: false });
      dispatch({ type: "setSyncStatus", payload: "idle" });
      if (shouldUploadCloudExcel) {
        scheduleCloudExcelUpload();
      }
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        canRunQueuedSync = false;
        dispatch({ type: "setAuthRequired", payload: true });
        dispatch({ type: "setSession", payload: null });
      } else {
        dispatch({ type: "setError", payload: error instanceof Error ? error.message : "Sync failed" });
        dispatch({ type: "setSyncStatus", payload: "error" });
      }
    } finally {
      syncInFlight.current = false;
      if (syncAgainAfterCurrent.current && canRunQueuedSync) {
        syncAgainAfterCurrent.current = false;
        window.setTimeout(() => void syncNow(), 0);
      }
    }
  }, [applyBootstrapSnapshot, clientId, forgetPendingMutations, scheduleCloudExcelUpload, settlePendingWrites, updatePendingCount]);

  const importCloudExcelIfNeeded = useCallback(async () => {
    if (cloudExcelImporting.current || !stateRef.current.session?.features.excelAutosync) {
      return;
    }

    try {
      const cloudState = await getCloudExcelState();
      if (!cloudState?.etag) {
        return;
      }
      if (localStorage.getItem(CLOUD_EXCEL_ETAG_KEY) === cloudState.etag) {
        return;
      }

      const blob = await downloadCloudExcel();
      if (!blob) {
        return;
      }

      cloudExcelImporting.current = true;
      dispatch({ type: "setSyncStatus", payload: "syncing" });
      const rows = await rowsFromWorkbookBlob(blob);
      if (rows.length > 0) {
        await importRows(CLOUD_EXCEL_FILENAME, rows);
        localStorage.setItem(CLOUD_EXCEL_ETAG_KEY, cloudState.etag);
        await syncNow();
      } else {
        localStorage.setItem(CLOUD_EXCEL_ETAG_KEY, cloudState.etag);
      }
    } catch (error) {
      dispatch({
        type: "setError",
        payload: error instanceof Error ? `Cloud Excel import failed: ${error.message}` : "Cloud Excel import failed"
      });
    } finally {
      cloudExcelImporting.current = false;
    }
  }, [syncNow]);

  const scheduleSync = useCallback(() => {
    if (!navigator.onLine) {
      dispatch({ type: "setSyncStatus", payload: "offline" });
      return;
    }
    if (syncInFlight.current) {
      syncAgainAfterCurrent.current = true;
      return;
    }
    if (syncTimer.current) {
      window.clearTimeout(syncTimer.current);
    }
    dispatch({ type: "setSyncStatus", payload: "queued" });
    syncTimer.current = window.setTimeout(() => {
      syncTimer.current = null;
      void syncNow();
    }, SYNC_DEBOUNCE_MS);
  }, [syncNow]);

  useEffect(() => {
    let cancelled = false;

    async function start() {
      dispatch({ type: "setSyncStatus", payload: "loading" });
      try {
        const session = await getSession();
        if (cancelled) return;

        const local = await loadLocalSnapshot();
        if (cancelled) return;
        pendingMutationsRef.current = local.pendingMutations;
        const payload = {
          projects: local.projects,
          tasks: local.tasks,
          tags: local.tags,
          taskTags: local.taskTags,
          settings: local.settings,
          pendingCount: compactPendingMutations(local.pendingMutations).length,
          lastSync: local.lastSync
        };
        stateRef.current = { ...stateRef.current, ...payload, session, authRequired: false };
        dispatch({ type: "hydrateLocal", payload });
        dispatch({ type: "setSession", payload: session });
        await syncNow();
      } catch (error) {
        if (cancelled) return;
        if (error instanceof AuthRequiredError) {
          dispatch({ type: "setAuthRequired", payload: true });
          dispatch({ type: "setSyncStatus", payload: "idle" });
        } else {
          dispatch({ type: "setError", payload: error instanceof Error ? error.message : "Startup failed" });
          dispatch({ type: "setSyncStatus", payload: "error" });
        }
      }
    }

    void start();
    return () => {
      cancelled = true;
    };
  }, [syncNow]);

  useEffect(() => {
    if (cloudExcelChecked.current || !state.session || state.syncStatus !== "idle") {
      return;
    }
    cloudExcelChecked.current = true;
    void importCloudExcelIfNeeded();
  }, [importCloudExcelIfNeeded, state.session, state.syncStatus]);

  useEffect(() => {
    function handleOnline() {
      dispatch({ type: "setOnline", payload: navigator.onLine });
      if (navigator.onLine) void syncNow();
    }
    function handleFocus() {
      if (navigator.onLine) void syncNow();
    }
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOnline);
    window.addEventListener("focus", handleFocus);
    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOnline);
      window.removeEventListener("focus", handleFocus);
    };
  }, [syncNow]);

  useEffect(() => {
    function flushAfterCurrentEvent() {
      queueMicrotask(() => flushPendingWithKeepalive());
    }
    function handleVisibilityChange() {
      if (document.visibilityState === "hidden") {
        flushAfterCurrentEvent();
      }
    }

    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("pagehide", flushAfterCurrentEvent);
    window.addEventListener("beforeunload", flushAfterCurrentEvent);
    return () => {
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      window.removeEventListener("pagehide", flushAfterCurrentEvent);
      window.removeEventListener("beforeunload", flushAfterCurrentEvent);
    };
  }, [flushPendingWithKeepalive]);

  function persistMutation(mutation: ClientMutation) {
    const queuedMutation = { ...mutation, createdAt: nowIso() };
    rememberPendingMutation(queuedMutation);
    trackPendingWrite(
      queueMutation(queuedMutation)
        .then(() => updatePendingCount())
        .then(() => undefined)
        .catch((error) => {
          dispatch({ type: "setError", payload: error instanceof Error ? error.message : "Local save failed" });
        })
    );
    scheduleSync();
  }

  function updateTask(task: Task, changes: Partial<Task>) {
    const next: Task = { ...task, ...changes, updated_at: nowIso(), version: task.version + 1 };
    dispatch({ type: "upsertTask", payload: next });
    stateRef.current = { ...stateRef.current, tasks: upsertRecord(stateRef.current.tasks, next) };
    void saveEntity("tasks", next);
    void persistMutation({
      id: newMutationId(),
      entity: "task",
      operation: "upsert",
      baseVersion: task.version,
      data: next
    });
  }

  function createTask(input: Partial<Task> & { title: string }) {
    const timestamp = nowIso();
    const task: Task = {
      id: newId(),
      title: input.title,
      project_id: input.project_id ?? null,
      description: input.description ?? null,
      status: input.status ?? "todo",
      priority: input.priority ?? "medium",
      due_date: input.due_date ?? null,
      start_date: input.start_date ?? null,
      completed_at: null,
      next_action: input.next_action ?? null,
      notes: input.notes ?? null,
      sort_order: Date.now(),
      parent_task_id: null,
      source: input.source ?? "app",
      external_key: input.external_key ?? null,
      extra_json: input.extra_json ?? null,
      archived: 0,
      created_at: timestamp,
      updated_at: timestamp,
      deleted_at: null,
      version: 1
    };
    dispatch({ type: "upsertTask", payload: task });
    stateRef.current = { ...stateRef.current, tasks: upsertRecord(stateRef.current.tasks, task) };
    void saveEntity("tasks", task);
    void persistMutation({ id: newMutationId(), entity: "task", operation: "upsert", baseVersion: null, data: task });
  }

  function deleteTask(task: Task) {
    dispatch({ type: "deleteTask", payload: task.id });
    stateRef.current = { ...stateRef.current, tasks: removeRecord(stateRef.current.tasks, task.id) };
    void deleteEntity("tasks", task.id);
    void persistMutation({
      id: newMutationId(),
      entity: "task",
      operation: "delete",
      baseVersion: task.version,
      data: { id: task.id }
    });
  }

  function archiveTask(task: Task) {
    deleteTask(task);
  }

  function createProject(name: string): string {
    const timestamp = nowIso();
    const project: Project = {
      id: newId(),
      name,
      description: null,
      color: PROJECT_COLORS[stateRef.current.projects.length % PROJECT_COLORS.length],
      sort_order: stateRef.current.projects.length,
      archived: 0,
      created_at: timestamp,
      updated_at: timestamp,
      deleted_at: null,
      version: 1
    };
    dispatch({ type: "upsertProject", payload: project });
    stateRef.current = { ...stateRef.current, projects: upsertRecord(stateRef.current.projects, project) };
    void saveEntity("projects", project);
    void persistMutation({ id: newMutationId(), entity: "project", operation: "upsert", baseVersion: null, data: project });
    return project.id;
  }

  function archiveProject(project: Project) {
    const next = { ...project, archived: 1, updated_at: nowIso(), version: project.version + 1 };
    dispatch({ type: "upsertProject", payload: next });
    stateRef.current = { ...stateRef.current, projects: upsertRecord(stateRef.current.projects, next) };
    void saveEntity("projects", next);
    void persistMutation({ id: newMutationId(), entity: "project", operation: "upsert", baseVersion: project.version, data: next });
  }

  function renameProject(project: Project, name: string) {
    const clean = name.trim();
    if (!clean || clean === project.name) {
      return;
    }
    const next = { ...project, name: clean, updated_at: nowIso(), version: project.version + 1 };
    dispatch({ type: "upsertProject", payload: next });
    stateRef.current = { ...stateRef.current, projects: upsertRecord(stateRef.current.projects, next) };
    void saveEntity("projects", next);
    void persistMutation({ id: newMutationId(), entity: "project", operation: "upsert", baseVersion: project.version, data: next });

    // Tasks stay linked by project_id; only keep cached project-name copies in sync.
    for (const task of stateRef.current.tasks) {
      if (task.project_id !== project.id || task.deleted_at) {
        continue;
      }
      const extra = parseTaskExtra(task);
      if (extra.cache_project && extra.cache_project !== clean) {
        extra.cache_project = clean;
        updateTask(task, { extra_json: stringifyTaskExtra(extra) });
      }
    }
  }

  function addTag(task: Task, tagName: string) {
    const existing = stateRef.current.tags.find((tag) => tag.name.toLowerCase() === tagName.toLowerCase() && !tag.deleted_at);
    const timestamp = nowIso();
    const tag: Tag =
      existing ??
      ({
        id: newId(),
        name: tagName,
        color: null,
        created_at: timestamp,
        updated_at: timestamp,
        deleted_at: null,
        version: 1
      } satisfies Tag);

    if (!existing) {
      dispatch({ type: "upsertTag", payload: tag });
      stateRef.current = { ...stateRef.current, tags: upsertRecord(stateRef.current.tags, tag) };
      void saveEntity("tags", tag);
      void persistMutation({ id: newMutationId(), entity: "tag", operation: "upsert", baseVersion: null, data: tag });
    }

    const alreadyLinked = stateRef.current.taskTags.some((link) => link.task_id === task.id && link.tag_id === tag.id && !link.deleted_at);
    if (alreadyLinked) {
      return;
    }
    const link: TaskTag = { task_id: task.id, tag_id: tag.id, created_at: timestamp, deleted_at: null };
    dispatch({ type: "upsertTaskTag", payload: link });
    stateRef.current = { ...stateRef.current, taskTags: upsertTaskTagRecord(stateRef.current.taskTags, link) };
    void saveEntity("taskTags", link);
    void persistMutation({ id: newMutationId(), entity: "task_tag", operation: "upsert", baseVersion: null, data: link });
  }

  async function handleImport(filename: string, rows: ImportRow[]) {
    const result = await importRows(filename, rows);
    await syncNow();
    scheduleCloudExcelUpload(1500);
    return result;
  }

  async function handleLogin(password: string) {
    await login(password);
    const session = await getSession();
    const local = await loadLocalSnapshot();
    pendingMutationsRef.current = local.pendingMutations;
    const payload = {
      projects: local.projects,
      tasks: local.tasks,
      tags: local.tags,
      taskTags: local.taskTags,
      settings: local.settings,
      pendingCount: compactPendingMutations(local.pendingMutations).length,
      lastSync: local.lastSync
    };
    stateRef.current = { ...stateRef.current, ...payload, session, authRequired: false };
    dispatch({ type: "hydrateLocal", payload });
    dispatch({ type: "setSession", payload: session });
    await syncNow();
  }

  async function handleLogout() {
    await logout().catch(() => ({ ok: true as const }));
    dispatch({ type: "setSession", payload: null });
    dispatch({ type: "setAuthRequired", payload: true });
  }

  const projects = useMemo(() => sortedProjects(state.projects), [state.projects]);
  const tasks = useMemo(() => sortedTasks(state.tasks), [state.tasks]);
  const pageProps: TaskPageProps = {
    projects,
    tasks,
    tags: state.tags.filter((tag) => !tag.deleted_at),
    taskTags: state.taskTags,
    filters: state.filters,
    onFiltersChange: (filters) => dispatch({ type: "setFilters", payload: filters }),
    onCreateTask: createTask,
    onUpdateTask: updateTask,
    onArchiveTask: archiveTask,
    onDeleteTask: deleteTask,
    onAddTag: addTag,
    onCreateProject: createProject,
    onArchiveProject: archiveProject,
    onRenameProject: renameProject
  };

  if (state.authRequired) {
    return <LoginPage onLogin={handleLogin} />;
  }

  return (
    <div className="app-shell">
      <OfflineBanner online={state.online} pendingCount={state.pendingCount} syncStatus={state.syncStatus} error={state.error} onSync={syncNow} />
      {state.currentTab === "today" ? <TodayPage {...pageProps} /> : null}
      {state.currentTab === "projects" ? <ProjectsPage {...pageProps} /> : null}
      {state.currentTab === "next" ? <NextPage {...pageProps} /> : null}
      {state.currentTab === "search" ? <SearchPage {...pageProps} /> : null}
      {state.currentTab === "settings" ? (
        <SettingsPage
          taskCount={visibleTasks(state.tasks).length}
          projectCount={visibleProjects(state.projects).length}
          pendingCount={state.pendingCount}
          lastSync={state.lastSync}
          lastExport={state.lastExport}
          session={state.session}
          worklogOverview={summarizeWorklogOverview(visibleTasks(state.tasks))}
          onImport={handleImport}
          onExported={(timestamp) => dispatch({ type: "setLastExport", payload: timestamp })}
          onSync={syncNow}
          onLogout={() => void handleLogout()}
        />
      ) : null}
      <BottomNav current={state.currentTab} onChange={(tab) => dispatch({ type: "setTab", payload: tab })} />
    </div>
  );
}
