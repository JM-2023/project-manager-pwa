import { Plus } from "lucide-react";
import { ProgressSummary } from "../components/ProgressSummary";
import { TaskTable } from "../components/TaskTable";
import { formatShortDate, todayDate } from "../lib/dates";
import { importancePriority, summarizeProgress } from "../lib/progress";
import type { TaskPageProps } from "./pageProps";

export function TodayPage(props: TaskPageProps) {
  const { projects, tasks, onCreateTask, onUpdateTask, onArchiveTask, onDeleteTask } = props;
  const today = todayDate();
  const todayTasks = tasks.filter((task) => {
    if (task.deleted_at || task.archived || task.status === "cancelled") return false;
    return task.start_date === today;
  });
  const summary = summarizeProgress(todayTasks);

  function addTask() {
    onCreateTask({
      title: "",
      project_id: null,
      status: "todo",
      priority: importancePriority(2),
      start_date: today,
      next_action: null,
      extra_json: JSON.stringify({ importance: 2, progress_percent: 0 })
    });
  }

  return (
    <main className="page-content">
      <header className="page-header">
        <h1>Today</h1>
        <p>
          {formatShortDate(today)} · {todayTasks.length} tasks · 加权推进 {summary.weightedPercent}%
        </p>
      </header>
      <ProgressSummary label="Daily Summary" summary={summary} />
      <button type="button" className="add-row-button" onClick={addTask}>
        <Plus size={18} aria-hidden="true" />
        <span>Add task</span>
      </button>
      {todayTasks.length > 0 ? (
        <TaskTable tasks={todayTasks} projects={projects} showDate={false} onUpdate={onUpdateTask} onArchive={onArchiveTask} onDelete={onDeleteTask} />
      ) : (
        <p className="empty-state">No tasks for {formatShortDate(today)} yet — tap “Add task” to start.</p>
      )}
    </main>
  );
}
