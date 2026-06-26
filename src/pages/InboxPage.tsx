import { TaskCard } from "../components/TaskCard";
import { TaskComposer } from "../components/TaskComposer";
import type { TaskPageProps } from "./pageProps";

export function InboxPage(props: TaskPageProps) {
  const { projects, tasks, tags, taskTags, onCreateTask, onUpdateTask, onArchiveTask, onDeleteTask, onAddTag } = props;
  const projectMap = new Map(projects.map((project) => [project.id, project.name]));
  const inboxTasks = tasks.filter((task) => !task.deleted_at && task.archived === 0 && (task.status === "inbox" || task.status === "todo"));

  return (
    <main className="page-content">
      <header className="page-header">
        <h1>Inbox</h1>
        <p>{inboxTasks.length} open tasks</p>
      </header>
      <TaskComposer projects={projects} defaultStatus="inbox" onCreate={onCreateTask} />
      <section className="task-list">
        {inboxTasks.map((task) => (
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
        {inboxTasks.length === 0 ? <p className="empty-state">Inbox is clear.</p> : null}
      </section>
    </main>
  );
}
