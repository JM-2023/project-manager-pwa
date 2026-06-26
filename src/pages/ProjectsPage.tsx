import { ProjectList } from "../components/ProjectList";
import { TaskTable } from "../components/TaskTable";
import { TaskComposer } from "../components/TaskComposer";
import { isWorklogTask, summarizeWorklogOverview } from "../lib/progress";
import type { TaskPageProps } from "./pageProps";

export function ProjectsPage(props: TaskPageProps) {
  const {
    projects,
    tasks,
    filters,
    onFiltersChange,
    onCreateTask,
    onUpdateTask,
    onArchiveTask,
    onDeleteTask,
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
        onArchive={onArchiveProject}
      />
      <TaskComposer
        projects={projects}
        defaultProjectId={selectedProjectId}
        defaultStatus="todo"
        onCreate={onCreateTask}
      />
      <TaskTable tasks={projectTasks} projects={projects} onUpdate={onUpdateTask} onArchive={onArchiveTask} onDelete={onDeleteTask} />
    </main>
  );
}
