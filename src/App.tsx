import { useEffect, useMemo, useReducer, useRef } from "react";
import { BottomNav } from "./components/BottomNav";
import { OfflineBanner } from "./components/OfflineBanner";
import {
  AuthRequiredError,
  bootstrap,
  getExportData,
  getSession,
  importRows,
  login,
  logout,
  sendMutations,
  setupPassword,
  uploadCloudExcel
} from "./lib/api";
import { nowIso } from "./lib/dates";
import { getOrCreateClientId, newId, newMutationId } from "./lib/ids";
import {
  buildWorkbookBlobInWorker,
  WorkbookWorkerBuildError,
  WorkbookWorkerUnavailableError
} from "./lib/excelWorkbookClient";
import { useI18n } from "./lib/i18n";
import {
  commitLocalMutation,
  getPendingMutations,
  isCachedSessionUsable,
  loadLocalSnapshot,
  removePendingMutations,
  resetLocalData,
  saveBootstrapSnapshot,
  setLastSync,
  saveLocalSession,
  type LocalEntityWrite,
  type SavableEntity
} from "./lib/localDb";
import { parseTaskExtra, stringifyTaskExtra, summarizeWorklogOverview } from "./lib/progress";
import { visibleProjects, visibleTasks } from "./lib/sync";
import { compactPendingMutations, mutationRecordKey, removeRecord, replayPendingMutations, upsertRecord } from "./lib/syncMerge";
import { SyncEngine, type SyncIO } from "./lib/syncEngine";
import {
  beginLogoutBarrier,
  claimBackgroundPoll,
  finishLogoutBarrier,
  isLogoutBarrierActive,
  isLogoutBarrierStale,
  logoutBarrierRetryDelay,
  publishSyncHint,
  releaseLogoutBarrier,
  subscribeToSyncEvents,
  withLocalDataLease,
  withSyncLease
} from "./lib/syncChannel";
import type { ImportRow, NextIdea, NextProject, Project, SessionResponse, Task } from "./lib/types";
import { CalendarPage } from "./pages/CalendarPage";
import { LoginPage } from "./pages/LoginPage";
import { NextPage } from "./pages/NextPage";
import type { TaskPageProps } from "./pages/pageProps";
import { ProjectsPage } from "./pages/ProjectsPage";
import { SearchPage } from "./pages/SearchPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TodayPage } from "./pages/TodayPage";
import { appReducer, initialState, sortedProjects, sortedTasks } from "./state/appStore";

const PROJECT_COLORS = ["#1f6f68", "#a64b2a", "#5b6c5d", "#3f5f8f", "#7a5c99", "#8a6a23"];
const PROJECT_ARCHIVE_MARKER_KEY = "archived_with_project_id";
const TASK_PATCH_FIELDS = [
  "project_id",
  "title",
  "description",
  "status",
  "priority",
  "due_date",
  "start_date",
  "completed_at",
  "next_action",
  "notes",
  "sort_order",
  "parent_task_id",
  "source",
  "external_key",
  "extra_json",
  "archived"
] as const;
const PROJECT_PATCH_FIELDS = ["name", "description", "color", "sort_order", "archived"] as const;
const NEXT_PROJECT_PATCH_FIELDS = ["name", "description", "color", "sort_order", "archived"] as const;
const NEXT_IDEA_PATCH_FIELDS = ["next_project_id", "title", "note", "sort_order", "extra_json"] as const;

function pickMutationPatch(changes: Record<string, unknown>, allowed: readonly string[]): Record<string, unknown> {
  const patch: Record<string, unknown> = {};
  for (const key of allowed) {
    if (Object.prototype.hasOwnProperty.call(changes, key)) patch[key] = changes[key];
  }
  return patch;
}

function putLocal(store: LocalEntityWrite["store"], record: SavableEntity): LocalEntityWrite {
  return { type: "put", store, record };
}

function deleteLocal(store: LocalEntityWrite["store"], id: string): LocalEntityWrite {
  return { type: "delete", store, id };
}

// Wire the SyncEngine's injected IO to the real network / IndexedDB / Excel
// implementations. Everything here is a thin pass-through so the engine itself
// stays free of browser globals and remains unit-testable with fakes.
const baseSyncIO: Omit<SyncIO, "publishSyncHint"> = {
  getSession,
  bootstrap,
  sendMutations,
  getExportData,
  uploadCloudExcel,
  // Build the autosync workbook off the main thread; fall back to an inline
  // build when workers are unavailable (e.g. very old WebKit).
  workbookBlob: async (data, signal) => {
    try {
      return await buildWorkbookBlobInWorker(data, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (!(error instanceof WorkbookWorkerUnavailableError)) throw error;
      const { workbookBlob } = await import("./lib/excelExport");
      if (signal?.aborted) throw signal.reason ?? new DOMException("Excel workbook build aborted", "AbortError");
      let blob: Blob;
      try {
        blob = workbookBlob(data);
      } catch (buildError) {
        throw new WorkbookWorkerBuildError(
          buildError instanceof Error ? buildError.message : "Excel workbook build failed"
        );
      }
      if (signal?.aborted) throw signal.reason ?? new DOMException("Excel workbook build aborted", "AbortError");
      return blob;
    }
  },
  commitLocalMutation: (mutation, commit) =>
    withLocalDataLease(async () => {
      if (isLogoutBarrierActive()) throw new Error("Signing out in another tab");
      return commitLocalMutation(mutation, commit);
    }),
  loadLocalSnapshot,
  getPendingMutations,
  removePendingMutations: (ids) =>
    withLocalDataLease(async () => {
      if (isLogoutBarrierActive()) throw new Error("Signing out in another tab");
      await removePendingMutations(ids);
    }),
  saveBootstrapSnapshot: (snapshot, replaceMode, removeIds) =>
    withLocalDataLease(async () => {
      if (isLogoutBarrierActive()) throw new Error("Signing out in another tab");
      await saveBootstrapSnapshot(snapshot, replaceMode, removeIds);
    }),
  saveLocalSession: (session) =>
    withLocalDataLease(async () => {
      if (session && isLogoutBarrierActive()) throw new Error("Signing out in another tab");
      await saveLocalSession(session);
    }),
  saveLastSync: (value) =>
    withLocalDataLease(async () => {
      if (isLogoutBarrierActive()) throw new Error("Signing out in another tab");
      await setLastSync(value);
    }),
  isOnline: () => navigator.onLine,
  now: nowIso,
  withSyncLease,
  sendBeacon: (url, body) => navigator.sendBeacon?.(url, body) ?? false
};

export function App() {
  const { m } = useI18n();
  const [state, dispatch] = useReducer(appReducer, initialState);
  const stateRef = useRef(state);
  const clientId = useMemo(() => getOrCreateClientId(), []);
  const tabId = useMemo(() => crypto.randomUUID(), []);
  const engineIO = useMemo<SyncIO>(() => ({ ...baseSyncIO, publishSyncHint: () => publishSyncHint(tabId) }), [tabId]);
  const engineRef = useRef<SyncEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new SyncEngine({ stateRef, dispatch, clientId, io: engineIO });
  }
  const engine = engineRef.current;
  const { syncNow, forceFullResync, flushPendingWithKeepalive } = engine;

  async function validateAndCacheSession(): Promise<SessionResponse | null> {
    if (!navigator.onLine) return null;
    if (isLogoutBarrierActive() && !isLogoutBarrierStale()) return null;
    const session = await getSession();
    // Recheck after the request because another tab may have started logout
    // while the cookie validation was in flight.
    if (isLogoutBarrierActive()) {
      if (!isLogoutBarrierStale()) return null;
      releaseLogoutBarrier(tabId);
    }
    engine.resume();
    await engineIO.saveLocalSession(session);
    return session;
  }

  async function recoverAuthenticatedSession(): Promise<void> {
    try {
      const session = await validateAndCacheSession();
      if (!session) return;
      stateRef.current = { ...stateRef.current, session, authRequired: false };
      dispatch({ type: "setSession", payload: session });
      if (navigator.onLine) engine.scheduleSync();
    } catch (error) {
      if (error instanceof AuthRequiredError) {
        await engineIO.saveLocalSession(null).catch(() => undefined);
        stateRef.current = { ...stateRef.current, session: null, authRequired: true };
        dispatch({ type: "setSession", payload: null });
        dispatch({ type: "setAuthRequired", payload: true });
      } else {
        dispatch({ type: "setError", payload: error instanceof Error ? error.message : "Session validation failed" });
      }
    }
  }

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    let cancelled = false;
    let barrierRetryTimer: number | null = null;

    async function start() {
      dispatch({ type: "setSyncStatus", payload: "loading" });
      try {
        const local = await loadLocalSnapshot();
        if (cancelled) return;
        engine.hydratePending(local.pendingMutations);
        const overlaid = replayPendingMutations(local, local.pendingMutations);
        const payload = {
          projects: overlaid.projects,
          tasks: overlaid.tasks,
          nextProjects: overlaid.nextProjects,
          nextIdeas: overlaid.nextIdeas,
          settings: overlaid.settings,
          pendingCount: compactPendingMutations(local.pendingMutations).length,
          lastSync: local.lastSync,
          syncEpoch: local.syncEpoch,
          syncCursor: local.syncCursor
        };
        const cachedSession =
          !navigator.onLine && !isLogoutBarrierActive() && isCachedSessionUsable(local.session)
            ? local.session
            : null;
        stateRef.current = { ...stateRef.current, ...payload, session: cachedSession, authRequired: !cachedSession };
        dispatch({ type: "hydrateLocal", payload });
        if (cachedSession) dispatch({ type: "setSession", payload: cachedSession });

        if (!navigator.onLine) {
          if (local.session && !cachedSession) await engineIO.saveLocalSession(null).catch(() => undefined);
          dispatch({ type: "setSyncStatus", payload: "offline" });
          return;
        }

        const session = await validateAndCacheSession();
        if (cancelled) return;
        if (!session) {
          const retryDelay = logoutBarrierRetryDelay();
          barrierRetryTimer = window.setTimeout(() => {
            if (!cancelled) void start();
          }, Math.max(50, retryDelay + 25));
          dispatch({ type: "setSyncStatus", payload: "idle" });
          return;
        }
        stateRef.current = { ...stateRef.current, session, authRequired: false };
        dispatch({ type: "setSession", payload: session });
        await syncNow();
      } catch (error) {
        if (cancelled) return;
        if (error instanceof AuthRequiredError) {
          await engineIO.saveLocalSession(null).catch(() => undefined);
          stateRef.current = { ...stateRef.current, session: null, authRequired: true };
          dispatch({ type: "setAuthRequired", payload: true });
          dispatch({ type: "setSyncStatus", payload: "idle" });
        } else if (stateRef.current.session) {
          dispatch({ type: "setError", payload: error instanceof Error ? error.message : "Startup sync failed" });
          dispatch({ type: "setSyncStatus", payload: navigator.onLine ? "error" : "offline" });
        } else {
          dispatch({ type: "setError", payload: error instanceof Error ? error.message : "Startup failed" });
          dispatch({ type: "setSyncStatus", payload: "error" });
        }
      }
    }

    void start();
    return () => {
      cancelled = true;
      if (barrierRetryTimer !== null) window.clearTimeout(barrierRetryTimer);
    };
  }, [engine, engineIO, syncNow]);

  useEffect(() => {
    let logoutRecoveryTimer: number | null = null;
    function handleOnline() {
      dispatch({ type: "setOnline", payload: navigator.onLine });
      if (!navigator.onLine) return;
      if (stateRef.current.authRequired) void recoverAuthenticatedSession();
      else void syncNow();
    }
    function handleFocus() {
      if (navigator.onLine && !stateRef.current.authRequired) void syncNow();
    }
    function handleVisibilityChange() {
      if (document.visibilityState === "visible" && navigator.onLine && !stateRef.current.authRequired) void syncNow();
    }
    const unsubscribe = subscribeToSyncEvents(tabId, {
      onSyncHint: () => {
        // The source tab owns the network push. Peers adopt the shared durable
        // outbox immediately and use focus/leader polling as the safety net.
        void engine.adoptPendingFromStorage();
      },
      onLogoutStart: () => {
        void engine.suspend();
        if (logoutRecoveryTimer !== null) window.clearTimeout(logoutRecoveryTimer);
        logoutRecoveryTimer = window.setTimeout(() => {
          if (navigator.onLine && isLogoutBarrierActive() && isLogoutBarrierStale()) {
            void recoverAuthenticatedSession();
          }
        }, logoutBarrierRetryDelay() + 25);
      },
      onLogoutCancel: () => {
        if (logoutRecoveryTimer !== null) window.clearTimeout(logoutRecoveryTimer);
        engine.resume();
        if (navigator.onLine && stateRef.current.authRequired) void recoverAuthenticatedSession();
        else if (navigator.onLine) engine.scheduleSync();
      },
      onLogoutComplete: () => {
        if (logoutRecoveryTimer !== null) window.clearTimeout(logoutRecoveryTimer);
        void engine.suspend();
        applyLoggedOutState();
      }
    });
    const interval = window.setInterval(async () => {
      if (
        navigator.onLine &&
        document.visibilityState === "visible" &&
        !stateRef.current.authRequired &&
        (await claimBackgroundPoll(tabId))
      ) void syncNow();
    }, 30_000);
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOnline);
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      window.clearInterval(interval);
      if (logoutRecoveryTimer !== null) window.clearTimeout(logoutRecoveryTimer);
      unsubscribe();
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOnline);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [engine, syncNow, tabId]);

  useEffect(() => () => engine.dispose(), [engine]);

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

  const persistMutation = engine.persistMutation.bind(engine);

  function updateTask(task: Task, changes: Partial<Task>) {
    const next: Task = { ...task, ...changes, updated_at: nowIso(), version: task.version + 1 };
    dispatch({ type: "upsertTask", payload: next });
    stateRef.current = { ...stateRef.current, tasks: upsertRecord(stateRef.current.tasks, next) };
    persistMutation(
      {
        id: newMutationId(),
        entity: "task",
        operation: "upsert",
        baseVersion: task.version,
        data: next,
        patch: pickMutationPatch(changes as Record<string, unknown>, TASK_PATCH_FIELDS)
      },
      { writes: [putLocal("tasks", next)] }
    );
  }

  function createTask(input: Partial<Task> & { title: string }): string {
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
    persistMutation(
      { id: newMutationId(), entity: "task", operation: "upsert", baseVersion: null, data: task },
      { writes: [putLocal("tasks", task)] }
    );
    return task.id;
  }

  function deleteTask(task: Task) {
    dispatch({ type: "purgeTask", payload: task.id });
    stateRef.current = { ...stateRef.current, tasks: removeRecord(stateRef.current.tasks, task.id) };
    persistMutation(
      {
        id: newMutationId(),
        entity: "task",
        operation: "delete",
        baseVersion: task.version,
        data: { id: task.id }
      },
      { writes: [deleteLocal("tasks", task.id)] }
    );
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
    persistMutation(
      { id: newMutationId(), entity: "project", operation: "upsert", baseVersion: null, data: project },
      { writes: [putLocal("projects", project)] }
    );
    return project.id;
  }

  // Archiving a project cascades only to currently active tasks. Those tasks get
  // a marker so restoring the project can restore them without reviving tasks
  // the user had archived on purpose before the project was archived.
  function setProjectArchived(project: Project, archived: 0 | 1) {
    const timestamp = nowIso();
    const next = { ...project, archived, updated_at: timestamp, version: project.version + 1 };
    dispatch({ type: "upsertProject", payload: next });
    stateRef.current = { ...stateRef.current, projects: upsertRecord(stateRef.current.projects, next) };

    const tasksToToggle = stateRef.current.tasks.filter(
      (task) =>
        task.project_id === project.id &&
        !task.deleted_at &&
        (archived === 1
          ? task.archived === 0
          : task.archived === 1 && parseTaskExtra(task)[PROJECT_ARCHIVE_MARKER_KEY] === project.id)
    );
    for (const task of tasksToToggle) {
      const extra = parseTaskExtra(task);
      if (archived === 1) {
        extra[PROJECT_ARCHIVE_MARKER_KEY] = project.id;
      } else {
        extra[PROJECT_ARCHIVE_MARKER_KEY] = undefined;
      }
      const nextTask: Task = {
        ...task,
        archived,
        extra_json: stringifyTaskExtra(extra),
        updated_at: timestamp,
        version: task.version + 1
      };
      dispatch({ type: "upsertTask", payload: nextTask });
      stateRef.current = { ...stateRef.current, tasks: upsertRecord(stateRef.current.tasks, nextTask) };
      persistMutation(
        {
          id: newMutationId(),
          entity: "task",
          operation: "upsert",
          baseVersion: task.version,
          data: nextTask,
          patch: { archived, extra_json: nextTask.extra_json }
        },
        { writes: [putLocal("tasks", nextTask)] }
      );
    }

    if (archived === 1 && stateRef.current.filters.projectId === project.id) {
      const filters = { ...stateRef.current.filters, projectId: "" };
      stateRef.current = { ...stateRef.current, filters };
      dispatch({ type: "setFilters", payload: { projectId: "" } });
    }
    persistMutation(
      {
        id: newMutationId(),
        entity: "project",
        operation: "upsert",
        baseVersion: project.version,
        data: next,
        patch: { archived }
      },
      { writes: [putLocal("projects", next)] }
    );
  }

  function archiveProject(project: Project) {
    setProjectArchived(project, 1);
  }

  function unarchiveProject(project: Project) {
    setProjectArchived(project, 0);
  }

  function deleteProject(project: Project) {
    const purgedTasks = stateRef.current.tasks.filter((task) => task.project_id === project.id);
    const purgedTaskIds = purgedTasks.map((task) => task.id);
    const purgedTaskIdSet = new Set(purgedTaskIds);

    dispatch({ type: "purgeProject", payload: project.id });
    stateRef.current = {
      ...stateRef.current,
      projects: removeRecord(stateRef.current.projects, project.id),
      tasks: stateRef.current.tasks.filter((task) => !purgedTaskIdSet.has(task.id))
    };
    if (stateRef.current.filters.projectId === project.id) {
      const filters = { ...stateRef.current.filters, projectId: "" };
      stateRef.current = { ...stateRef.current, filters };
      dispatch({ type: "setFilters", payload: { projectId: "" } });
    }

    const staleMutationIds = engine.pendingMutations()
      .filter((mutation) => {
        const key = mutationRecordKey(mutation);
        return key ? purgedTaskIds.some((id) => key === `task:${id}`) : false;
      })
      .map((mutation) => mutation.id);

    persistMutation(
      {
        id: newMutationId(),
        entity: "project",
        operation: "delete",
        baseVersion: project.version,
        data: { id: project.id, taskIds: purgedTaskIds }
      },
      {
        writes: [deleteLocal("projects", project.id), ...purgedTaskIds.map((id) => deleteLocal("tasks", id))],
        removePendingIds: staleMutationIds
      }
    );
  }

  function renameProject(project: Project, name: string) {
    const clean = name.trim();
    if (!clean || clean === project.name) {
      return;
    }
    const next = { ...project, name: clean, updated_at: nowIso(), version: project.version + 1 };
    dispatch({ type: "upsertProject", payload: next });
    stateRef.current = { ...stateRef.current, projects: upsertRecord(stateRef.current.projects, next) };
    persistMutation(
      {
        id: newMutationId(),
        entity: "project",
        operation: "upsert",
        baseVersion: project.version,
        data: next,
        patch: { name: clean }
      },
      { writes: [putLocal("projects", next)] }
    );

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

  function createNextProject(name: string): string {
    const timestamp = nowIso();
    const clean = name.trim();
    const project: NextProject = {
      id: newId(),
      name: clean || "New idea group",
      description: null,
      color: PROJECT_COLORS[stateRef.current.nextProjects.length % PROJECT_COLORS.length],
      sort_order: stateRef.current.nextProjects.length,
      source_project_id: null,
      archived: 0,
      created_at: timestamp,
      updated_at: timestamp,
      deleted_at: null,
      version: 1
    };
    dispatch({ type: "upsertNextProject", payload: project });
    stateRef.current = { ...stateRef.current, nextProjects: upsertRecord(stateRef.current.nextProjects, project) };
    persistMutation(
      { id: newMutationId(), entity: "next_project", operation: "upsert", baseVersion: null, data: project },
      { writes: [putLocal("nextProjects", project)] }
    );
    return project.id;
  }

  function updateNextProject(project: NextProject, changes: Partial<NextProject>) {
    const cleanName = changes.name === undefined ? project.name : changes.name.trim();
    if (!cleanName) {
      return;
    }
    const next: NextProject = {
      ...project,
      ...changes,
      name: cleanName,
      source_project_id: project.source_project_id ?? null,
      updated_at: nowIso(),
      version: project.version + 1
    };
    dispatch({ type: "upsertNextProject", payload: next });
    stateRef.current = { ...stateRef.current, nextProjects: upsertRecord(stateRef.current.nextProjects, next) };
    const patch = pickMutationPatch(changes as Record<string, unknown>, NEXT_PROJECT_PATCH_FIELDS);
    if (Object.prototype.hasOwnProperty.call(changes, "name")) patch.name = cleanName;
    persistMutation(
      {
        id: newMutationId(),
        entity: "next_project",
        operation: "upsert",
        baseVersion: project.version,
        data: next,
        patch
      },
      { writes: [putLocal("nextProjects", next)] }
    );
  }

  function deleteNextProject(project: NextProject) {
    const purgedIdeas = stateRef.current.nextIdeas.filter((idea) => idea.next_project_id === project.id);
    const purgedIdeaIds = purgedIdeas.map((idea) => idea.id);
    const purgedIdeaSet = new Set(purgedIdeaIds);

    dispatch({ type: "purgeNextProject", payload: project.id });
    stateRef.current = {
      ...stateRef.current,
      nextProjects: removeRecord(stateRef.current.nextProjects, project.id),
      nextIdeas: stateRef.current.nextIdeas.filter((idea) => !purgedIdeaSet.has(idea.id))
    };
    const staleMutationIds = engine.pendingMutations()
      .filter((mutation) => {
        const key = mutationRecordKey(mutation);
        return key ? purgedIdeaIds.some((id) => key === `next_idea:${id}`) : false;
      })
      .map((mutation) => mutation.id);

    persistMutation(
      {
        id: newMutationId(),
        entity: "next_project",
        operation: "delete",
        baseVersion: project.version,
        data: { id: project.id, ideaIds: purgedIdeaIds }
      },
      {
        writes: [deleteLocal("nextProjects", project.id), ...purgedIdeaIds.map((id) => deleteLocal("nextIdeas", id))],
        removePendingIds: staleMutationIds
      }
    );
  }

  function createNextIdea(input: Partial<NextIdea> & { next_project_id: string; title: string }) {
    const timestamp = nowIso();
    const idea: NextIdea = {
      id: newId(),
      next_project_id: input.next_project_id,
      title: input.title,
      note: input.note ?? null,
      sort_order: input.sort_order ?? Date.now(),
      source_task_id: null,
      extra_json: input.extra_json ?? null,
      created_at: timestamp,
      updated_at: timestamp,
      deleted_at: null,
      version: 1
    };
    dispatch({ type: "upsertNextIdea", payload: idea });
    stateRef.current = { ...stateRef.current, nextIdeas: upsertRecord(stateRef.current.nextIdeas, idea) };
    persistMutation(
      { id: newMutationId(), entity: "next_idea", operation: "upsert", baseVersion: null, data: idea },
      { writes: [putLocal("nextIdeas", idea)] }
    );
  }

  function updateNextIdea(idea: NextIdea, changes: Partial<NextIdea>) {
    const next: NextIdea = {
      ...idea,
      ...changes,
      source_task_id: idea.source_task_id ?? null,
      updated_at: nowIso(),
      version: idea.version + 1
    };
    dispatch({ type: "upsertNextIdea", payload: next });
    stateRef.current = { ...stateRef.current, nextIdeas: upsertRecord(stateRef.current.nextIdeas, next) };
    persistMutation(
      {
        id: newMutationId(),
        entity: "next_idea",
        operation: "upsert",
        baseVersion: idea.version,
        data: next,
        patch: pickMutationPatch(changes as Record<string, unknown>, NEXT_IDEA_PATCH_FIELDS)
      },
      { writes: [putLocal("nextIdeas", next)] }
    );
  }

  function deleteNextIdea(idea: NextIdea) {
    dispatch({ type: "purgeNextIdea", payload: idea.id });
    stateRef.current = { ...stateRef.current, nextIdeas: removeRecord(stateRef.current.nextIdeas, idea.id) };

    persistMutation(
      {
        id: newMutationId(),
        entity: "next_idea",
        operation: "delete",
        baseVersion: idea.version,
        data: { id: idea.id }
      },
      { writes: [deleteLocal("nextIdeas", idea.id)] }
    );
  }

  async function handleImport(filename: string, rows: ImportRow[]) {
    const result = await importRows(filename, rows);
    await syncNow();
    return result;
  }

  async function handleLogin(password: string) {
    await login(password);
    await completeAuth();
  }

  // First-run setup: /api/auth/setup stores the new passcode and signs in.
  async function handleSetup(password: string, setupToken: string) {
    await setupPassword(password, setupToken);
    await completeAuth();
  }

  async function completeAuth() {
    engine.markFullBootstrapPending();
    const session = await getSession();
    releaseLogoutBarrier(tabId);
    engine.resume();
    await engineIO.saveLocalSession(session);
    const local = await loadLocalSnapshot();
    engine.hydratePending(local.pendingMutations);
    const overlaid = replayPendingMutations(local, local.pendingMutations);
    const payload = {
      projects: overlaid.projects,
      tasks: overlaid.tasks,
      nextProjects: overlaid.nextProjects,
      nextIdeas: overlaid.nextIdeas,
      settings: overlaid.settings,
      pendingCount: compactPendingMutations(local.pendingMutations).length,
      lastSync: local.lastSync,
      syncEpoch: local.syncEpoch,
      syncCursor: local.syncCursor
    };
    stateRef.current = { ...stateRef.current, ...payload, session, authRequired: false };
    dispatch({ type: "hydrateLocal", payload });
    dispatch({ type: "setSession", payload: session });
    await syncNow();
  }

  // Sign-out clears the local cache so the data isn't readable on a shared
  // device afterwards. Pending edits are flushed first; if any still can't
  // sync (offline), the user must explicitly accept losing them.
  async function handleLogout() {
    const previousSession = stateRef.current.session;
    let remoteLoggedOut = false;
    let pending: Awaited<ReturnType<typeof engine.suspend>>;
    try {
      pending = await engine.suspend();
      if (navigator.onLine && pending.length > 0) pending = await engine.flushWhileSuspended();
    } catch (error) {
      engine.resume();
      dispatch({ type: "setError", payload: error instanceof Error ? `Sign out preparation failed: ${error.message}` : "Sign out preparation failed" });
      return;
    }
    // Flush while normal sync persistence is still allowed. The barrier begins
    // afterwards and the exclusive local-data lease below waits for any peer
    // commit that was already in flight before it rereads the durable outbox.
    beginLogoutBarrier(tabId);
    try {
      pending = await withLocalDataLease(() => getPendingMutations());
    } catch (error) {
      finishLogoutBarrier(tabId, false);
      engine.resume();
      dispatch({ type: "setError", payload: error instanceof Error ? `Sign out preparation failed: ${error.message}` : "Sign out preparation failed" });
      return;
    }
    const pendingCount = compactPendingMutations(pending).length;
    if (pendingCount > 0 && !window.confirm(m.settings.signOutPendingConfirm(pendingCount))) {
      finishLogoutBarrier(tabId, false);
      engine.resume();
      if (navigator.onLine) engine.scheduleSync();
      return;
    }
    try {
      await withLocalDataLease(async () => {
        // Removing cached auth is a separate committed transaction. Even if the
        // later bulk reset fails, an offline restart cannot reuse the old grant.
        await saveLocalSession(null);
        try {
          await logout();
        } catch (error) {
          if (!(error instanceof AuthRequiredError)) throw error;
        }
        remoteLoggedOut = true;
        await resetLocalData();
      });
    } catch (error) {
      if (!remoteLoggedOut) {
        finishLogoutBarrier(tabId, false);
        engine.resume();
        if (previousSession) await engineIO.saveLocalSession(previousSession).catch(() => undefined);
        if (navigator.onLine) engine.scheduleSync();
        dispatch({ type: "setError", payload: error instanceof Error ? `Sign out failed: ${error.message}` : "Sign out failed" });
        return;
      }
      finishLogoutBarrier(tabId, true);
      applyLoggedOutState();
      dispatch({ type: "setError", payload: error instanceof Error ? `Local sign-out cleanup failed: ${error.message}` : "Local sign-out cleanup failed" });
      return;
    }
    finishLogoutBarrier(tabId, true);
    applyLoggedOutState();
  }

  function applyLoggedOutState() {
    engine.hydratePending([]);
    const empty = {
      projects: [],
      tasks: [],
      nextProjects: [],
      nextIdeas: [],
      settings: {},
      pendingCount: 0,
      lastSync: null,
      syncEpoch: null,
      syncCursor: null
    };
    stateRef.current = { ...stateRef.current, ...empty, session: null, authRequired: true };
    dispatch({ type: "hydrateLocal", payload: empty });
    dispatch({ type: "setLastExport", payload: null });
    dispatch({ type: "setSession", payload: null });
    dispatch({ type: "setAuthRequired", payload: true });
  }

  const projects = useMemo(() => sortedProjects(state.projects), [state.projects]);
  const archivedProjects = useMemo(
    () =>
      state.projects
        .filter((project) => !project.deleted_at && project.archived === 1)
        .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
    [state.projects]
  );
  const tasks = useMemo(() => sortedTasks(state.tasks), [state.tasks]);
  const nextProjects = useMemo(
    () =>
      state.nextProjects
        .filter((project) => !project.deleted_at && project.archived === 0)
        .sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)),
    [state.nextProjects]
  );
  const nextIdeas = useMemo(
    () =>
      state.nextIdeas
        .filter((idea) => !idea.deleted_at)
        .sort((a, b) => a.sort_order - b.sort_order || a.created_at.localeCompare(b.created_at) || a.title.localeCompare(b.title)),
    [state.nextIdeas]
  );
  const pageProps: TaskPageProps = {
    projects,
    archivedProjects,
    tasks,
    nextProjects,
    nextIdeas,
    filters: state.filters,
    onFiltersChange: (filters) => dispatch({ type: "setFilters", payload: filters }),
    onCreateTask: createTask,
    onUpdateTask: updateTask,
    onDeleteTask: deleteTask,
    onCreateProject: createProject,
    onArchiveProject: archiveProject,
    onUnarchiveProject: unarchiveProject,
    onDeleteProject: deleteProject,
    onRenameProject: renameProject,
    onCreateNextProject: createNextProject,
    onUpdateNextProject: updateNextProject,
    onDeleteNextProject: deleteNextProject,
    onCreateNextIdea: createNextIdea,
    onUpdateNextIdea: updateNextIdea,
    onDeleteNextIdea: deleteNextIdea
  };

  if (state.authRequired) {
    return <LoginPage onLogin={handleLogin} onSetup={handleSetup} />;
  }

  return (
    <div className="app-shell">
      <OfflineBanner online={state.online} pendingCount={state.pendingCount} syncStatus={state.syncStatus} error={state.error} onSync={syncNow} />
      {state.currentTab === "today" ? <TodayPage {...pageProps} initialDate={state.selectedDate} /> : null}
      {state.currentTab === "calendar" ? (
        <CalendarPage
          {...pageProps}
          initialDate={state.selectedDate}
          onOpenDay={(date) => {
            dispatch({ type: "setSelectedDate", payload: date });
            dispatch({ type: "setTab", payload: "today" });
          }}
        />
      ) : null}
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
          syncError={state.error}
          conflicts={state.conflicts}
          session={state.session}
          worklogOverview={summarizeWorklogOverview(visibleTasks(state.tasks))}
          onImport={handleImport}
          onExported={(timestamp) => dispatch({ type: "setLastExport", payload: timestamp })}
          onSync={syncNow}
          onForceResync={() => void forceFullResync()}
          onLogout={() => void handleLogout()}
        />
      ) : null}
      <BottomNav
        current={state.currentTab}
        onChange={(tab) => {
          if (tab === "today") {
            dispatch({ type: "setSelectedDate", payload: null });
          }
          dispatch({ type: "setTab", payload: tab });
        }}
      />
    </div>
  );
}
