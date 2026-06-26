import { ProgressSummary } from "../components/ProgressSummary";
import { TaskTable } from "../components/TaskTable";
import { TaskComposer } from "../components/TaskComposer";
import { formatShortDate, todayDate } from "../lib/dates";
import { summarizeProgress } from "../lib/progress";
import type { TaskPageProps } from "./pageProps";

export function TodayPage(props: TaskPageProps) {
  const { projects, tasks, onCreateTask, onUpdateTask, onArchiveTask, onDeleteTask, onCreateProject } = props;
  const today = todayDate();
  const todayTasks = tasks.filter((task) => {
    if (task.deleted_at || task.archived || task.status === "cancelled") return false;
    return task.start_date === today;
  });
  const summary = summarizeProgress(todayTasks);

  return (
    <main className="page-content">
      <header className="page-header">
        <h1>Today</h1>
        <p>
          {formatShortDate(today)} · {todayTasks.length} tasks · 加权推进 {summary.weightedPercent}%
        </p>
      </header>
      <ProgressSummary label="Daily Summary" summary={summary} />
      <TaskComposer
        projects={projects}
        defaultStatus="todo"
        defaultStartDate={today}
        showDateInput={false}
        onCreateProject={onCreateProject}
        onCreate={onCreateTask}
      />
      {todayTasks.length > 0 ? (
        <TaskTable tasks={todayTasks} projects={projects} showDate={false} onUpdate={onUpdateTask} onArchive={onArchiveTask} onDelete={onDeleteTask} />
      ) : (
        <p className="empty-state">No tasks for {formatShortDate(today)}.</p>
      )}
    </main>
  );
}
