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
  getPendingMutations,
  loadLocalSnapshot,
  queueMutation,
  removePendingMutations,
  saveBootstrapSnapshot,
  saveEntity
} from "./lib/localDb";
import { summarizeWorklogOverview } from "./lib/progress";
import { mergeBootstrap, visibleProjects, visibleTasks } from "./lib/sync";
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

function snapshotFromState(state: AppState, serverTime: string): BootstrapResponse {
  return {
    serverTime,
    projects: state.projects,
    tasks: state.tasks,
    tags: state.tags,
    taskTags: state.taskTags,
    settings: state.settings
  };
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
  const excelUploadTimer = useRef<number | null>(null);
  const cloudExcelChecked = useRef(false);
  const cloudExcelImporting = useRef(false);
  const clientId = useMemo(() => getOrCreateClientId(), []);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const updatePendingCount = useCallback(async () => {
    const pending = await getPendingMutations();
    dispatch({ type: "setPendingCount", payload: pending.length });
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
      }
    }, delayMs);
  }, []);

  const syncNow = useCallback(async () => {
    if (!navigator.onLine) {
      dispatch({ type: "setSyncStatus", payload: "offline" });
      return;
    }

    dispatch({ type: "setSyncStatus", payload: "syncing" });
    dispatch({ type: "setError", payload: null });

    try {
      let shouldUploadCloudExcel = false;
      let session = stateRef.current.session;
      if (!session) {
        session = await getSession();
        dispatch({ type: "setSession", payload: session });
      }

      const pulled = await bootstrap(stateRef.current.lastSync);
      const merged = mergeBootstrap(snapshotFromState(stateRef.current, pulled.serverTime), pulled);
      dispatch({ type: "applyBootstrap", payload: merged });
      await saveBootstrapSnapshot(merged);

      const pending = await getPendingMutations();
      if (pending.length > 0) {
        const result = await sendMutations(clientId, pending);
        await removePendingMutations(result.applied.map((item) => item.id));
        dispatch({ type: "setConflicts", payload: result.conflicts.length });
        const refreshed = await bootstrap(null);
        dispatch({ type: "applyBootstrap", payload: refreshed });
        await saveBootstrapSnapshot(refreshed);
        shouldUploadCloudExcel = result.applied.length > 0;
      }

      await updatePendingCount();
      dispatch({ type: "setAuthRequired", payload: false });
      dispatch({ type: "setSyncStatus", payload: "idle" });
      if (shouldUploadCloudExcel) {
        scheduleCloudExcelUpload();
      }
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        dispatch({ type: "setAuthRequired", payload: true });
        dispatch({ type: "setSession", payload: null });
      } else {
        dispatch({ type: "setError", payload: error instanceof Error ? error.message : "Sync failed" });
        dispatch({ type: "setSyncStatus", payload: "error" });
      }
    }
  }, [clientId, scheduleCloudExcelUpload, updatePendingCount]);

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
    if (syncTimer.current) {
      window.clearTimeout(syncTimer.current);
    }
    syncTimer.current = window.setTimeout(() => {
      void syncNow();
    }, 1200);
  }, [syncNow]);

  useEffect(() => {
    let cancelled = false;

    async function start() {
      dispatch({ type: "setSyncStatus", payload: "loading" });
      const local = await loadLocalSnapshot();
      if (cancelled) return;
      dispatch({
        type: "hydrateLocal",
        payload: {
          projects: local.projects,
          tasks: local.tasks,
          tags: local.tags,
          taskTags: local.taskTags,
          settings: local.settings,
          pendingCount: local.pendingMutations.length,
          lastSync: local.lastSync
        }
      });
      await syncNow();
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

  async function persistMutation(mutation: ClientMutation) {
    await queueMutation({ ...mutation, createdAt: nowIso() });
    await updatePendingCount();
    scheduleSync();
  }

  function updateTask(task: Task, changes: Partial<Task>) {
    const next: Task = { ...task, ...changes, updated_at: nowIso(), version: task.version + 1 };
    dispatch({ type: "upsertTask", payload: next });
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
    void saveEntity("tasks", task);
    void persistMutation({ id: newMutationId(), entity: "task", operation: "upsert", baseVersion: null, data: task });
  }

  function archiveTask(task: Task) {
    updateTask(task, { archived: 1 });
  }

  function deleteTask(task: Task) {
    updateTask(task, { deleted_at: nowIso(), archived: 1 });
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
    void saveEntity("projects", project);
    void persistMutation({ id: newMutationId(), entity: "project", operation: "upsert", baseVersion: null, data: project });
    return project.id;
  }

  function archiveProject(project: Project) {
    const next = { ...project, archived: 1, updated_at: nowIso(), version: project.version + 1 };
    dispatch({ type: "upsertProject", payload: next });
    void saveEntity("projects", next);
    void persistMutation({ id: newMutationId(), entity: "project", operation: "upsert", baseVersion: project.version, data: next });
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
      void saveEntity("tags", tag);
      void persistMutation({ id: newMutationId(), entity: "tag", operation: "upsert", baseVersion: null, data: tag });
    }

    const alreadyLinked = stateRef.current.taskTags.some((link) => link.task_id === task.id && link.tag_id === tag.id && !link.deleted_at);
    if (alreadyLinked) {
      return;
    }
    const link: TaskTag = { task_id: task.id, tag_id: tag.id, created_at: timestamp, deleted_at: null };
    dispatch({ type: "upsertTaskTag", payload: link });
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
    dispatch({ type: "setSession", payload: session });
    dispatch({ type: "setAuthRequired", payload: false });
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
    onArchiveProject: archiveProject
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
