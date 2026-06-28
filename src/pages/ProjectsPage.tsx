import { ProjectList } from "../components/ProjectList";
import { TaskTable } from "../components/TaskTable";
import { isWorklogTask, summarizeWorklogOverview } from "../lib/progress";
import type { TaskPageProps } from "./pageProps";

export function ProjectsPage(props: TaskPageProps) {
  const {
    projects,
    archivedProjects,
    tasks,
    filters,
    onFiltersChange,
    onCreateTask,
    onUpdateTask,
    onDeleteTask,
    onCreateProject,
    onArchiveProject,
    onUnarchiveProject,
    onDeleteProject,
    onRenameProject
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
        archivedProjects={archivedProjects}
        tasks={tasks}
        selectedProjectId={selectedProjectId}
        onSelect={(projectId) => onFiltersChange({ projectId })}
        onCreate={onCreateProject}
        onArchive={onArchiveProject}
        onUnarchive={onUnarchiveProject}
        onDelete={onDeleteProject}
        onRename={onRenameProject}
      />
      <TaskTable tasks={projectTasks} projects={projects} onCreate={onCreateTask} onUpdate={onUpdateTask} onDelete={onDeleteTask} />
    </main>
  );
}
