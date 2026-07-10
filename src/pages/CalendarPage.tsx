import {
  Activity,
  AlertTriangle,
  Award,
  CalendarPlus,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  FileText,
  Flame,
  Minus,
  Target,
  TrendingDown,
  TrendingUp,
  Trophy
} from "lucide-react";
import { useMemo, useState, type CSSProperties, type ReactNode } from "react";
import { CompletionBar, MiniBarSeries } from "../components/calendar/CalendarCharts";
import { SegControl } from "../components/SegControl";
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
  weekdayLabels,
  weekdayShort,
  yearOf,
  type MonthGridDay
} from "../lib/dates";
import { useToday } from "../lib/useToday";
import {
  bucketTasksByDay,
  completionValue,
  COMPLETION_GOAL,
  importanceMixForDays,
  projectFocusForDays,
  statsForDays,
  statsForTasks,
  streakInfo,
  worklogEntriesForDays,
  type CompletionMetric,
  type ImportanceBand,
  type PeriodStats,
  type ProjectFocus,
  type WorklogEntry
} from "../lib/calendarStats";
import { useI18n, type Language, type Messages, type PeriodNoun } from "../lib/i18n";
import { progressTone } from "../lib/progress";
import type { Project, Task } from "../lib/types";
import type { TaskPageProps } from "./pageProps";

type Granularity = "week" | "month" | "year";

interface CalendarPageProps extends TaskPageProps {
  onOpenDay: (date: string) => void;
  initialDate?: string | null;
}

const GRANULARITIES: Granularity[] = ["week", "month", "year"];
const METRICS: CompletionMetric[] = ["weighted", "done"];

/** No-project / unknown-project fallbacks for the project focus card. */
function focusLabels(m: Messages) {
  return { noProject: m.common.noProject, unknownProject: m.common.unknownProject };
}

export function CalendarPage({ tasks, projects, archivedProjects, onOpenDay, initialDate }: CalendarPageProps) {
  const { m, lang } = useI18n();
  const today = useToday();
  const [granularity, setGranularity] = useState<Granularity>("month");
  const [metric, setMetric] = useState<CompletionMetric>("weighted");
  const [anchor, setAnchor] = useState(initialDate || today);

  const buckets = useMemo(() => bucketTasksByDay(tasks), [tasks]);
  const allProjects = useMemo(() => [...projects, ...archivedProjects], [projects, archivedProjects]);
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
      ? lang === "zh"
        ? `${yearOf(range.end)}年 ${formatMonthDay(range.start, lang)} – ${formatMonthDay(range.end, lang)}`
        : `${formatMonthDay(range.start)} – ${formatMonthDay(range.end)}, ${yearOf(range.end)}`
      : granularity === "month"
        ? monthLabel(anchor, lang)
        : lang === "zh"
          ? `${yearOf(anchor)}年`
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
          <button type="button" className="icon-button date-nav-button" onClick={() => shift(-1)} aria-label={m.calendar.prevPeriod}>
            <ChevronLeft size={18} aria-hidden="true" />
          </button>
          <button
            type="button"
            className={`today-title-button${isThisPeriod ? " active" : ""}`}
            onClick={() => setAnchor(today)}
            aria-label={m.calendar.jumpCurrent}
          >
            <h1>{m.calendar.title}</h1>
            <span>{periodLabel}</span>
          </button>
          <button type="button" className="icon-button date-nav-button" onClick={() => shift(1)} aria-label={m.calendar.nextPeriod}>
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        </div>
        <div className="cal-controls">
          <SegControl
            ariaLabel={m.calendar.viewAria}
            value={granularity}
            onChange={setGranularity}
            options={GRANULARITIES.map((id) => ({ id, label: m.calendar[id] }))}
          />
          <SegControl
            ariaLabel={m.calendar.metricAria}
            value={metric}
            onChange={setMetric}
            options={METRICS.map((id) => ({ id, label: id === "weighted" ? m.calendar.weighted : m.calendar.doneRate }))}
          />
        </div>
      </header>

      <CalendarSummary stats={periodStats} metric={metric} />

      {granularity === "week" ? (
        <WeekView
          days={periodDays}
          today={today}
          metric={metric}
          stats={periodStats}
          buckets={buckets}
          projects={allProjects}
          dayStats={dayStats}
          onOpenDay={onOpenDay}
        />
      ) : null}
      {granularity === "month" ? (
        <MonthView
          anchor={anchor}
          days={periodDays}
          today={today}
          metric={metric}
          stats={periodStats}
          buckets={buckets}
          projects={allProjects}
          dayStats={dayStats}
          onOpenDay={onOpenDay}
          onPickWeek={(date) => {
            setAnchor(date);
            setGranularity("week");
          }}
        />
      ) : null}
      {granularity === "year" ? (
        <YearView
          anchor={anchor}
          days={periodDays}
          today={today}
          metric={metric}
          stats={periodStats}
          buckets={buckets}
          projects={allProjects}
          dayStats={dayStats}
          onOpenDay={onOpenDay}
          onPickMonth={(month) => {
            setAnchor(month);
            setGranularity("month");
          }}
        />
      ) : null}
    </main>
  );
}

function CalendarSummary({ stats, metric }: { stats: PeriodStats; metric: CompletionMetric }) {
  const { m } = useI18n();
  const value = completionValue(stats, metric);
  return (
    <section className="cal-summary" aria-label={m.calendar.summaryAria}>
      <div className="cal-summary__hero">
        <span className="cal-summary__label">{metric === "done" ? m.calendar.doneRate : m.calendar.weightedCompletion}</span>
        <strong className="cal-summary__value">{value}%</strong>
        <CompletionBar value={value} label={m.calendar.completionAria(value)} />
      </div>
      <div className="cal-summary__stats">
        <div>
          <span>{m.calendar.tasks}</span>
          <strong>{stats.taskCount}</strong>
        </div>
        <div>
          <span>{m.calendar.done}</span>
          <strong>{stats.doneCount}</strong>
        </div>
        <div>
          <span>{m.calendar.output}</span>
          <strong>{stats.outputCount}</strong>
        </div>
        <div>
          <span>{m.calendar.blocked}</span>
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

interface WeekViewProps extends DayViewProps {
  days: string[];
  stats: PeriodStats;
  buckets: Map<string, Task[]>;
  projects: Project[];
}

/** Short "Tue 30" / "周二 30" chip label for a day. */
function dayChip(date: string, lang: Language): string {
  return `${weekdayShort(date, lang)} ${Number(date.split("-")[2])}`;
}

/* ---- Shared insight building blocks (week / month / year) ---- */

function StatChip({
  icon,
  label,
  value,
  hint,
  valueClass
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  valueClass?: string;
}) {
  return (
    <div className="cal-stat">
      {icon}
      <span>{label}</span>
      <strong className={valueClass}>{value}</strong>
      {hint ? <small>{hint}</small> : null}
    </div>
  );
}

/** "vs last week/month/year" delta chip comparing the same metric across periods. */
function TrendStat({ noun, stats, prevStats, metric }: { noun: PeriodNoun; stats: PeriodStats; prevStats: PeriodStats; metric: CompletionMetric }) {
  const { m } = useI18n();
  const value = completionValue(stats, metric);
  const prevValue = completionValue(prevStats, metric);
  const delta = value - prevValue;
  const flat = prevStats.taskCount === 0 || delta === 0;
  const trendClass = flat ? undefined : delta > 0 ? "trend-up" : "trend-down";
  return (
    <StatChip
      icon={
        flat ? (
          <Minus size={16} aria-hidden="true" />
        ) : delta > 0 ? (
          <TrendingUp size={16} aria-hidden="true" className="trend-up" />
        ) : (
          <TrendingDown size={16} aria-hidden="true" className="trend-down" />
        )
      }
      label={m.calendar.vsLast(noun)}
      value={prevStats.taskCount === 0 ? m.calendar.newBadge : m.calendar.pt(delta)}
      valueClass={trendClass}
      hint={prevStats.taskCount === 0 ? m.calendar.noDataLast(noun) : `${prevValue}% → ${value}%`}
    />
  );
}

/** Importance-1 progress chip, fed by the period's importance mix. */
function CoreFocusStat({ mix, metric }: { mix: ImportanceBand[]; metric: CompletionMetric }) {
  const { m } = useI18n();
  const core = mix[0];
  return (
    <StatChip
      icon={<Target size={16} aria-hidden="true" />}
      label={m.calendar.coreFocus}
      value={core.taskCount > 0 ? `${completionValue(core.stats, metric)}%` : "—"}
      hint={core.taskCount > 0 ? m.calendar.coreTasks(core.taskCount) : m.calendar.noCoreTasks}
    />
  );
}

function EmptyInsights({ noun }: { noun: PeriodNoun }) {
  const { m } = useI18n();
  return (
    <section className="cal-insights" aria-label={m.calendar.insightsAria(noun)}>
      <div className="cal-card cal-insights__empty">
        <CalendarPlus size={16} aria-hidden="true" />
        <p>{m.calendar.emptyInsights(noun)}</p>
      </div>
    </section>
  );
}

function WeekView({ days, today, metric, stats, buckets, projects, dayStats, onOpenDay }: WeekViewProps) {
  const { m, lang } = useI18n();
  const labels = weekdayLabels(1, lang);
  return (
    <>
      <section className="cal-week">
        {days.map((date, index) => {
          const dayStat = dayStats(date);
          const value = completionValue(dayStat, metric);
          const isFuture = date > today;
          return (
            <button
              key={date}
              type="button"
              className={`cal-week__card${date === today ? " is-today" : ""}${isFuture ? " is-future" : ""}`}
              onClick={() => onOpenDay(date)}
            >
              <span className="cal-week__weekday">{labels[index]}</span>
              <span className="cal-week__date">{Number(date.split("-")[2])}</span>
              <CompletionBar value={value} label={`${value}%`} />
              <span className="cal-week__meta">
                <span className="cal-week__count">
                  {dayStat.doneCount}/{dayStat.taskCount}
                </span>
                <span className={`cal-week__pct tone-${dayStat.taskCount > 0 ? progressTone(value) : "empty"}`}>
                  {dayStat.taskCount > 0 ? `${value}%` : "—"}
                </span>
              </span>
              <span className="cal-week__dots">
                {dayStat.outputCount > 0 ? <i className="dot dot-output" title={m.calendar.dotOutput(dayStat.outputCount)} /> : null}
                {dayStat.blockedCount > 0 ? <i className="dot dot-blocked" title={m.calendar.dotBlocked(dayStat.blockedCount)} /> : null}
              </span>
            </button>
          );
        })}
      </section>
      <WeekInsights
        days={days}
        today={today}
        metric={metric}
        stats={stats}
        buckets={buckets}
        projects={projects}
        dayStats={dayStats}
        onOpenDay={onOpenDay}
      />
    </>
  );
}

function WeekInsights({ days, today, metric, stats, buckets, projects, dayStats, onOpenDay }: WeekViewProps) {
  const { m, lang } = useI18n();
  const prevDays = useMemo(() => days.map((date) => addDays(date, -7)), [days]);
  const prevStats = useMemo(() => statsForDays(buckets, prevDays), [buckets, prevDays]);
  const focus = useMemo(() => projectFocusForDays(buckets, days, projects, focusLabels(m)), [buckets, days, projects, m]);
  const mix = useMemo(() => importanceMixForDays(buckets, days), [buckets, days]);
  const outputs = useMemo(() => worklogEntriesForDays(buckets, days, "output"), [buckets, days]);
  const blockers = useMemo(() => worklogEntriesForDays(buckets, days, "blocker"), [buckets, days]);

  const bestDay = useMemo(() => {
    let winner: { date: string; value: number } | null = null;
    for (const date of days) {
      const dayStat = dayStats(date);
      if (dayStat.taskCount === 0) {
        continue;
      }
      const value = completionValue(dayStat, metric);
      if (!winner || value > winner.value) {
        winner = { date, value };
      }
    }
    return winner;
  }, [days, dayStats, metric]);

  const activeDays = useMemo(() => days.filter((date) => dayStats(date).taskCount > 0).length, [days, dayStats]);
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);

  if (stats.taskCount === 0) {
    return <EmptyInsights noun="week" />;
  }

  return (
    <section className="cal-insights" aria-label={m.calendar.insightsAria("week")}>
      <div className="cal-insights__pulse">
        <TrendStat noun="week" stats={stats} prevStats={prevStats} metric={metric} />
        <StatChip
          icon={<Trophy size={16} aria-hidden="true" />}
          label={m.calendar.bestDay}
          value={bestDay ? dayChip(bestDay.date, lang) : "—"}
          hint={bestDay ? m.calendar.metricValue(bestDay.value, metric) : m.calendar.noActiveDay}
        />
        <StatChip
          icon={<Activity size={16} aria-hidden="true" />}
          label={m.calendar.activeDays}
          value={`${activeDays}/7`}
          hint={m.calendar.tasksDone(stats.taskCount, stats.doneCount)}
        />
        <CoreFocusStat mix={mix} metric={metric} />
      </div>

      <div className="cal-insights__duo">
        <ProjectFocusCard focus={focus} metric={metric} noun="week" />
        <FocusMixCard mix={mix} metric={metric} />
      </div>

      <WorklogCard
        kind="output"
        title={m.calendar.weeklyOutput}
        icon={<FileText size={14} aria-hidden="true" />}
        entries={outputs}
        emptyHint={m.calendar.outputEmptyWeek}
        today={today}
        projectById={projectById}
        onOpenDay={onOpenDay}
      />
      {blockers.length > 0 ? (
        <WorklogCard
          kind="blocker"
          title={m.calendar.blockers}
          icon={<AlertTriangle size={14} aria-hidden="true" />}
          entries={blockers}
          today={today}
          projectById={projectById}
          onOpenDay={onOpenDay}
        />
      ) : null}
    </section>
  );
}

const FOCUS_LIMIT = 6;

function ProjectFocusCard({ focus, metric, noun }: { focus: ProjectFocus[]; metric: CompletionMetric; noun: PeriodNoun }) {
  const { m } = useI18n();
  const visible = focus.slice(0, FOCUS_LIMIT);
  const hidden = focus.length - visible.length;
  return (
    <div className="cal-card">
      <div className="cal-card__head">
        <span className="cal-card__title">{m.calendar.projectFocus}</span>
        <span className="cal-card__badge">{focus.length}</span>
      </div>
      <div className="cal-proj">
        {visible.map((row) => {
          const rowValue = completionValue(row.stats, metric);
          return (
            <div key={row.id} className="cal-proj__row" title={m.calendar.weightShareTitle(row.name, Math.round(row.weightShare), noun)}>
              <span className="cal-proj__name">
                <span className="project-color" style={{ backgroundColor: row.color ?? "var(--primary)" }} />
                <span>{row.name}</span>
              </span>
              <span className="cal-proj__meta">
                {row.stats.doneCount}/{row.stats.taskCount}
              </span>
              <strong className="cal-proj__value">{rowValue}%</strong>
              <CompletionBar value={rowValue} label={`${row.name} ${rowValue}%`} />
            </div>
          );
        })}
        {hidden > 0 ? <span className="cal-proj__more">{m.calendar.more(hidden)}</span> : null}
      </div>
    </div>
  );
}

function FocusMixCard({ mix, metric }: { mix: ImportanceBand[]; metric: CompletionMetric }) {
  const { m } = useI18n();
  const total = mix.reduce((sum, band) => sum + band.taskCount, 0);
  return (
    <div className="cal-card">
      <div className="cal-card__head">
        <span className="cal-card__title">{m.calendar.focusMix}</span>
        <span className="cal-card__badge">{total}</span>
      </div>
      <div className="cal-mix__bar" role="img" aria-label={m.calendar.mixAria}>
        {mix
          .filter((band) => band.taskCount > 0)
          .map((band) => (
            <span
              key={band.importance}
              className={`cal-mix__seg imp-${band.importance}`}
              style={{ width: `${band.countShare}%` }}
              title={m.calendar.bandTitle(band.importance, band.taskCount)}
            />
          ))}
      </div>
      <div className="cal-mix__legend">
        {mix.map((band) => (
          <div key={band.importance} className={`cal-mix__item${band.taskCount === 0 ? " is-empty" : ""}`}>
            <i className={`cal-mix__dot imp-${band.importance}`} aria-hidden="true" />
            <span className="cal-mix__label">P{band.importance}</span>
            <span className="cal-mix__count">{band.taskCount > 0 ? m.calendar.bandTasks(band.taskCount) : "—"}</span>
            <strong className="cal-mix__value">{band.taskCount > 0 ? `${completionValue(band.stats, metric)}%` : ""}</strong>
          </div>
        ))}
      </div>
    </div>
  );
}

const LOG_LIMIT = 6;

interface WorklogCardProps {
  kind: "output" | "blocker";
  title: string;
  icon: ReactNode;
  entries: WorklogEntry[];
  emptyHint?: string;
  today: string;
  projectById: Map<string, Project>;
  onOpenDay: (date: string) => void;
}

function WorklogCard({ kind, title, icon, entries, emptyHint, today, projectById, onOpenDay }: WorklogCardProps) {
  const { m, lang } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? entries : entries.slice(0, LOG_LIMIT);
  const hidden = entries.length - LOG_LIMIT;
  return (
    <div className={`cal-card cal-log-card is-${kind}`}>
      <div className="cal-card__head">
        {icon}
        <span className="cal-card__title">{title}</span>
        <span className="cal-card__badge">{entries.length}</span>
      </div>
      {entries.length === 0 ? (
        <p className="cal-log__empty">{emptyHint}</p>
      ) : (
        <div className="cal-log">
          {visible.map((entry, index) => {
            const project = entry.task.project_id ? projectById.get(entry.task.project_id) : undefined;
            return (
              <button
                key={`${entry.task.id}-${index}`}
                type="button"
                className="cal-log__row"
                style={{ "--i": index } as CSSProperties}
                onClick={() => onOpenDay(entry.date)}
              >
                <span className={`cal-log__chip${entry.date === today ? " is-today" : ""}`}>{dayChip(entry.date, lang)}</span>
                <span className="cal-log__body">
                  <span className="cal-log__text">{entry.text}</span>
                  <span className="cal-log__meta">
                    {project ? `${project.name} · ` : ""}
                    {entry.task.title}
                  </span>
                </span>
              </button>
            );
          })}
          {hidden > 0 ? (
            <button type="button" className="cal-log__more" onClick={() => setExpanded((current) => !current)}>
              <ChevronDown size={14} aria-hidden="true" className={expanded ? "is-open" : ""} />
              {expanded ? m.calendar.showLess : m.calendar.showAll(entries.length)}
            </button>
          ) : null}
        </div>
      )}
    </div>
  );
}

interface MonthViewProps extends DayViewProps {
  anchor: string;
  days: string[];
  stats: PeriodStats;
  buckets: Map<string, Task[]>;
  projects: Project[];
  onPickWeek: (date: string) => void;
}

function MonthView({ anchor, days, today, metric, stats, buckets, projects, dayStats, onOpenDay, onPickWeek }: MonthViewProps) {
  const { lang } = useI18n();
  const weeks = useMemo(() => monthGridWeeks(anchor), [anchor]);
  const labels = weekdayLabels(1, lang);
  return (
    <>
      <section className="cal-month">
        <div className="cal-month__head">
          {labels.map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
        <div className="cal-month__grid">
          {weeks.flat().map((cell) => {
            const cellStats = dayStats(cell.date);
            const value = completionValue(cellStats, metric);
            const tone = cellStats.taskCount > 0 ? progressTone(value) : "empty";
            return (
              <button
                key={cell.date}
                type="button"
                className={`cal-cell tone-${tone}${cell.inMonth ? "" : " is-outside"}${cell.date === today ? " is-today" : ""}`}
                style={{ "--heat": cellStats.taskCount > 0 ? value : 0 } as CSSProperties}
                onClick={() => onOpenDay(cell.date)}
                title={`${cell.date}: ${value}% · ${cellStats.doneCount}/${cellStats.taskCount}`}
              >
                <span className="cal-cell__num">{Number(cell.date.split("-")[2])}</span>
                {cellStats.taskCount > 0 ? <span className="cal-cell__count">{cellStats.taskCount}</span> : null}
              </button>
            );
          })}
        </div>
      </section>
      <MonthInsights
        anchor={anchor}
        days={days}
        weeks={weeks}
        today={today}
        metric={metric}
        stats={stats}
        buckets={buckets}
        projects={projects}
        dayStats={dayStats}
        onOpenDay={onOpenDay}
        onPickWeek={onPickWeek}
      />
    </>
  );
}

function MonthInsights({
  anchor,
  days,
  weeks,
  today,
  metric,
  stats,
  buckets,
  projects,
  dayStats,
  onOpenDay,
  onPickWeek
}: MonthViewProps & { weeks: MonthGridDay[][] }) {
  const { m, lang } = useI18n();
  const prevDays = useMemo(() => {
    const prevAnchor = addMonths(startOfMonth(anchor), -1);
    return eachDayInRange(prevAnchor, endOfMonth(prevAnchor));
  }, [anchor]);
  const prevStats = useMemo(() => statsForDays(buckets, prevDays), [buckets, prevDays]);
  const focus = useMemo(() => projectFocusForDays(buckets, days, projects, focusLabels(m)), [buckets, days, projects, m]);
  const mix = useMemo(() => importanceMixForDays(buckets, days), [buckets, days]);
  const outputs = useMemo(() => worklogEntriesForDays(buckets, days, "output"), [buckets, days]);
  const blockers = useMemo(() => worklogEntriesForDays(buckets, days, "blocker"), [buckets, days]);
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);

  /* One bar per calendar row of the month grid, measured on in-month days only
     so the numbers reconcile with the month total. */
  const weekSeries = useMemo(
    () =>
      weeks.map((week, index) => {
        const inMonth = week.filter((cell) => cell.inMonth).map((cell) => cell.date);
        const first = inMonth[0];
        const last = inMonth[inMonth.length - 1];
        const weekStats = statsForDays(buckets, inMonth);
        return {
          key: first,
          label: m.calendar.weekN(index + 1),
          value: completionValue(weekStats, metric),
          hint: first === last ? formatMonthDay(first, lang) : `${formatMonthDay(first, lang)} – ${formatMonthDay(last, lang)}`,
          active: today >= first && today <= last,
          taskCount: weekStats.taskCount
        };
      }),
    [weeks, buckets, metric, today, m, lang]
  );

  const bestWeek = useMemo(() => {
    let winner: (typeof weekSeries)[number] | null = null;
    for (const week of weekSeries) {
      if (week.taskCount === 0) {
        continue;
      }
      if (!winner || week.value > winner.value) {
        winner = week;
      }
    }
    return winner;
  }, [weekSeries]);

  const activeDays = useMemo(() => days.filter((date) => dayStats(date).taskCount > 0).length, [days, dayStats]);

  if (stats.taskCount === 0) {
    return <EmptyInsights noun="month" />;
  }

  return (
    <section className="cal-insights" aria-label={m.calendar.insightsAria("month")}>
      <div className="cal-insights__pulse">
        <TrendStat noun="month" stats={stats} prevStats={prevStats} metric={metric} />
        <StatChip
          icon={<Trophy size={16} aria-hidden="true" />}
          label={m.calendar.bestWeek}
          value={bestWeek ? bestWeek.label : "—"}
          hint={bestWeek ? `${bestWeek.hint} · ${bestWeek.value}%` : m.calendar.noActiveWeek}
        />
        <StatChip
          icon={<Activity size={16} aria-hidden="true" />}
          label={m.calendar.activeDays}
          value={`${activeDays}/${days.length}`}
          hint={m.calendar.tasksDone(stats.taskCount, stats.doneCount)}
        />
        <CoreFocusStat mix={mix} metric={metric} />
      </div>

      <div className="cal-card cal-rhythm">
        <div className="cal-card__head">
          <span className="cal-card__title">{m.calendar.completionByWeek}</span>
          <span className="cal-card__badge">{m.calendar.weeks(weekSeries.length)}</span>
        </div>
        <MiniBarSeries data={weekSeries} onSelect={onPickWeek} />
      </div>

      <div className="cal-insights__duo">
        <ProjectFocusCard focus={focus} metric={metric} noun="month" />
        <FocusMixCard mix={mix} metric={metric} />
      </div>

      <WorklogCard
        kind="output"
        title={m.calendar.monthlyOutput}
        icon={<FileText size={14} aria-hidden="true" />}
        entries={outputs}
        emptyHint={m.calendar.outputEmptyMonth}
        today={today}
        projectById={projectById}
        onOpenDay={onOpenDay}
      />
      {blockers.length > 0 ? (
        <WorklogCard
          kind="blocker"
          title={m.calendar.blockers}
          icon={<AlertTriangle size={14} aria-hidden="true" />}
          entries={blockers}
          today={today}
          projectById={projectById}
          onOpenDay={onOpenDay}
        />
      ) : null}
    </section>
  );
}

interface YearViewProps extends DayViewProps {
  anchor: string;
  days: string[];
  stats: PeriodStats;
  buckets: Map<string, Task[]>;
  projects: Project[];
  onPickMonth: (month: string) => void;
}

function YearView({ anchor, days, today, metric, stats, buckets, projects, dayStats, onOpenDay, onPickMonth }: YearViewProps) {
  const { m, lang } = useI18n();
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
        return { key: monthAnchor, label: monthShort(monthAnchor, lang), value: completionValue(stats, metric) };
      }),
    [buckets, metric, yearKey, lang]
  );

  const { streak, activeDays, bestMonth } = useMemo(() => {
    const streakEnd = endOfYear(anchor) > today ? today : endOfYear(anchor);
    const entries = eachDayInRange(startOfYear(anchor), streakEnd).map((date) => ({ date, stats: dayStats(date) }));
    const info = streakInfo(entries, (dayStat) => dayStat.taskCount > 0 && completionValue(dayStat, metric) >= COMPLETION_GOAL);
    const active = entries.filter((entry) => entry.stats.taskCount > 0).length;
    const best = monthSeries.reduce((winner, item) => (item.value > winner.value ? item : winner), monthSeries[0]);
    return { streak: info, activeDays: active, bestMonth: best };
  }, [anchor, today, metric, dayStats, monthSeries]);

  const prevDays = useMemo(() => {
    const prevYearStart = startOfYear(addYears(anchor, -1));
    return eachDayInRange(prevYearStart, endOfYear(prevYearStart));
  }, [anchor]);
  const prevStats = useMemo(() => statsForDays(buckets, prevDays), [buckets, prevDays]);
  const focus = useMemo(() => projectFocusForDays(buckets, days, projects, focusLabels(m)), [buckets, days, projects, m]);
  const mix = useMemo(() => importanceMixForDays(buckets, days), [buckets, days]);

  return (
    <section className="cal-year">
      <div className="cal-year__stats">
        <StatChip
          icon={<Flame size={16} aria-hidden="true" className="is-flame" />}
          label={m.calendar.currentStreak}
          value={m.calendar.streakDays(streak.current)}
          hint={m.calendar.daysAtGoal(COMPLETION_GOAL)}
        />
        <StatChip
          icon={<Award size={16} aria-hidden="true" />}
          label={m.calendar.longestStreak}
          value={m.calendar.streakDays(streak.longest)}
          hint={m.calendar.inYear(yearKey)}
        />
        <StatChip
          icon={<Activity size={16} aria-hidden="true" />}
          label={m.calendar.activeDays}
          value={activeDays}
          hint={m.calendar.tasksDone(stats.taskCount, stats.doneCount)}
        />
        <StatChip
          icon={<Trophy size={16} aria-hidden="true" />}
          label={m.calendar.bestMonth}
          value={bestMonth ? monthShort(bestMonth.key, lang) : "—"}
          hint={bestMonth && stats.taskCount > 0 ? m.calendar.metricValue(Math.round(bestMonth.value), metric) : m.calendar.noRecords}
        />
        <TrendStat noun="year" stats={stats} prevStats={prevStats} metric={metric} />
        <CoreFocusStat mix={mix} metric={metric} />
      </div>

      <div className="cal-heatmap" role="img" aria-label={m.calendar.heatmapAria(yearKey)}>
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
        <span className="cal-year__caption">{m.calendar.completionByMonth}</span>
        <MiniBarSeries data={monthSeries} onSelect={onPickMonth} />
      </div>

      {stats.taskCount > 0 ? (
        <div className="cal-insights__duo">
          <ProjectFocusCard focus={focus} metric={metric} noun="year" />
          <FocusMixCard mix={mix} metric={metric} />
        </div>
      ) : null}
    </section>
  );
}
