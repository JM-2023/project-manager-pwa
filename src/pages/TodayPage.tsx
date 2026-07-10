import { ChevronsRight, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import { DateNav, RollText, type NavDirection } from "../components/DateNav";
import { ProgressSummary } from "../components/ProgressSummary";
import { TaskTable } from "../components/TaskTable";
import { addDays, formatShortDate, toDateInput, weekdayLong } from "../lib/dates";
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
  const [navDir, setNavDir] = useState<NavDirection>(1);
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

  function goTo(date: string, dir: NavDirection) {
    setNavDir(dir);
    setViewDate(date);
  }

  // The page title names the day being viewed instead of always claiming
  // "Today": today / yesterday / tomorrow by name, anything further by weekday.
  const dayTitle =
    viewDate === today
      ? m.today.title
      : viewDate === addDays(today, -1)
        ? m.today.yesterday
        : viewDate === addDays(today, 1)
          ? m.today.tomorrow
          : weekdayLong(viewDate, lang);

  return (
    <main className="page-content">
      <header className="page-header today-page-header">
        <div className="page-head-nav">
          <h1>
            <RollText text={dayTitle} dir={navDir} />
          </h1>
          <DateNav
            label={formatShortDate(viewDate, lang)}
            dir={navDir}
            onPrev={() => goTo(addDays(viewDate, -1), -1)}
            onNext={() => goTo(addDays(viewDate, 1), 1)}
            onHome={() => goTo(today, viewDate > today ? -1 : 1)}
            isHome={viewDate === today}
            homeLabel={m.today.todayChip}
            prevAria={m.today.prevDay}
            nextAria={m.today.nextDay}
            homeAria={m.today.backToToday}
          />
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
