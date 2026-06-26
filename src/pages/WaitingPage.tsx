import { TaskCard } from "../components/TaskCard";
import { TaskComposer } from "../components/TaskComposer";
import type { TaskPageProps } from "./pageProps";

export function WaitingPage(props: TaskPageProps) {
  const { projects, tasks, tags, taskTags, onCreateTask, onUpdateTask, onArchiveTask, onDeleteTask, onAddTag } = props;
  const projectMap = new Map(projects.map((project) => [project.id, project.name]));
  const waitingTasks = tasks.filter((task) => !task.deleted_at && task.archived === 0 && task.status === "waiting");

  return (
    <main className="page-content">
      <header className="page-header">
        <h1>Waiting</h1>
        <p>{waitingTasks.length} delegated or paused tasks</p>
      </header>
      <TaskComposer projects={projects} defaultStatus="waiting" onCreate={onCreateTask} />
      <section className="task-list">
        {waitingTasks.map((task) => (
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
        {waitingTasks.length === 0 ? <p className="empty-state">Nothing waiting.</p> : null}
      </section>
    </main>
  );
}
