import { ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useState } from "react";
import { ProgressSummary } from "../components/ProgressSummary";
import { TaskTable } from "../components/TaskTable";
import { addDays, formatShortDate, todayDate, toDateInput } from "../lib/dates";
import { importancePriority, isProjectCacheTask, summarizeProgress } from "../lib/progress";
import type { Task } from "../lib/types";
import type { TaskPageProps } from "./pageProps";

function taskRecordDate(task: Task): string {
  return toDateInput(task.start_date);
}

export function TodayPage(props: TaskPageProps) {
  const { projects, tasks, onCreateTask, onUpdateTask, onDeleteTask } = props;
  const today = todayDate();
  const [viewDate, setViewDate] = useState(today);
  const datedTasks = tasks.filter((task) => {
    if (task.deleted_at || task.archived || task.status === "cancelled") return false;
    if (isProjectCacheTask(task)) return false;
    return Boolean(taskRecordDate(task));
  });
  const displayTasks = datedTasks.filter((task) => taskRecordDate(task) === viewDate);
  const summary = summarizeProgress(displayTasks);

  function addTask() {
    onCreateTask({
      title: "",
      project_id: null,
      status: "todo",
      priority: importancePriority(2),
      start_date: viewDate,
      next_action: null,
      extra_json: JSON.stringify({ importance: 2, progress_percent: 0 })
    });
  }

  return (
    <main className="page-content">
      <header className="page-header today-page-header">
        <div className="today-date-switcher">
          <button type="button" className="icon-button date-nav-button" onClick={() => setViewDate((date) => addDays(date, -1))} aria-label="Previous day">
            <ChevronLeft size={18} aria-hidden="true" />
          </button>
          <div>
            <h1>Today</h1>
            <span>{formatShortDate(viewDate)}</span>
          </div>
          <button type="button" className="icon-button date-nav-button" onClick={() => setViewDate((date) => addDays(date, 1))} aria-label="Next day">
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        </div>
        <p>
          {displayTasks.length} tasks · 加权推进 {summary.weightedPercent}%
        </p>
      </header>
      <ProgressSummary label="Daily Summary" summary={summary} />
      <button type="button" className="add-row-button" onClick={addTask}>
        <Plus size={18} aria-hidden="true" />
        <span>Add task</span>
      </button>
      {displayTasks.length > 0 ? (
        <TaskTable tasks={displayTasks} projects={projects} showDate={false} onCreate={onCreateTask} onUpdate={onUpdateTask} onDelete={onDeleteTask} />
      ) : (
        <p className="empty-state">No tasks for {formatShortDate(viewDate)} yet. Tap “Add task” to start.</p>
      )}
    </main>
  );
}
