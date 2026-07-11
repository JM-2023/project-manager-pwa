import { TaskTable } from "../components/TaskTable";
import { useMemo } from "react";
import { useI18n } from "../lib/i18n";
import { getTaskImportance, getTaskProgress, isProjectCacheTask, worklogBlocker, worklogOutput } from "../lib/progress";
import { NO_PROJECT_FILTER, matchesProjectFilter } from "../state/appStore";
import type { TaskPageProps } from "./pageProps";

export function SearchPage(props: TaskPageProps) {
  const { m } = useI18n();
  const { projects, tasks, nextProjects, nextIdeas, filters, onFiltersChange, onCreateTask, onUpdateTask, onDeleteTask } = props;
  const projectMap = useMemo(() => new Map(projects.map((project) => [project.id, project.name])), [projects]);
  const nextProjectMap = useMemo(() => new Map(nextProjects.map((project) => [project.id, project.name])), [nextProjects]);
  const query = filters.search.trim().toLowerCase();
  const queryActive = Boolean(query);
  const statusFilterActive = Boolean(filters.status);
  const priorityFilterActive = Boolean(filters.priority);

  const searchableTasks = useMemo(
    () =>
      tasks.map((task) => ({
        task,
        hidden: Boolean(task.deleted_at || task.archived || isProjectCacheTask(task) || !task.title.trim()),
        progress: statusFilterActive ? String(getTaskProgress(task)) : "",
        importance: priorityFilterActive ? String(getTaskImportance(task)) : "",
        haystack: queryActive
          ? [task.title, worklogOutput(task), worklogBlocker(task), task.next_action, task.notes, projectMap.get(task.project_id ?? "")]
              .join(" ")
              .toLowerCase()
          : ""
      })),
    [priorityFilterActive, projectMap, queryActive, statusFilterActive, tasks]
  );
  const searchableNextIdeas = useMemo(
    () =>
      nextIdeas.map((idea) => ({
        idea,
        haystack: queryActive
          ? [idea.title, idea.note, nextProjectMap.get(idea.next_project_id ?? "")].join(" ").toLowerCase()
          : ""
      })),
    [nextIdeas, nextProjectMap, queryActive]
  );

  const filtered = useMemo(
    () =>
      searchableTasks
        .filter(({ task, hidden, progress, importance, haystack }) => {
          if (hidden || (query && !haystack.includes(query))) return false;
          if (!matchesProjectFilter(filters.projectId, task.project_id)) return false;
          if (filters.status && progress !== filters.status) return false;
          if (filters.priority && importance !== filters.priority) return false;
          return true;
        })
        .map(({ task }) => task),
    [filters.priority, filters.projectId, filters.status, query, searchableTasks]
  );
  const filteredNextIdeas = useMemo(
    () =>
      searchableNextIdeas
        .filter(({ idea, haystack }) => !idea.deleted_at && (!query || haystack.includes(query)))
        .map(({ idea }) => idea),
    [query, searchableNextIdeas]
  );

  return (
    <main className="page-content">
      <header className="page-header">
        <h1>{m.search.title}</h1>
        <p>{m.search.subtitle(filtered.length, filteredNextIdeas.length)}</p>
      </header>
      <section className="search-filters">
        <input value={filters.search} onChange={(event) => onFiltersChange({ search: event.target.value })} placeholder={m.search.placeholder} aria-label={m.search.searchAria} />
        <div className="filter-grid">
          <select value={filters.projectId} onChange={(event) => onFiltersChange({ projectId: event.target.value })} aria-label={m.search.filterProject}>
            <option value="">{m.common.allProjects}</option>
            <option value={NO_PROJECT_FILTER}>{m.common.noProject}</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <select value={filters.status} onChange={(event) => onFiltersChange({ status: event.target.value })} aria-label={m.search.filterStatus}>
            <option value="">{m.search.anyProgress}</option>
            {[0, 25, 50, 75, 100].map((progress) => (
              <option key={progress} value={progress}>
                {progress}%
              </option>
            ))}
          </select>
          <select value={filters.priority} onChange={(event) => onFiltersChange({ priority: event.target.value })} aria-label={m.search.filterPriority}>
            <option value="">{m.search.anyImportance}</option>
            {[1, 2, 3, 4].map((importance) => (
              <option key={importance} value={importance}>
                {importance}
              </option>
            ))}
          </select>
        </div>
      </section>
      <TaskTable tasks={filtered} projects={projects} onCreate={onCreateTask} onUpdate={onUpdateTask} onDelete={onDeleteTask} />
      <section className="search-next-results" aria-label={m.search.nextResultsAria}>
        <h2>{m.search.nextIdeas}</h2>
        {filteredNextIdeas.length > 0 ? (
          <div className="cache-items">
            {filteredNextIdeas.map((idea) => (
              <article key={idea.id} className="cache-item search-next-item">
                <span>{nextProjectMap.get(idea.next_project_id) ?? m.search.nextFallback}</span>
                <strong>{idea.title || m.search.untitledIdea}</strong>
              </article>
            ))}
          </div>
        ) : (
          <p className="empty-state">{m.search.noNextMatch}</p>
        )}
      </section>
    </main>
  );
}
