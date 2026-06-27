import { TaskTable } from "../components/TaskTable";
import { getTaskImportance, getTaskProgress, isProjectCacheTask, worklogBlocker, worklogOutput } from "../lib/progress";
import type { TaskPageProps } from "./pageProps";

export function SearchPage(props: TaskPageProps) {
  const { projects, tasks, filters, onFiltersChange, onCreateTask, onUpdateTask, onDeleteTask } = props;
  const projectMap = new Map(projects.map((project) => [project.id, project.name]));
  const query = filters.search.trim().toLowerCase();

  const filtered = tasks.filter((task) => {
    if (task.deleted_at || task.archived) return false;
    if (isProjectCacheTask(task)) return false;
    if (query) {
      const haystack = [task.title, worklogOutput(task), worklogBlocker(task), task.next_action, task.notes, projectMap.get(task.project_id ?? "")]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    if (filters.projectId && task.project_id !== filters.projectId) return false;
    if (filters.status && String(getTaskProgress(task)) !== filters.status) return false;
    if (filters.priority && String(getTaskImportance(task)) !== filters.priority) return false;
    return true;
  });

  return (
    <main className="page-content">
      <header className="page-header">
        <h1>Search</h1>
        <p>{filtered.length} matching tasks</p>
      </header>
      <section className="search-filters">
        <input value={filters.search} onChange={(event) => onFiltersChange({ search: event.target.value })} placeholder="Search projects, tasks, output, blockers" aria-label="Search tasks" />
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
            <option value="">Any progress</option>
            {[0, 25, 50, 75, 100].map((progress) => (
              <option key={progress} value={progress}>
                {progress}%
              </option>
            ))}
          </select>
          <select value={filters.priority} onChange={(event) => onFiltersChange({ priority: event.target.value })} aria-label="Filter priority">
            <option value="">Any importance</option>
            {[1, 2, 3, 4].map((importance) => (
              <option key={importance} value={importance}>
                {importance}
              </option>
            ))}
          </select>
        </div>
      </section>
      <TaskTable tasks={filtered} projects={projects} onCreate={onCreateTask} onUpdate={onUpdateTask} onDelete={onDeleteTask} />
    </main>
  );
}
