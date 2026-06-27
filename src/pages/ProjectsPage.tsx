import { ProjectList } from "../components/ProjectList";
import { TaskTable } from "../components/TaskTable";
import { isWorklogTask, summarizeWorklogOverview } from "../lib/progress";
import type { TaskPageProps } from "./pageProps";

export function ProjectsPage(props: TaskPageProps) {
  const {
    projects,
    tasks,
    filters,
    onFiltersChange,
    onUpdateTask,
    onArchiveTask,
    onDeleteTask,
    onCreateProject,
    onArchiveProject
  } = props;

  const selectedProjectId = filters.projectId;
  const projectTasks = tasks.filter((task) => {
    if (!isWorklogTask(task)) return false;
    return selectedProjectId ? task.project_id === selectedProjectId : true;
  });
  const summary = summarizeWorklogOverview(projectTasks);

  return (
    <main className="page-content project-page">
      <header className="page-header">
        <h1>Projects</h1>
        <p>
          {summary.taskCount} tasks · average {summary.averageProgress}%
        </p>
      </header>
      <ProjectList
        projects={projects}
        tasks={tasks}
        selectedProjectId={selectedProjectId}
        onSelect={(projectId) => onFiltersChange({ projectId })}
        onCreate={onCreateProject}
        onArchive={onArchiveProject}
      />
      <TaskTable tasks={projectTasks} projects={projects} onUpdate={onUpdateTask} onArchive={onArchiveTask} onDelete={onDeleteTask} />
    </main>
  );
}
