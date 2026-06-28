import { ChevronLeft, ChevronRight, Flame } from "lucide-react";
import { useMemo, useState, type CSSProperties } from "react";
import { CompletionBar, MiniBarSeries } from "../components/calendar/CalendarCharts";
import {
  addDays,
  addMonths,
  addYears,
  eachDayInRange,
  endOfMonth,
  endOfWeek,
  endOfYear,
  formatMonthDay,
  monthGridWeeks,
  monthLabel,
  monthShort,
  startOfMonth,
  startOfWeek,
  startOfYear,
  todayDate,
  weekdayLabels,
  yearOf
} from "../lib/dates";
import {
  bucketTasksByDay,
  completionValue,
  COMPLETION_GOAL,
  statsForDays,
  statsForTasks,
  streakInfo,
  type CompletionMetric,
  type PeriodStats
} from "../lib/calendarStats";
import { progressTone } from "../lib/progress";
import type { Task } from "../lib/types";
import type { TaskPageProps } from "./pageProps";

type Granularity = "week" | "month" | "year";

interface CalendarPageProps extends TaskPageProps {
  onOpenDay: (date: string) => void;
  initialDate?: string | null;
}

const GRANULARITIES: Array<{ id: Granularity; label: string }> = [
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "year", label: "Year" }
];

const METRICS: Array<{ id: CompletionMetric; label: string }> = [
  { id: "weighted", label: "Weighted" },
  { id: "done", label: "Done rate" }
];

export function CalendarPage({ tasks, onOpenDay, initialDate }: CalendarPageProps) {
  const today = todayDate();
  const [granularity, setGranularity] = useState<Granularity>("month");
  const [metric, setMetric] = useState<CompletionMetric>("weighted");
  const [anchor, setAnchor] = useState(initialDate || today);

  const buckets = useMemo(() => bucketTasksByDay(tasks), [tasks]);
  const dayStats = useMemo(() => {
    const cache = new Map<string, PeriodStats>();
    return (date: string): PeriodStats => {
      let value = cache.get(date);
      if (!value) {
        value = statsForTasks(buckets.get(date) ?? []);
        cache.set(date, value);
      }
      return value;
    };
  }, [buckets]);

  const range = useMemo(() => {
    if (granularity === "week") {
      return { start: startOfWeek(anchor), end: endOfWeek(anchor) };
    }
    if (granularity === "month") {
      return { start: startOfMonth(anchor), end: endOfMonth(anchor) };
    }
    return { start: startOfYear(anchor), end: endOfYear(anchor) };
  }, [granularity, anchor]);

  const periodDays = useMemo(() => eachDayInRange(range.start, range.end), [range]);
  const periodStats = useMemo(() => statsForDays(buckets, periodDays), [buckets, periodDays]);

  const periodLabel =
    granularity === "week"
      ? `${formatMonthDay(range.start)} – ${formatMonthDay(range.end)}, ${yearOf(range.end)}`
      : granularity === "month"
        ? monthLabel(anchor)
        : yearOf(anchor);

  function shift(direction: 1 | -1) {
    setAnchor((current) =>
      granularity === "week"
        ? addDays(current, direction * 7)
        : granularity === "month"
          ? addMonths(current, direction)
          : addYears(current, direction)
    );
  }

  const isThisPeriod = today >= range.start && today <= range.end;

  return (
    <main className="page-content calendar-page">
      <header className="page-header calendar-header">
        <div className="cal-nav">
          <button type="button" className="icon-button date-nav-button" onClick={() => shift(-1)} aria-label="Previous period">
            <ChevronLeft size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`today-title-button${isThisPeriod ? " active" : ""}`}
            onClick={() => setAnchor(today)}
            aria-label="Jump to current period"
          >
            <h1>Calendar</h1>
            <span>{periodLabel}</span>
          </button>
          <button type="button" className="icon-button date-nav-button" onClick={() => shift(1)} aria-label="Next period">
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="cal-controls">
          <div className="cal-seg" role="group" aria-label="View">
            {GRANULARITIES.map((item) => (
              <button
                key={item.id}
                type="button"
                className={granularity === item.id ? "active" : ""}
                onClick={() => setGranularity(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="cal-seg" role="group" aria-label="Completion metric">
            {METRICS.map((item) => (
              <button key={item.id} type="button" className={metric === item.id ? "active" : ""} onClick={() => setMetric(item.id)}>
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </header>

      <CalendarSummary stats={periodStats} metric={metric} />

      {granularity === "week" ? (
        <WeekView days={periodDays} today={today} metric={metric} dayStats={dayStats} onOpenDay={onOpenDay} />
      ) : null}
      {granularity === "month" ? (
        <MonthView anchor={anchor} today={today} metric={metric} dayStats={dayStats} onOpenDay={onOpenDay} />
      ) : null}
      {granularity === "year" ? (
        <YearView anchor={anchor} today={today} metric={metric} buckets={buckets} dayStats={dayStats} onOpenDay={onOpenDay} onPickMonth={(month) => { setAnchor(month); setGranularity("month"); }} />
      ) : null}
    </main>
  );
}

function CalendarSummary({ stats, metric }: { stats: PeriodStats; metric: CompletionMetric }) {
  const value = completionValue(stats, metric);
  return (
    <section className="cal-summary" aria-label="Period summary">
      <div className="cal-summary__hero">
        <span className="cal-summary__label">{metric === "done" ? "Done rate" : "Weighted completion"}</span>
        <strong className="cal-summary__value">{value}%</strong>
        <CompletionBar value={value} label={`Completion ${value}%`} />
      </div>
      <div className="cal-summary__stats">
        <div>
          <span>Tasks</span>
          <strong>{stats.taskCount}</strong>
        </div>
        <div>
          <span>Done</span>
          <strong>{stats.doneCount}</strong>
        </div>
        <div>
          <span>Output</span>
          <strong>{stats.outputCount}</strong>
        </div>
        <div>
          <span>Blocked</span>
          <strong>{stats.blockedCount}</strong>
        </div>
      </div>
    </section>
  );
}

interface DayViewProps {
  today: string;
  metric: CompletionMetric;
  dayStats: (date: string) => PeriodStats;
  onOpenDay: (date: string) => void;
}

function WeekView({ days, today, metric, dayStats, onOpenDay }: DayViewProps & { days: string[] }) {
  const labels = weekdayLabels();
  return (
    <section className="cal-week">
      {days.map((date, index) => {
        const stats = dayStats(date);
        const value = completionValue(stats, metric);
        return (
          <button
            key={date}
            type="button"
            className={`cal-week__card${date === today ? " is-today" : ""}`}
            onClick={() => onOpenDay(date)}
          >
            <span className="cal-week__weekday">{labels[index]}</span>
            <span className="cal-week__date">{Number(date.split("-")[2])}</span>
            <CompletionBar value={value} label={`${value}%`} />
            <span className="cal-week__count">
              {stats.doneCount}/{stats.taskCount}
            </span>
            <span className="cal-week__dots">
              {stats.outputCount > 0 ? <i className="dot dot-output" title={`${stats.outputCount} output`} /> : null}
              {stats.blockedCount > 0 ? <i className="dot dot-blocked" title={`${stats.blockedCount} blocked`} /> : null}
            </span>
          </button>
        );
      })}
    </section>
  );
}

function MonthView({ anchor, today, metric, dayStats, onOpenDay }: DayViewProps & { anchor: string }) {
  const weeks = useMemo(() => monthGridWeeks(anchor), [anchor]);
  const labels = weekdayLabels();
  return (
    <section className="cal-month">
      <div className="cal-month__head">
        {labels.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>
      <div className="cal-month__grid">
        {weeks.flat().map((cell) => {
          const stats = dayStats(cell.date);
          const value = completionValue(stats, metric);
          const tone = stats.taskCount > 0 ? progressTone(value) : "empty";
          return (
            <button
              key={cell.date}
              type="button"
              className={`cal-cell tone-${tone}${cell.inMonth ? "" : " is-outside"}${cell.date === today ? " is-today" : ""}`}
              style={{ "--heat": stats.taskCount > 0 ? value : 0 } as CSSProperties}
              onClick={() => onOpenDay(cell.date)}
              title={`${cell.date}: ${value}% · ${stats.doneCount}/${stats.taskCount}`}
            >
              <span className="cal-cell__num">{Number(cell.date.split("-")[2])}</span>
              {stats.taskCount > 0 ? <span className="cal-cell__count">{stats.taskCount}</span> : null}
            </button>
          );
        })}
      </div>
    </section>
  );
}

interface YearViewProps extends DayViewProps {
  anchor: string;
  buckets: Map<string, Task[]>;
  onPickMonth: (month: string) => void;
}

function YearView({ anchor, today, metric, buckets, dayStats, onOpenDay, onPickMonth }: YearViewProps) {
  const yearKey = yearOf(anchor);

  const heatColumns = useMemo(() => {
    const heatStart = startOfWeek(startOfYear(anchor));
    const heatEnd = endOfWeek(endOfYear(anchor));
    const all = eachDayInRange(heatStart, heatEnd);
    const columns: string[][] = [];
    for (let i = 0; i < all.length; i += 7) {
      columns.push(all.slice(i, i + 7));
    }
    return columns;
  }, [anchor]);

  const monthSeries = useMemo(
    () =>
      Array.from({ length: 12 }, (_, index) => {
        const monthAnchor = `${yearKey}-${String(index + 1).padStart(2, "0")}-01`;
        const days = eachDayInRange(startOfMonth(monthAnchor), endOfMonth(monthAnchor));
        const stats = statsForDays(buckets, days);
        return { key: monthAnchor, label: monthShort(monthAnchor), value: completionValue(stats, metric) };
      }),
    [buckets, metric, yearKey]
  );

  const { streak, activeDays, bestMonth } = useMemo(() => {
    const streakEnd = endOfYear(anchor) > today ? today : endOfYear(anchor);
    const entries = eachDayInRange(startOfYear(anchor), streakEnd).map((date) => ({ date, stats: dayStats(date) }));
    const info = streakInfo(entries, (stats) => stats.taskCount > 0 && completionValue(stats, metric) >= COMPLETION_GOAL);
    const active = entries.filter((entry) => entry.stats.taskCount > 0).length;
    const best = monthSeries.reduce((winner, item) => (item.value > winner.value ? item : winner), monthSeries[0]);
    return { streak: info, activeDays: active, bestMonth: best };
  }, [anchor, today, metric, dayStats, monthSeries]);

  return (
    <section className="cal-year">
      <div className="cal-year__stats">
        <div className="cal-stat">
          <Flame size={16} aria-hidden="true" />
          <span>Current streak</span>
          <strong>{streak.current}d</strong>
        </div>
        <div className="cal-stat">
          <span>Longest streak</span>
          <strong>{streak.longest}d</strong>
        </div>
        <div className="cal-stat">
          <span>Active days</span>
          <strong>{activeDays}</strong>
        </div>
        <div className="cal-stat">
          <span>Best month</span>
          <strong>
            {bestMonth ? monthShort(bestMonth.key) : "—"} · {bestMonth ? Math.round(bestMonth.value) : 0}%
          </strong>
        </div>
      </div>

      <div className="cal-heatmap" role="img" aria-label={`${yearKey} completion heatmap`}>
        {heatColumns.map((column, columnIndex) => (
          <div key={columnIndex} className="cal-heatmap__col">
            {column.map((date) => {
              const inYear = date.slice(0, 4) === yearKey;
              const stats = dayStats(date);
              const value = completionValue(stats, metric);
              const tone = stats.taskCount > 0 ? progressTone(value) : "empty";
              return (
                <button
                  key={date}
                  type="button"
                  className={`cal-heatmap__cell tone-${tone}${inYear ? "" : " is-outside"}${date === today ? " is-today" : ""}`}
                  style={{ "--heat": stats.taskCount > 0 ? value : 0 } as CSSProperties}
                  onClick={() => onOpenDay(date)}
                  title={`${date}: ${value}% · ${stats.doneCount}/${stats.taskCount}`}
                  aria-label={`${date}: ${value}%`}
                />
              );
            })}
          </div>
        ))}
      </div>

      <div className="cal-year__months">
        <span className="cal-year__caption">Completion by month</span>
        <MiniBarSeries data={monthSeries} onSelect={onPickMonth} />
      </div>
    </section>
  );
}
