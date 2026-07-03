import { ChevronLeft, ChevronRight, ChevronsRight, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { ProgressSummary } from "../components/ProgressSummary";
import { TaskTable } from "../components/TaskTable";
import { addDays, formatShortDate, toDateInput } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import { getTaskProgress, importancePriority, isProjectCacheTask, summarizeProgress } from "../lib/progress";
import { useToday } from "../lib/useToday";
import type { Task } from "../lib/types";
import type { TaskPageProps } from "./pageProps";

function taskRecordDate(task: Task): string {
  return toDateInput(task.start_date);
}

export function TodayPage(props: TaskPageProps & { initialDate?: string | null }) {
  const { m, lang } = useI18n();
  const { projects, tasks, onCreateTask, onUpdateTask, onDeleteTask, initialDate } = props;
  const today = useToday();
  const [viewDate, setViewDate] = useState(initialDate || today);
  const [focusTaskId, setFocusTaskId] = useState<string | null>(null);

  // Follow day selections made from the Calendar view.
  useEffect(() => {
    if (initialDate) {
      setViewDate(initialDate);
    }
  }, [initialDate]);

  // A remembered focus target only applies to the day it was created on.
  useEffect(() => {
    setFocusTaskId(null);
  }, [viewDate]);

  const datedTasks = tasks.filter((task) => {
    if (task.deleted_at || task.archived || task.status === "cancelled") return false;
    if (isProjectCacheTask(task)) return false;
    return Boolean(taskRecordDate(task));
  });
  const displayTasks = datedTasks.filter((task) => taskRecordDate(task) === viewDate);
  const summary = summarizeProgress(displayTasks);
  const unfinishedTasks = displayTasks.filter((task) => getTaskProgress(task) < 100);

  function addTask() {
    const id = onCreateTask({
      title: "",
      project_id: null,
      status: "todo",
      priority: importancePriority(2),
      start_date: viewDate,
      next_action: null,
      extra_json: JSON.stringify({ importance: 2, progress_percent: 0 })
    });
    setFocusTaskId(id);
  }

  function rolloverUnfinished() {
    const target = addDays(viewDate, 1);
    for (const task of unfinishedTasks) {
      onUpdateTask(task, { start_date: target });
    }
  }

  return (
    <main className="page-content">
      <header className="page-header today-page-header">
        <div className="today-date-switcher">
          <button type="button" className="icon-button date-nav-button" onClick={() => setViewDate((date) => addDays(date, -1))} aria-label={m.today.prevDay}>
            <ChevronLeft size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`today-title-button${viewDate === today ? " active" : ""}`}
            onClick={() => setViewDate(today)}
            aria-label={m.today.backToToday}
            aria-current={viewDate === today ? "date" : undefined}
          >
            <h1>{m.today.title}</h1>
            <span>{formatShortDate(viewDate, lang)}</span>
          </button>
          <button type="button" className="icon-button date-nav-button" onClick={() => setViewDate((date) => addDays(date, 1))} aria-label={m.today.nextDay}>
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        </div>
        <p>{m.today.subtitle(displayTasks.length, summary.weightedPercent)}</p>
      </header>
      <ProgressSummary label={m.today.dailySummary} summary={summary} />
      <div className="add-row-actions">
        <button type="button" className="add-row-button" onClick={addTask}>
          <Plus size={18} aria-hidden="true" />
          <span>{m.today.addTask}</span>
        </button>
        <button
          type="button"
          className="add-row-button"
          onClick={rolloverUnfinished}
          disabled={unfinishedTasks.length === 0}
          aria-label={m.today.rolloverAria}
          title={m.today.rolloverAria}
        >
          <ChevronsRight size={18} aria-hidden="true" />
          <span>{m.today.rollover}</span>
        </button>
      </div>
      {displayTasks.length > 0 ? (
        <TaskTable
          tasks={displayTasks}
          projects={projects}
          showDate={false}
          focusTaskId={focusTaskId}
          onCreate={onCreateTask}
          onUpdate={onUpdateTask}
          onDelete={onDeleteTask}
        />
      ) : (
        <p className="empty-state">{m.today.empty(formatShortDate(viewDate, lang))}</p>
      )}
    </main>
  );
}
