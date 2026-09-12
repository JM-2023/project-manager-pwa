import { TaskTable } from "../components/TaskTable";
import { ArrowUpRight } from "lucide-react";
import { SegControl } from "../components/SegControl";
import { useMemo, useState } from "react";
import { useI18n } from "../lib/i18n";
import { getTaskImportance, getTaskProgress, isProjectCacheTask, worklogBlocker, worklogOutput } from "../lib/progress";
import { NO_PROJECT_FILTER, matchesProjectFilter } from "../state/appStore";
import type { TaskPageProps } from "./pageProps";

export function SearchPage(props: TaskPageProps & { onOpenIdea: (id: string) => void }) {
  const { m } = useI18n();
  const [scope, setScope] = useState<"tasks" | "ideas">("tasks");
  const [groupId, setGroupId] = useState("");
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
        .filter(({ idea, haystack }) => !idea.deleted_at && nextProjectMap.has(idea.next_project_id) && (!groupId || idea.next_project_id === groupId) && (!query || haystack.includes(query)))
        .map(({ idea }) => idea),
    [groupId, nextProjectMap, query, searchableNextIdeas]
  );

  return (
    <main className="page-content">
      <header className="page-header">
        <h1>{m.search.title}</h1>
        <p>{m.search.resultCount(scope === "tasks" ? filtered.length : filteredNextIdeas.length)}</p>
      </header>
      <section className="search-filters">
        <SegControl options={[{ id: "tasks", label: m.search.tasks }, { id: "ideas", label: m.search.nextIdeas }]} value={scope} onChange={setScope} ariaLabel={m.search.scope} />
        <input value={filters.search} onChange={(event) => onFiltersChange({ search: event.target.value })} placeholder={scope === "tasks" ? m.search.placeholder : m.search.ideasPlaceholder} aria-label={scope === "tasks" ? m.search.searchAria : m.search.nextResultsAria} />
        {scope === "tasks" ? <div className="filter-grid">
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
        </div> : <select value={groupId} onChange={(event) => setGroupId(event.target.value)} aria-label={m.search.filterGroup}>
          <option value="">{m.search.allGroups}</option>
          {nextProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
        </select>}
      </section>
      <div key={scope} className="search-results">
      {scope === "tasks" ? <TaskTable tasks={filtered} projects={projects} onCreate={onCreateTask} onUpdate={onUpdateTask} onDelete={onDeleteTask} /> :
      <section className="search-next-results" aria-label={m.search.nextResultsAria}>
        <h2>{m.search.nextIdeas}</h2>
        {filteredNextIdeas.length > 0 ? (
          <div className="cache-items">
            {filteredNextIdeas.map((idea) => (
              <button type="button" key={idea.id} className="cache-item search-next-item" onClick={() => props.onOpenIdea(idea.id)} aria-label={`${m.search.openIdea}: ${idea.title || m.search.untitledIdea}`}>
                <span>{nextProjectMap.get(idea.next_project_id) ?? m.search.nextFallback}</span>
                <strong>{idea.title || m.search.untitledIdea}</strong>
                {idea.note ? <span className="search-next-item__note">{idea.note}</span> : null}
                <ArrowUpRight size={16} aria-hidden="true" />
              </button>
            ))}
          </div>
        ) : (
          <p className="empty-state">{m.search.noNextMatch}</p>
        )}
      </section>}
      </div>
    </main>
  );
}
