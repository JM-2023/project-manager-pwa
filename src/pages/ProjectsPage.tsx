import { ProjectList } from "../components/ProjectList";
import { TaskTable } from "../components/TaskTable";
import { useLayoutEffect, useMemo, useRef } from "react";
import { useI18n } from "../lib/i18n";
import { isWorklogTask, summarizeWorklogOverview } from "../lib/progress";
import { settleRegion } from "../lib/pageTransition";
import { matchesProjectFilter } from "../state/appStore";
import type { TaskPageProps } from "./pageProps";

export function ProjectsPage(props: TaskPageProps & { projectTaskCounts: ReadonlyMap<string, number> }) {
  const { m } = useI18n();
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
    onRenameProject,
    projectTaskCounts
  } = props;

  const selectedProjectId = filters.projectId;
  const pageRef = useRef<HTMLElement | null>(null);
  const shownProjectRef = useRef(selectedProjectId);
  useLayoutEffect(() => {
    window.scrollTo({ top: 0, behavior: "instant" });
    // Another project's tasks settle in the way a page does on a tab
    // switch (lib/pageTransition), measured after the scroll reset. The
    // page's own arrival is the tab switch's, so the first run lands nothing.
    if (shownProjectRef.current === selectedProjectId) return;
    shownProjectRef.current = selectedProjectId;
    settleRegion(pageRef.current?.querySelector(".task-table-wrap") ?? null);
  }, [selectedProjectId]);
  const projectTasks = useMemo(
    () => tasks.filter((task) => isWorklogTask(task) && matchesProjectFilter(selectedProjectId, task.project_id)),
    [selectedProjectId, tasks]
  );
  const summary = useMemo(() => summarizeWorklogOverview(projectTasks), [projectTasks]);

  return (
    <main ref={pageRef} className="page-content project-page">
      <header className="page-header">
        <h1>{m.projectsPage.title}</h1>
        <p>{m.projectsPage.subtitle(summary.taskCount, summary.averageProgress)}</p>
      </header>
      <ProjectList
        projects={projects}
        archivedProjects={archivedProjects}
        tasks={tasks}
        taskCounts={projectTaskCounts}
        selectedProjectId={selectedProjectId}
        onSelect={(projectId) => onFiltersChange({ projectId })}
        onCreate={onCreateProject}
        onArchive={onArchiveProject}
        onUnarchive={onUnarchiveProject}
        onDelete={onDeleteProject}
        onRename={onRenameProject}
      />
      <TaskTable key={selectedProjectId} tasks={projectTasks} projects={projects} onCreate={onCreateTask} onUpdate={onUpdateTask} onDelete={onDeleteTask} />
    </main>
  );
}
