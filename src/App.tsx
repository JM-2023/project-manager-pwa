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
  uploadCloudExcel
} from "./lib/api";
import { nowIso } from "./lib/dates";
import { getOrCreateClientId, newId, newMutationId } from "./lib/ids";
import {
  getPendingMutations,
  loadLocalSnapshot,
  purgeNextIdeaData,
  purgeNextProjectData,
  purgeProjectData,
  purgeTaskData,
  queueMutation,
  removePendingMutations,
  resetLocalData,
  saveBootstrapSnapshot,
  saveEntity
} from "./lib/localDb";
import { parseTaskExtra, stringifyTaskExtra, summarizeWorklogOverview } from "./lib/progress";
import { visibleProjects, visibleTasks } from "./lib/sync";
import { compactPendingMutations, mutationData, mutationRecordKey, removeRecord, upsertRecord, upsertTaskTagRecord } from "./lib/syncMerge";
import { SyncEngine, type SyncIO } from "./lib/syncEngine";
import type { ImportRow, NextIdea, NextProject, Project, Tag, Task, TaskTag } from "./lib/types";
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

// Wire the SyncEngine's injected IO to the real network / IndexedDB / Excel
// implementations. Everything here is a thin pass-through so the engine itself
// stays free of browser globals and remains unit-testable with fakes.
const syncIO: SyncIO = {
  getSession,
  bootstrap,
  sendMutations,
  getExportData,
  uploadCloudExcel,
  workbookBlob: async (data) => {
    const { workbookBlob } = await import("./lib/excelExport");
    return workbookBlob(data);
  },
  queueMutation,
  getPendingMutations,
  removePendingMutations,
  saveBootstrapSnapshot,
  saveEntity,
  resetLocalData,
  isOnline: () => navigator.onLine,
  now: nowIso,
  sendBeacon: (url, body) => navigator.sendBeacon?.(url, body) ?? false
};

export function App() {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const stateRef = useRef(state);
  const clientId = useMemo(() => getOrCreateClientId(), []);
  const engineRef = useRef<SyncEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new SyncEngine({ stateRef, dispatch, clientId, io: syncIO });
  }
  const engine = engineRef.current;
  const { syncNow, forceFullResync, flushPendingWithKeepalive, scheduleCloudExcelUpload } = engine;

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    let cancelled = false;

    async function start() {
      dispatch({ type: "setSyncStatus", payload: "loading" });
      try {
        const session = await getSession();
        if (cancelled) return;

        const local = await loadLocalSnapshot();
        if (cancelled) return;
        engine.hydratePending(local.pendingMutations);
        const payload = {
          projects: local.projects,
          tasks: local.tasks,
          tags: local.tags,
          taskTags: local.taskTags,
          nextProjects: local.nextProjects,
          nextIdeas: local.nextIdeas,
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
  }, [engine, syncNow]);

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

  const persistMutation = engine.persistMutation.bind(engine);

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
    // Irreversible hard delete: the task and its tag links are removed everywhere
    // (no tombstone). The server purge mutation does the same cascade in D1.
    const purgedTagKeys = stateRef.current.taskTags
      .filter((link) => link.task_id === task.id)
      .map((link) => `${link.task_id}:${link.tag_id}`);

    dispatch({ type: "purgeTask", payload: task.id });
    stateRef.current = {
      ...stateRef.current,
      tasks: removeRecord(stateRef.current.tasks, task.id),
      taskTags: stateRef.current.taskTags.filter((link) => link.task_id !== task.id)
    };
    void purgeTaskData(task.id, purgedTagKeys);

    // Drop any queued edits for this task / its tag links so a late upsert can't
    // resurrect a row the purge already removed.
    const staleMutationIds = engine.pendingMutations()
      .filter((mutation) => {
        if (mutation.entity === "task_tag") {
          return String(mutationData(mutation).task_id ?? "") === task.id;
        }
        const key = mutationRecordKey(mutation);
        return key === `task:${task.id}`;
      })
      .map((mutation) => mutation.id);
    if (staleMutationIds.length > 0) {
      engine.dropPendingMutations(staleMutationIds);
    }

    void persistMutation({
      id: newMutationId(),
      entity: "task",
      operation: "purge",
      baseVersion: task.version,
      data: { id: task.id }
    });
  }

  // Archive is a recoverable soft state (archived = 1), kept distinct from the
  // irreversible hard delete above.
  function archiveTask(task: Task) {
    const next: Task = { ...task, archived: 1, updated_at: nowIso(), version: task.version + 1 };
    dispatch({ type: "upsertTask", payload: next });
    stateRef.current = { ...stateRef.current, tasks: upsertRecord(stateRef.current.tasks, next) };
    void saveEntity("tasks", next);
    void persistMutation({ id: newMutationId(), entity: "task", operation: "upsert", baseVersion: task.version, data: next });
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
      void saveEntity("tasks", nextTask);
      void persistMutation({ id: newMutationId(), entity: "task", operation: "upsert", baseVersion: task.version, data: nextTask });
    }

    if (archived === 1 && stateRef.current.filters.projectId === project.id) {
      const filters = { ...stateRef.current.filters, projectId: "" };
      stateRef.current = { ...stateRef.current, filters };
      dispatch({ type: "setFilters", payload: { projectId: "" } });
    }
    void saveEntity("projects", next);
    void persistMutation({ id: newMutationId(), entity: "project", operation: "upsert", baseVersion: project.version, data: next });
  }

  function archiveProject(project: Project) {
    setProjectArchived(project, 1);
  }

  function unarchiveProject(project: Project) {
    setProjectArchived(project, 0);
  }

  function deleteProject(project: Project) {
    // Irreversible cascade hard delete: the project, its tasks, and those tasks'
    // tag links are removed everywhere (no tombstone). The server purge mutation
    // does the same cascade in D1.
    const purgedTasks = stateRef.current.tasks.filter((task) => task.project_id === project.id);
    const purgedTaskIds = purgedTasks.map((task) => task.id);
    const purgedTaskIdSet = new Set(purgedTaskIds);
    const purgedTagKeys = stateRef.current.taskTags
      .filter((link) => purgedTaskIdSet.has(link.task_id))
      .map((link) => `${link.task_id}:${link.tag_id}`);

    dispatch({ type: "purgeProject", payload: project.id });
    stateRef.current = {
      ...stateRef.current,
      projects: removeRecord(stateRef.current.projects, project.id),
      tasks: stateRef.current.tasks.filter((task) => !purgedTaskIdSet.has(task.id)),
      taskTags: stateRef.current.taskTags.filter((link) => !purgedTaskIdSet.has(link.task_id))
    };
    void purgeProjectData(project.id, purgedTaskIds, purgedTagKeys);
    if (stateRef.current.filters.projectId === project.id) {
      const filters = { ...stateRef.current.filters, projectId: "" };
      stateRef.current = { ...stateRef.current, filters };
      dispatch({ type: "setFilters", payload: { projectId: "" } });
    }

    // Drop any still-queued edits for the purged tasks/links so a late upsert in
    // a later sync can't resurrect a row the purge already removed. (The project's
    // own pending edits are superseded by the purge during mutation compaction.)
    const staleMutationIds = engine.pendingMutations()
      .filter((mutation) => {
        if (mutation.entity === "task_tag") {
          return purgedTaskIdSet.has(String(mutationData(mutation).task_id ?? ""));
        }
        const key = mutationRecordKey(mutation);
        return key ? key === `project:${project.id}` || purgedTaskIds.some((id) => key === `task:${id}`) : false;
      })
      .map((mutation) => mutation.id);
    if (staleMutationIds.length > 0) {
      engine.dropPendingMutations(staleMutationIds);
    }

    void persistMutation({
      id: newMutationId(),
      entity: "project",
      operation: "purge",
      baseVersion: project.version,
      data: { id: project.id }
    });
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
    void saveEntity("nextProjects", project);
    void persistMutation({ id: newMutationId(), entity: "next_project", operation: "upsert", baseVersion: null, data: project });
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
    void saveEntity("nextProjects", next);
    void persistMutation({ id: newMutationId(), entity: "next_project", operation: "upsert", baseVersion: project.version, data: next });
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
    void purgeNextProjectData(project.id, purgedIdeaIds);

    const staleMutationIds = engine.pendingMutations()
      .filter((mutation) => {
        const key = mutationRecordKey(mutation);
        return key ? key === `next_project:${project.id}` || purgedIdeaIds.some((id) => key === `next_idea:${id}`) : false;
      })
      .map((mutation) => mutation.id);
    if (staleMutationIds.length > 0) {
      engine.dropPendingMutations(staleMutationIds);
    }

    void persistMutation({
      id: newMutationId(),
      entity: "next_project",
      operation: "purge",
      baseVersion: project.version,
      data: { id: project.id }
    });
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
    void saveEntity("nextIdeas", idea);
    void persistMutation({ id: newMutationId(), entity: "next_idea", operation: "upsert", baseVersion: null, data: idea });
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
    void saveEntity("nextIdeas", next);
    void persistMutation({ id: newMutationId(), entity: "next_idea", operation: "upsert", baseVersion: idea.version, data: next });
  }

  function deleteNextIdea(idea: NextIdea) {
    dispatch({ type: "purgeNextIdea", payload: idea.id });
    stateRef.current = { ...stateRef.current, nextIdeas: removeRecord(stateRef.current.nextIdeas, idea.id) };
    void purgeNextIdeaData(idea.id);

    const staleMutationIds = engine.pendingMutations()
      .filter((mutation) => mutationRecordKey(mutation) === `next_idea:${idea.id}`)
      .map((mutation) => mutation.id);
    if (staleMutationIds.length > 0) {
      engine.dropPendingMutations(staleMutationIds);
    }

    void persistMutation({
      id: newMutationId(),
      entity: "next_idea",
      operation: "purge",
      baseVersion: idea.version,
      data: { id: idea.id }
    });
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
    engine.markFullBootstrapPending();
    const session = await getSession();
    const local = await loadLocalSnapshot();
    engine.hydratePending(local.pendingMutations);
    const payload = {
      projects: local.projects,
      tasks: local.tasks,
      tags: local.tags,
      taskTags: local.taskTags,
      nextProjects: local.nextProjects,
      nextIdeas: local.nextIdeas,
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
    tags: state.tags.filter((tag) => !tag.deleted_at),
    taskTags: state.taskTags,
    nextProjects,
    nextIdeas,
    filters: state.filters,
    onFiltersChange: (filters) => dispatch({ type: "setFilters", payload: filters }),
    onCreateTask: createTask,
    onUpdateTask: updateTask,
    onArchiveTask: archiveTask,
    onDeleteTask: deleteTask,
    onAddTag: addTag,
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
    return <LoginPage onLogin={handleLogin} />;
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
