import type { BootstrapResponse, NextIdea, NextProject, Project, SessionResponse, Task } from "../lib/types";
import { visibleProjects, visibleTasks } from "../lib/sync";
import { priorityScore } from "../lib/validation";

export type TabId = "today" | "calendar" | "projects" | "next" | "search" | "settings";
export type SyncStatus = "idle" | "loading" | "queued" | "syncing" | "offline" | "error";

export interface Filters {
  search: string;
  projectId: string;
  status: string;
  priority: string;
  due: "all" | "today" | "overdue" | "none";
}

// Sentinel for Filters.projectId meaning "tasks without a project". Lives only
// in filter state — never written to a task's project_id.
export const NO_PROJECT_FILTER = "__no_project__";

export function matchesProjectFilter(filterProjectId: string, taskProjectId: string | null | undefined): boolean {
  if (!filterProjectId) return true;
  if (filterProjectId === NO_PROJECT_FILTER) return !taskProjectId;
  return taskProjectId === filterProjectId;
}

export interface AppState {
  projects: Project[];
  tasks: Task[];
  nextProjects: NextProject[];
  nextIdeas: NextIdea[];
  settings: Record<string, unknown>;
  session: SessionResponse | null;
  authRequired: boolean;
  currentTab: TabId;
  selectedDate: string | null;
  filters: Filters;
  pendingCount: number;
  lastSync: string | null;
  lastExport: string | null;
  online: boolean;
  syncStatus: SyncStatus;
  error: string | null;
  conflicts: number;
}

export type AppAction =
  | {
      type: "hydrateLocal";
      payload: Pick<AppState, "projects" | "tasks" | "nextProjects" | "nextIdeas" | "settings" | "pendingCount" | "lastSync">;
    }
  | { type: "replaceBootstrap"; payload: BootstrapResponse }
  | { type: "setSession"; payload: SessionResponse | null }
  | { type: "setAuthRequired"; payload: boolean }
  | { type: "setTab"; payload: TabId }
  | { type: "setSelectedDate"; payload: string | null }
  | { type: "setFilters"; payload: Partial<Filters> }
  | { type: "upsertProject"; payload: Project }
  | { type: "purgeProject"; payload: string }
  | { type: "upsertTask"; payload: Task }
  | { type: "purgeTask"; payload: string }
  | { type: "upsertNextProject"; payload: NextProject }
  | { type: "purgeNextProject"; payload: string }
  | { type: "upsertNextIdea"; payload: NextIdea }
  | { type: "purgeNextIdea"; payload: string }
  | { type: "setPendingCount"; payload: number }
  | { type: "setLastSync"; payload: string | null }
  | { type: "setLastExport"; payload: string | null }
  | { type: "setOnline"; payload: boolean }
  | { type: "setSyncStatus"; payload: SyncStatus }
  | { type: "setError"; payload: string | null }
  | { type: "setConflicts"; payload: number };

export const initialState: AppState = {
  projects: [],
  tasks: [],
  nextProjects: [],
  nextIdeas: [],
  settings: {},
  session: null,
  authRequired: true,
  currentTab: "today",
  selectedDate: null,
  filters: {
    search: "",
    projectId: "",
    status: "",
    priority: "",
    due: "all"
  },
  pendingCount: 0,
  lastSync: null,
  lastExport: localStorage.getItem("project-manager-last-export"),
  online: navigator.onLine,
  syncStatus: "idle",
  error: null,
  conflicts: 0
};

function byId<T extends { id: string }>(records: T[], record: T): T[] {
  const index = records.findIndex((item) => item.id === record.id);
  if (index === -1) {
    return [record, ...records];
  }
  const next = records.slice();
  next[index] = record;
  return next;
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "hydrateLocal":
      return { ...state, ...action.payload };
    case "replaceBootstrap":
      return {
        ...state,
        projects: action.payload.projects,
        tasks: action.payload.tasks,
        nextProjects: action.payload.nextProjects,
        nextIdeas: action.payload.nextIdeas,
        settings: action.payload.settings,
        lastSync: action.payload.serverTime,
        syncStatus: "idle"
      };
    case "setSession":
      return { ...state, session: action.payload, authRequired: !action.payload };
    case "setAuthRequired":
      return { ...state, authRequired: action.payload };
    case "setTab":
      return { ...state, currentTab: action.payload };
    case "setSelectedDate":
      return { ...state, selectedDate: action.payload };
    case "setFilters":
      return { ...state, filters: { ...state.filters, ...action.payload } };
    case "upsertProject":
      return { ...state, projects: byId(state.projects, action.payload) };
    case "purgeProject": {
      // Hard delete a project and its tasks. Nothing is left behind as a tombstone.
      const projectId = action.payload;
      return {
        ...state,
        projects: state.projects.filter((project) => project.id !== projectId),
        tasks: state.tasks.filter((task) => task.project_id !== projectId)
      };
    }
    case "upsertTask":
      return { ...state, tasks: byId(state.tasks, action.payload) };
    case "purgeTask":
      // Hard delete a task — no tombstone left behind.
      return { ...state, tasks: state.tasks.filter((task) => task.id !== action.payload) };
    case "upsertNextProject":
      return { ...state, nextProjects: byId(state.nextProjects, action.payload) };
    case "purgeNextProject": {
      const projectId = action.payload;
      return {
        ...state,
        nextProjects: state.nextProjects.filter((project) => project.id !== projectId),
        nextIdeas: state.nextIdeas.filter((idea) => idea.next_project_id !== projectId)
      };
    }
    case "upsertNextIdea":
      return { ...state, nextIdeas: byId(state.nextIdeas, action.payload) };
    case "purgeNextIdea":
      return { ...state, nextIdeas: state.nextIdeas.filter((idea) => idea.id !== action.payload) };
    case "setPendingCount":
      return { ...state, pendingCount: action.payload };
    case "setLastSync":
      return { ...state, lastSync: action.payload };
    case "setLastExport":
      if (action.payload) {
        localStorage.setItem("project-manager-last-export", action.payload);
      } else {
        localStorage.removeItem("project-manager-last-export");
      }
      return { ...state, lastExport: action.payload };
    case "setOnline":
      return { ...state, online: action.payload, syncStatus: action.payload ? state.syncStatus : "offline" };
    case "setSyncStatus":
      return { ...state, syncStatus: action.payload };
    case "setError":
      return { ...state, error: action.payload };
    case "setConflicts":
      return { ...state, conflicts: action.payload };
    default:
      return state;
  }
}

export function sortedProjects(projects: Project[]): Project[] {
  return visibleProjects(projects).sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name));
}

export function sortedTasks(tasks: Task[]): Task[] {
  return visibleTasks(tasks).sort((a, b) => {
    const dueA = a.due_date ?? "9999-12-31";
    const dueB = b.due_date ?? "9999-12-31";
    return dueA.localeCompare(dueB) || priorityScore(a.priority) - priorityScore(b.priority) || a.sort_order - b.sort_order;
  });
}
