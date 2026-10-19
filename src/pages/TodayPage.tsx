import { ChevronsRight, Plus } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { DateSwitcher, type NavDirection } from "../components/DateNav";
import { ProgressSummary } from "../components/ProgressSummary";
import { TaskTable } from "../components/TaskTable";
import { addDays, daysFromToday, formatDayLabel, toDateInput, weekdayLong, weekdayLongNames } from "../lib/dates";
import { useI18n } from "../lib/i18n";
import { EASE_OUT } from "../lib/morph";
import { getTaskProgress, importancePriority, isProjectCacheTask, summarizeProgress } from "../lib/progress";
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
  const [focusTaskId, setFocusTaskId] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const bodySettledRef = useRef(false);
  const bodySlideRef = useRef<Animation | null>(null);

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
  const doneCount = displayTasks.length - unfinishedTasks.length;
  const previousDay = addDays(viewDate, -1);
  const isPast = viewDate < today;
  // What the day before left unfinished, offered to an empty day from today on.
  const carried = isPast
    ? []
    : datedTasks.filter((task) => taskRecordDate(task) === previousDay && getTaskProgress(task) < 100);

  // An empty day is a place to plan, not a page of zeros: Add Task sits in a
  // card that names the day, and the progress card stays away until there
  // is progress to show. A task added from that card is titled with the
  // card still there, so nothing moves under the typing; once the focus
  // leaves the day, the progress card and the add buttons take its place.
  const empty = displayTasks.length === 0;
  const [planHold, setPlanHold] = useState(false);
  const [planDate, setPlanDate] = useState<string | null>(empty ? viewDate : null);
  if (empty && planDate !== viewDate) setPlanDate(viewDate);
  if (!empty && planDate !== null && !(planHold && planDate === viewDate)) setPlanDate(null);
  const planning = empty || (planDate === viewDate && planHold);
  const topRef = useRef<HTMLDivElement | null>(null);
  const topFromRef = useRef<{ date: string; height: number } | null>(null);
  const [shownPlanning, setShownPlanning] = useState(planning);
  if (shownPlanning !== planning) {
    setShownPlanning(planning);
    const top = topRef.current;
    topFromRef.current = top ? { date: viewDate, height: top.getBoundingClientRect().height } : null;
  }

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
    if (planning) setPlanHold(true);
  }

  // A hold whose new title never took the focus (a browser that refused
  // it) has nothing to wait for.
  useEffect(() => {
    if (planHold && !bodyRef.current?.contains(document.activeElement)) setPlanHold(false);
  }, [planHold]);

  // Every unfinished task moves to tomorrow at once (the table folds the
  // rows out top to bottom), and the undo bar offers them back.
  function rolloverUnfinished() {
    onMoveTasks(unfinishedTasks, addDays(viewDate, 1));
  }

  // Roll Over the other way: the day before's unfinished tasks come here.
  function bringOver() {
    onMoveTasks(carried, viewDate);
  }

  // The plan card and the progress card hand over in place: the block
  // between the header and the list eases from the one's height to the
  // other's, and the rows below ride it, instead of jumping by the difference.
  useLayoutEffect(() => {
    const from = topFromRef.current;
    topFromRef.current = null;
    const top = topRef.current;
    if (!from || !top || from.date !== viewDate || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const to = top.getBoundingClientRect().height;
    if (Math.abs(to - from.height) < 1) return;
    top.style.overflow = "hidden";
    const grow = top.animate([{ height: `${from.height}px` }, { height: `${to}px` }], { duration: 360, easing: EASE_OUT });
    top.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 220, easing: EASE_OUT });
    const release = () => {
      top.style.overflow = "";
    };
    grow.finished.then(release, release);
  }, [planning, viewDate]);

  // The new day arrives as one sheet: everything under the header slides
  // in from the direction you went, on one clock. The day's list is
  // remounted (keyed by day) but has no entrance of its own, and neither
  // has the plan card. A press mid-slide starts the next day's slide over.
  useLayoutEffect(() => {
    if (!bodySettledRef.current) {
      bodySettledRef.current = true;
      return;
    }
    const el = bodyRef.current;
    if (!el || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    bodySlideRef.current?.cancel();
    bodySlideRef.current = el.animate(
      [{ opacity: 0.22, transform: `translateX(${navDir * 18}px)` }, { opacity: 1, transform: "none" }],
      { duration: 180, easing: "cubic-bezier(0.23, 1, 0.32, 1)" }
    );
  }, [viewDate, navDir]);

  // The title names the day being viewed: "Today" at home, otherwise the
  // weekday itself; the concrete date sits underneath on the second line.
  const dayTitle = viewDate === today ? m.today.title : weekdayLong(viewDate, lang);
  const daysAhead = daysFromToday(viewDate) ?? 0;
  const carriedFrom = previousDay === today ? m.today.title : previousDay === addDays(today, -1) ? m.today.yesterday : formatDayLabel(previousDay, lang);
  const addButton = (
    <button type="button" className="add-row-button" onClick={addTask}>
      <Plus size={18} aria-hidden="true" />
      <span>{m.today.addTask}</span>
    </button>
  );

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
        {/* What the big number doesn't say: how many, and how many done. */}
        <p>{m.today.subtitle(displayTasks.length, doneCount)}</p>
      </header>
      <div
        className="page-body"
        ref={bodyRef}
        onBlur={(event) => {
          if (planHold && !event.currentTarget.contains(event.relatedTarget as Node | null)) setPlanHold(false);
        }}
      >
      <div className="day-top" ref={topRef}>
        {planning ? (
          <section className="day-plan" aria-label={m.today.planAria}>
            {isPast ? (
              <p className="day-plan__note">{m.today.nothingRecorded}</p>
            ) : (
              <>
                <p className="day-plan__eyebrow">{m.today.planWhen(daysAhead)}</p>
                <h2 className="day-plan__title">{viewDate === today ? m.today.planToday : m.today.planDay(weekdayLong(viewDate, lang))}</h2>
              </>
            )}
            <div className="add-row-actions">{addButton}</div>
            {carried.length > 0 && empty ? (
              <div className="day-plan__carry">
                <div className="day-plan__carry-text">
                  <strong>{m.today.bringOver(carried.length, carriedFrom)}</strong>
                  <span>{carried.map((task) => `${task.title.trim() || m.taskTable.newTask} · ${getTaskProgress(task)}%`).join(" — ")}</span>
                </div>
                <button type="button" className="task-card-action" onClick={bringOver}>
                  <ChevronsRight size={14} aria-hidden="true" />
                  <span>{m.today.bringOverAction}</span>
                </button>
              </div>
            ) : null}
          </section>
        ) : (
          <>
            <ProgressSummary label={m.today.dailySummary} summary={summary} />
            <div className="add-row-actions">
              {addButton}
              <button
                type="button"
                className="add-row-button"
                onClick={rolloverUnfinished}
                disabled={unfinishedTasks.length === 0}
                aria-label={m.today.rolloverAria}
              >
                <ChevronsRight size={18} aria-hidden="true" />
                <span>{m.today.rollover}</span>
              </button>
            </div>
          </>
        )}
      </div>
      {/* Mounted even when the day empties, so its last rows can fold out.
          Keyed by day: each day is its own list, so a day switch swaps it
          whole and it rides the body's slide (it has no entrance of its own). */}
      <TaskTable
        key={viewDate}
        tasks={displayTasks}
        projects={projects}
        showDate={false}
        focusTaskId={focusTaskId}
        onCreate={onCreateTask}
        onUpdate={onUpdateTask}
        onDelete={onDeleteTask}
        onMove={(task, date) => onMoveTasks([task], date)}
      />
      </div>
    </main>
  );
}
