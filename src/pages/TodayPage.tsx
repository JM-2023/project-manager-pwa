import { ChevronsRight, Plus } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DateSwitcher, type NavDirection } from "../components/DateNav";
import { ProgressSummary } from "../components/ProgressSummary";
import { TaskTable, type PendingRowExit } from "../components/TaskTable";
import { addDays, formatShortDate, toDateInput, weekdayLong, weekdayLongNames } from "../lib/dates";
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
  // Roll-over choreography: rows on this list collapse out (staggered) and
  // each one commits its date change as its own exit lands.
  const [pendingExit, setPendingExit] = useState<PendingRowExit | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const bodySettledRef = useRef(false);

  // Follow day selections made from the Calendar view.
  useEffect(() => {
    if (initialDate) {
      setViewDate(initialDate);
    }
  }, [initialDate]);

  // A remembered focus target only applies to the day it was created on.
  useEffect(() => {
    setFocusTaskId(null);
    setPendingExit(null);
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
    if (unfinishedTasks.length === 0) return;
    setPendingExit({ ids: unfinishedTasks.map((task) => task.id), date: addDays(viewDate, 1) });
  }

  // Once every rolled-over row has left the day, drop the marker so a task
  // re-dated back here doesn't get swept out again.
  useEffect(() => {
    if (pendingExit && !displayTasks.some((task) => pendingExit.ids.includes(task.id))) {
      setPendingExit(null);
    }
  }, [pendingExit, displayTasks]);

  function goTo(date: string, dir: NavDirection) {
    setNavDir(dir);
    setViewDate(date);
  }

  // The day's content travels with the navigation: everything under the
  // header slides in from the direction you went. No remount — the summary
  // canvas and table state stay live; opacity/transform only.
  useLayoutEffect(() => {
    if (!bodySettledRef.current) {
      bodySettledRef.current = true;
      return;
    }
    const el = bodyRef.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    el.animate(
      [{ opacity: 0.22, transform: `translateX(${navDir * 18}px)` }, { opacity: 1, transform: "none" }],
      { duration: 320, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }
    );
  }, [viewDate, navDir]);

  // The title names the day being viewed: "Today" at home, otherwise the
  // weekday itself; the concrete date sits underneath on the second line.
  const dayTitle = viewDate === today ? m.today.title : weekdayLong(viewDate, lang);

  return (
    <main className="page-content">
      <header className="page-header today-page-header">
        <DateSwitcher
          title={dayTitle}
          sub={formatShortDate(viewDate, lang)}
          titleSizer={[m.today.title, ...weekdayLongNames(lang)]}
          dir={navDir}
          onPrev={() => goTo(addDays(viewDate, -1), -1)}
          onNext={() => goTo(addDays(viewDate, 1), 1)}
          onHome={() => goTo(today, viewDate > today ? -1 : 1)}
          isHome={viewDate === today}
          prevAria={m.today.prevDay}
          nextAria={m.today.nextDay}
          homeAria={m.today.backToToday}
        />
        <p>{m.today.subtitle(displayTasks.length, summary.weightedPercent)}</p>
      </header>
      <div className="page-body" ref={bodyRef}>
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
          exitOnMove
          pendingExit={pendingExit}
          onCreate={onCreateTask}
          onUpdate={onUpdateTask}
          onDelete={onDeleteTask}
        />
      ) : (
        <p className="empty-state">{m.today.empty(formatShortDate(viewDate, lang))}</p>
      )}
      </div>
    </main>
  );
}
