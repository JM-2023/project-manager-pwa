import { TaskCard } from "../components/TaskCard";
import { isDueTodayOrEarlier, todayDate } from "../lib/dates";
import { TASK_PRIORITIES, TASK_STATUSES } from "../lib/types";
import type { TaskPageProps } from "./pageProps";

export function SearchPage(props: TaskPageProps) {
  const { projects, tasks, tags, taskTags, filters, onFiltersChange, onUpdateTask, onArchiveTask, onDeleteTask, onAddTag } = props;
  const projectMap = new Map(projects.map((project) => [project.id, project.name]));
  const tagTaskIds = new Set(taskTags.filter((link) => link.tag_id === filters.tagId && !link.deleted_at).map((link) => link.task_id));
  const query = filters.search.trim().toLowerCase();

  const filtered = tasks.filter((task) => {
    if (task.deleted_at || task.archived) return false;
    if (query) {
      const haystack = [task.title, task.next_action, task.notes, projectMap.get(task.project_id ?? "")].join(" ").toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (filters.projectId && task.project_id !== filters.projectId) return false;
    if (filters.status && task.status !== filters.status) return false;
    if (filters.priority && task.priority !== filters.priority) return false;
    if (filters.tagId && !tagTaskIds.has(task.id)) return false;
    if (filters.due === "today" && !isDueTodayOrEarlier(task.due_date)) return false;
    if (filters.due === "overdue" && !(task.due_date && task.due_date < todayDate())) return false;
    if (filters.due === "none" && task.due_date) return false;
    return true;
  });

  return (
    <main className="page-content">
      <header className="page-header">
        <h1>Search</h1>
        <p>{filtered.length} matching tasks</p>
      </header>
      <section className="search-filters">
        <input value={filters.search} onChange={(event) => onFiltersChange({ search: event.target.value })} placeholder="Search tasks" aria-label="Search tasks" />
        <div className="filter-grid">
          <select value={filters.projectId} onChange={(event) => onFiltersChange({ projectId: event.target.value })} aria-label="Filter project">
            <option value="">All projects</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          <select value={filters.status} onChange={(event) => onFiltersChange({ status: event.target.value })} aria-label="Filter status">
            <option value="">Any status</option>
            {TASK_STATUSES.map((status) => (
              <option key={status} value={status}>
                {status}
              </option>
            ))}
          </select>
          <select value={filters.priority} onChange={(event) => onFiltersChange({ priority: event.target.value })} aria-label="Filter priority">
            <option value="">Any priority</option>
            {TASK_PRIORITIES.map((priority) => (
              <option key={priority} value={priority}>
                {priority}
              </option>
            ))}
          </select>
          <select value={filters.tagId} onChange={(event) => onFiltersChange({ tagId: event.target.value })} aria-label="Filter tag">
            <option value="">Any tag</option>
            {tags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </select>
          <select value={filters.due} onChange={(event) => onFiltersChange({ due: event.target.value as typeof filters.due })} aria-label="Filter due date">
            <option value="all">Any due date</option>
            <option value="today">Due today</option>
            <option value="overdue">Overdue</option>
            <option value="none">No due date</option>
          </select>
        </div>
      </section>
      <section className="task-list">
        {filtered.map((task) => (
          <TaskCard
            key={task.id}
            task={task}
            projectName={projectMap.get(task.project_id ?? "")}
            tags={tags}
            taskTags={taskTags}
            onUpdate={onUpdateTask}
            onArchive={onArchiveTask}
            onDelete={onDeleteTask}
            onAddTag={onAddTag}
          />
        ))}
      </section>
    </main>
  );
}
