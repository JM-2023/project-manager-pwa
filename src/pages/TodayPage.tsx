import { ChevronsRight } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import { DateSwitcher, type NavDirection } from "../components/DateNav";
import { ProgressSummary } from "../components/ProgressSummary";
import { TaskComposer } from "../components/TaskComposer";
import { TaskTable } from "../components/TaskTable";
import { addDays, formatDayLabel, formatShortDate, toDateInput, weekdayLong, weekdayLongNames } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import {
  getTaskProgress,
  importancePriority,
  isBlankTask,
  isProjectCacheTask,
  summarizeProgress,
  type TaskImportance
} from "../lib/progress";
import { useToday } from "../lib/useToday";
import type { Task } from "../lib/types";
import type { TaskPageProps } from "./pageProps";

function taskRecordDate(task: Task): string {
  return toDateInput(task.start_date);
}

export function TodayPage(props: TaskPageProps & { selectedDate: string | null; onDateChange: (date: string) => void }) {
  const { m, lang } = useI18n();
  const { projects, tasks, onCreateTask, onUpdateTask, onDeleteTask, onMoveTasks, selectedDate, onDateChange } = props;
  const today = useToday();
  // A null selection follows today across midnight; explicit dates stay put.
  const viewDate = selectedDate ?? today;
  // Which way the view moved, read from the dates themselves (ISO dates
  // sort as text), so every way to another day (the arrows, the title, the
  // Today tab, midnight) slides and rolls from the side it came from.
  // Decided during render, so the title's roll and the body's slide both
  // see it in the commit that changes the day.
  const [shownDate, setShownDate] = useState(viewDate);
  const [navDir, setNavDir] = useState<NavDirection>(1);
  if (shownDate !== viewDate) {
    setShownDate(viewDate);
    setNavDir(viewDate > shownDate ? 1 : -1);
  }
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const bodySettledRef = useRef(false);
  const bodySlideRef = useRef<Animation | null>(null);

  const datedTasks = tasks.filter((task) => {
    if (task.deleted_at || task.archived || task.status === "cancelled") return false;
    if (isProjectCacheTask(task)) return false;
    return Boolean(taskRecordDate(task));
  });
  const displayTasks = datedTasks.filter((task) => taskRecordDate(task) === viewDate);
  const summary = summarizeProgress(displayTasks);
  // An empty leftover row isn't unfinished work; it doesn't travel.
  const unfinishedTasks = displayTasks.filter((task) => getTaskProgress(task) < 100 && !isBlankTask(task));
  const nextDay = addDays(viewDate, 1);

  function addTask(title: string, importance: TaskImportance) {
    onCreateTask({
      title,
      project_id: null,
      status: "todo",
      priority: importancePriority(importance),
      start_date: viewDate,
      next_action: null,
      extra_json: JSON.stringify({ importance, progress_percent: 0 })
    });
  }

  // Every unfinished task moves to the next day at once (the table folds
  // the rows out top to bottom), and the undo bar offers them back.
  function rolloverUnfinished() {
    onMoveTasks(unfinishedTasks, nextDay);
  }

  // The new day arrives as one sheet: everything under the header slides
  // in from the direction you went, on one clock. The day's list is
  // remounted (keyed by day) but has no entrance of its own; an empty-day
  // note that mounts with it would fade on a clock of its own, so it is
  // finished here and rides the slide too. A press mid-slide starts the
  // next day's slide over.
  useLayoutEffect(() => {
    if (!bodySettledRef.current) {
      bodySettledRef.current = true;
      return;
    }
    const el = bodyRef.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    for (const note of el.querySelectorAll(".empty-state")) {
      for (const animation of note.getAnimations()) animation.finish();
    }
    bodySlideRef.current?.cancel();
    bodySlideRef.current = el.animate(
      [{ opacity: 0.22, transform: `translateX(${navDir * 18}px)` }, { opacity: 1, transform: "none" }],
      { duration: 180, easing: "cubic-bezier(0.23, 1, 0.32, 1)" }
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
          sub={formatDayLabel(viewDate, lang)}
          titleSizer={[m.today.title, ...weekdayLongNames(lang)]}
          dir={navDir}
          onPrev={() => onDateChange(addDays(viewDate, -1))}
          onNext={() => onDateChange(addDays(viewDate, 1))}
          onHome={() => onDateChange(today)}
          isHome={viewDate === today}
          prevAria={m.today.prevDay}
          nextAria={m.today.nextDay}
          homeAria={m.today.backToToday}
        />
        <p>{m.today.subtitle(summary.taskCount, summary.weightedPercent)}</p>
      </header>
      <div className="page-body" ref={bodyRef}>
      <ProgressSummary label={m.today.dailySummary} summary={summary} />
      <TaskComposer onCreate={addTask} />
      {/* Mounted even when the day empties, so its last rows can fold out.
          Keyed by day: each day is its own list, so a day switch swaps it
          whole and it rides the body's slide (it has no entrance of its own). */}
      <TaskTable
        key={viewDate}
        tasks={displayTasks}
        projects={projects}
        showDate={false}
        onCreate={onCreateTask}
        onUpdate={onUpdateTask}
        onDelete={onDeleteTask}
        onMove={(task, date) => onMoveTasks([task], date)}
      />
      {displayTasks.length === 0 ? (
        <p className="empty-state">{m.today.empty(formatShortDate(viewDate, lang))}</p>
      ) : null}
      {/* Rolling over is what you do after going through the day, so it
          sits where the day's list ends, and only while there is some. */}
      {unfinishedTasks.length > 0 ? (
        <button type="button" className="add-row-button today-rollover" onClick={rolloverUnfinished}>
          <ChevronsRight size={18} aria-hidden="true" />
          <span>{m.today.rollover(unfinishedTasks.length, formatDayLabel(nextDay, lang))}</span>
        </button>
      ) : null}
      </div>
    </main>
  );
}
