import { TaskTable } from "../components/TaskTable";
import { settleRegion } from "../lib/pageTransition";
import { ArrowUpRight, Search, X } from "lucide-react";
import { FilterChip, type ChipOption } from "../components/FilterChip";
import { Marked } from "../components/Marked";
import { useLayoutEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../lib/i18n";
import { getTaskImportance, getTaskProgress, isProjectCacheTask, worklogBlocker, worklogOutput } from "../lib/progress";
import { NO_PROJECT_FILTER, matchesProjectFilter, newestFirst } from "../state/appStore";
import type { TaskPageProps } from "./pageProps";

type Scope = "tasks" | "ideas";

// A pointer on a desktop: the field can take the focus on arrival without
// raising a keyboard over the results.
function finePointer(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(hover: hover) and (pointer: fine)").matches;
}

export function SearchPage(props: TaskPageProps & { onOpenIdea: (id: string) => void }) {
  const { m } = useI18n();
  const [scope, setScope] = useState<Scope>("tasks");
  const resultsRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const shownScopeRef = useRef(scope);
  // The other scope's results settle in the way a page does on a tab
  // switch. The page's own arrival is the tab switch's, so the first run
  // lands nothing.
  useLayoutEffect(() => {
    if (shownScopeRef.current === scope) return;
    shownScopeRef.current = scope;
    settleRegion(resultsRef.current);
  }, [scope]);
  useLayoutEffect(() => {
    if (finePointer()) inputRef.current?.focus({ preventScroll: true });
  }, []);
  const [groupId, setGroupId] = useState("");
  const { projects, tasks, nextProjects, nextIdeas, filters, onFiltersChange, onCreateTask, onUpdateTask, onDeleteTask, onMoveTasks } = props;
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

  // Results read as the worklog does: by day, the latest first.
  const filtered = useMemo(
    () =>
      newestFirst(
        searchableTasks
          .filter(({ task, hidden, progress, importance, haystack }) => {
            if (hidden || (query && !haystack.includes(query))) return false;
            if (!matchesProjectFilter(filters.projectId, task.project_id)) return false;
            if (filters.status && progress !== filters.status) return false;
            if (filters.priority && importance !== filters.priority) return false;
            return true;
          })
          .map(({ task }) => task)
      ),
    [filters.priority, filters.projectId, filters.status, query, searchableTasks]
  );
  const filteredNextIdeas = useMemo(
    () =>
      searchableNextIdeas
        .filter(({ idea, haystack }) => !idea.deleted_at && nextProjectMap.has(idea.next_project_id) && (!groupId || idea.next_project_id === groupId) && (!query || haystack.includes(query)))
        .map(({ idea }) => idea),
    [groupId, nextProjectMap, query, searchableNextIdeas]
  );

  const scopeOptions: ChipOption[] = [
    { id: "tasks", label: m.search.tasks },
    { id: "ideas", label: m.search.nextIdeas }
  ];
  const projectOptions: ChipOption[] = [
    { id: "", label: m.common.allProjects },
    { id: NO_PROJECT_FILTER, label: m.common.noProject },
    ...projects.map((project) => ({ id: project.id, label: project.name }))
  ];
  const importanceOptions: ChipOption[] = [
    { id: "", label: m.search.anyImportance },
    ...([1, 2, 3, 4] as const).map((importance) => ({ id: String(importance), label: m.composer.importance[importance] }))
  ];
  const progressOptions: ChipOption[] = [
    { id: "", label: m.search.anyProgress },
    ...[0, 25, 50, 75, 100].map((progress) => ({ id: String(progress), label: `${progress}%` }))
  ];
  const groupOptions: ChipOption[] = [
    { id: "", label: m.search.allGroups },
    ...nextProjects.map((project) => ({ id: project.id, label: project.name }))
  ];
  const projectLabel = projectOptions.find((option) => option.id === filters.projectId)?.label;
  const groupLabel = groupOptions.find((option) => option.id === groupId)?.label;
  const filtering = scope === "tasks" ? Boolean(filters.projectId || filters.status || filters.priority) : Boolean(groupId);

  function clearFilters() {
    if (scope === "tasks") onFiltersChange({ projectId: "", status: "", priority: "" });
    else setGroupId("");
  }

  return (
    <main className="page-content">
      <header className="page-header">
        <h1>{m.search.title}</h1>
        <p>{m.search.resultCount(scope === "tasks" ? filtered.length : filteredNextIdeas.length)}</p>
      </header>
      <section className="search-bar">
        <div className="search-field">
          <Search size={18} aria-hidden="true" />
          {/* Return is the keyboard's search key: it closes the keyboard so
              the results it was covering show. */}
          <input
            ref={inputRef}
            type="search"
            enterKeyHint="search"
            autoComplete="off"
            value={filters.search}
            onChange={(event) => onFiltersChange({ search: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                event.currentTarget.blur();
              }
            }}
            placeholder={scope === "tasks" ? m.search.placeholder : m.search.ideasPlaceholder}
            aria-label={scope === "tasks" ? m.search.searchAria : m.search.nextResultsAria}
          />
          {filters.search ? (
            <button
              type="button"
              className="search-field__clear"
              aria-label={m.search.clearQuery}
              // A tap keeps the focus (and the iPhone keyboard) in the field.
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                onFiltersChange({ search: "" });
                inputRef.current?.focus({ preventScroll: true });
              }}
            >
              <X size={16} strokeWidth={2.4} aria-hidden="true" />
            </button>
          ) : null}
        </div>
        {/* One line of chips, scrolling sideways when it runs out of room. A
            chip in use is solid; Clear follows them while any is. */}
        <div className="filter-chips" role="group" aria-label={m.search.filtersAria}>
          <FilterChip
            name={m.search.scope}
            label={scope === "tasks" ? m.search.tasks : m.search.nextIdeas}
            active
            options={scopeOptions}
            value={scope}
            onChange={(id) => setScope(id as Scope)}
          />
          {scope === "tasks" ? (
            <>
              <FilterChip
                name={m.search.filterProject}
                label={filters.projectId ? projectLabel ?? m.common.project : m.common.project}
                active={Boolean(filters.projectId)}
                options={projectOptions}
                value={filters.projectId}
                onChange={(projectId) => onFiltersChange({ projectId })}
              />
              <FilterChip
                name={m.search.filterPriority}
                label={filters.priority ? `P${filters.priority}` : m.search.importance}
                active={priorityFilterActive}
                options={importanceOptions}
                value={filters.priority}
                onChange={(priority) => onFiltersChange({ priority })}
              />
              <FilterChip
                name={m.search.filterStatus}
                label={filters.status ? `${filters.status}%` : m.search.progress}
                active={statusFilterActive}
                options={progressOptions}
                value={filters.status}
                onChange={(status) => onFiltersChange({ status })}
              />
            </>
          ) : (
            <FilterChip
              name={m.search.filterGroup}
              label={groupId ? groupLabel ?? m.search.group : m.search.group}
              active={Boolean(groupId)}
              options={groupOptions}
              value={groupId}
              onChange={setGroupId}
            />
          )}
          {filtering ? (
            <button type="button" className="filter-chip filter-chip--clear" onClick={clearFilters}>
              {m.search.clearFilters}
            </button>
          ) : null}
        </div>
      </section>
      {/* One table for every query: typing filters it in place (lib/listMotion
          at the quick pace), so rows that still match never re-enter. */}
      <div key={scope} ref={resultsRef} className="search-results">
      {scope === "tasks" ? <TaskTable motionPace="quick" dayGroups="count" highlight={query} tasks={filtered} projects={projects} onCreate={onCreateTask} onUpdate={onUpdateTask} onDelete={onDeleteTask} onMove={(task, date) => onMoveTasks([task], date)} /> :
      <section className="search-next-results" aria-label={m.search.nextResultsAria}>
        <h2>{m.search.nextIdeas}</h2>
        {filteredNextIdeas.length > 0 ? (
          <div className="cache-items">
            {filteredNextIdeas.map((idea) => (
              <button type="button" key={idea.id} className="cache-item search-next-item" onClick={() => props.onOpenIdea(idea.id)} aria-label={`${m.search.openIdea}: ${idea.title || m.search.untitledIdea}`}>
                <span>{nextProjectMap.get(idea.next_project_id) ?? m.search.nextFallback}</span>
                <strong>{idea.title ? <Marked text={idea.title} query={query} /> : m.search.untitledIdea}</strong>
                {idea.note ? <span className="search-next-item__note"><Marked text={idea.note} query={query} /></span> : null}
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
