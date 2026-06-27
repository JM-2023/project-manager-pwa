import { Plus } from "lucide-react";
import { ProgressSummary } from "../components/ProgressSummary";
import { TaskTable } from "../components/TaskTable";
import { formatShortDate, todayDate, toDateInput } from "../lib/dates";
import { importancePriority, isProjectCacheTask, summarizeProgress } from "../lib/progress";
import type { Task } from "../lib/types";
import type { TaskPageProps } from "./pageProps";

function taskRecordDate(task: Task): string {
  return toDateInput(task.start_date);
}

export function TodayPage(props: TaskPageProps) {
  const { projects, tasks, onCreateTask, onUpdateTask, onArchiveTask, onDeleteTask } = props;
  const today = todayDate();
  const datedTasks = tasks.filter((task) => {
    if (task.deleted_at || task.archived || task.status === "cancelled") return false;
    if (isProjectCacheTask(task)) return false;
    return Boolean(taskRecordDate(task));
  });
  const todayTasks = datedTasks.filter((task) => taskRecordDate(task) === today);
  const latestDate = datedTasks.map(taskRecordDate).sort().at(-1) ?? today;
  const displayDate = todayTasks.length > 0 ? today : latestDate;
  const displayTasks = datedTasks.filter((task) => taskRecordDate(task) === displayDate);
  const summary = summarizeProgress(displayTasks);
  const dateLabel = displayDate === today ? formatShortDate(today) : `Latest ${formatShortDate(displayDate)}`;

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
          {dateLabel} · {displayTasks.length} tasks · 加权推进 {summary.weightedPercent}%
        </p>
      </header>
      <ProgressSummary label="Daily Summary" summary={summary} />
      <button type="button" className="add-row-button" onClick={addTask}>
        <Plus size={18} aria-hidden="true" />
        <span>Add task</span>
      </button>
      {displayTasks.length > 0 ? (
        <TaskTable tasks={displayTasks} projects={projects} showDate={false} onUpdate={onUpdateTask} onArchive={onArchiveTask} onDelete={onDeleteTask} />
      ) : (
        <p className="empty-state">No tasks for {formatShortDate(today)} yet — tap “Add task” to start.</p>
      )}
    </main>
  );
}
