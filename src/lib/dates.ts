import type { Language } from "./i18n";

export function nowIso(): string {
  return new Date().toISOString();
}

export function todayDate(): string {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatDateInput(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function toDateInput(value?: string | null): string {
  if (!value) {
    return "";
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }
  return date.toISOString().slice(0, 10);
}

export function addDays(value: string, days: number): string {
  const input = toDateInput(value) || todayDate();
  const date = new Date(`${input}T00:00:00`);
  date.setDate(date.getDate() + days);
  return formatDateInput(date);
}

export function formatShortDate(value?: string | null, lang: Language = "en"): string {
  const input = toDateInput(value);
  if (!input) {
    return lang === "zh" ? "无日期" : "No date";
  }
  const [year, month, day] = input.split("-");
  if (lang === "zh") {
    return `${year}/${Number(month)}/${Number(day)}`;
  }
  return `${month}/${day}/${year.slice(2)}`;
}

export function isDueTodayOrEarlier(value?: string | null): boolean {
  const input = toDateInput(value);
  return Boolean(input && input <= todayDate());
}

export function daysFromToday(value?: string | null): number | null {
  const input = toDateInput(value);
  if (!input) {
    return null;
  }
  const target = new Date(`${input}T00:00:00`);
  const today = new Date(`${todayDate()}T00:00:00`);
  return Math.round((target.getTime() - today.getTime()) / 86_400_000);
}

export function parseLooseDate(value: unknown): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    const excelEpoch = new Date(Date.UTC(1899, 11, 30));
    const date = new Date(excelEpoch.getTime() + value * 86_400_000);
    return date.toISOString().slice(0, 10);
  }

  const text = String(value).trim();
  if (!text) {
    return null;
  }
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(text)) {
    const [year, month, day] = text.split("-");
    return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  }
  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed.toISOString().slice(0, 10);
}

/* =========================================================================
   Calendar helpers (week / month / year aggregation)
   ========================================================================= */

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const WEEKDAY_NAMES_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December"
];
const MONTH_ABBR = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface MonthGridDay {
  date: string;
  inMonth: boolean;
}

/** Monday-based start of the week containing `value`. */
export function startOfWeek(value: string, weekStartsOn = 1): string {
  const input = toDateInput(value) || todayDate();
  const date = new Date(`${input}T00:00:00`);
  const diff = (date.getDay() - weekStartsOn + 7) % 7;
  date.setDate(date.getDate() - diff);
  return formatDateInput(date);
}

export function endOfWeek(value: string, weekStartsOn = 1): string {
  return addDays(startOfWeek(value, weekStartsOn), 6);
}

export function startOfMonth(value: string): string {
  const input = toDateInput(value) || todayDate();
  return `${input.slice(0, 7)}-01`;
}

export function endOfMonth(value: string): string {
  const input = toDateInput(value) || todayDate();
  const [year, month] = input.split("-").map(Number);
  return formatDateInput(new Date(year, month, 0));
}

export function startOfYear(value: string): string {
  const input = toDateInput(value) || todayDate();
  return `${input.slice(0, 4)}-01-01`;
}

export function endOfYear(value: string): string {
  const input = toDateInput(value) || todayDate();
  return `${input.slice(0, 4)}-12-31`;
}

export function addMonths(value: string, months: number): string {
  const input = toDateInput(value) || todayDate();
  const [year, month, day] = input.split("-").map(Number);
  const date = new Date(year, month - 1 + months, 1);
  const lastDay = new Date(date.getFullYear(), date.getMonth() + 1, 0).getDate();
  date.setDate(Math.min(day, lastDay));
  return formatDateInput(date);
}

export function addYears(value: string, years: number): string {
  return addMonths(value, years * 12);
}

export function eachDayInRange(start: string, end: string): string[] {
  const days: string[] = [];
  let cursor = toDateInput(start);
  const last = toDateInput(end);
  if (!cursor || !last) {
    return days;
  }
  let guard = 0;
  while (cursor <= last && guard < 1000) {
    days.push(cursor);
    cursor = addDays(cursor, 1);
    guard += 1;
  }
  return days;
}

/** Six-week (or fewer) calendar grid, padded with leading/trailing days flagged via `inMonth`. */
export function monthGridWeeks(value: string, weekStartsOn = 1): MonthGridDay[][] {
  const monthKey = startOfMonth(value).slice(0, 7);
  const gridStart = startOfWeek(startOfMonth(value), weekStartsOn);
  const gridEnd = endOfWeek(endOfMonth(value), weekStartsOn);
  const days = eachDayInRange(gridStart, gridEnd).map((date) => ({ date, inMonth: date.slice(0, 7) === monthKey }));
  const weeks: MonthGridDay[][] = [];
  for (let i = 0; i < days.length; i += 7) {
    weeks.push(days.slice(i, i + 7));
  }
  return weeks;
}

export function weekdayLabels(weekStartsOn = 1, lang: Language = "en"): string[] {
  const names = lang === "zh" ? WEEKDAY_NAMES_ZH : WEEKDAY_NAMES;
  return Array.from({ length: 7 }, (_, index) => names[(weekStartsOn + index) % 7]);
}

/** "Tue" / "周二" style weekday of a specific date. */
export function weekdayShort(value: string, lang: Language = "en"): string {
  const input = toDateInput(value) || todayDate();
  const names = lang === "zh" ? WEEKDAY_NAMES_ZH : WEEKDAY_NAMES;
  return names[new Date(`${input}T00:00:00`).getDay()];
}

const WEEKDAY_NAMES_LONG = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "Wednesday" / "周三" style weekday, used as the Today page title off-today. */
export function weekdayLong(value: string, lang: Language = "en"): string {
  const input = toDateInput(value) || todayDate();
  const day = new Date(`${input}T00:00:00`).getDay();
  return lang === "zh" ? WEEKDAY_NAMES_ZH[day] : WEEKDAY_NAMES_LONG[day];
}

export function monthLabel(value: string, lang: Language = "en"): string {
  const input = toDateInput(value) || todayDate();
  const [year, month] = input.split("-").map(Number);
  if (lang === "zh") {
    return `${year}年${month}月`;
  }
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

export function monthShort(value: string, lang: Language = "en"): string {
  const input = toDateInput(value) || todayDate();
  const month = Number(input.split("-")[1]);
  return lang === "zh" ? `${month}月` : MONTH_ABBR[month - 1];
}

export function yearOf(value: string): string {
  return (toDateInput(value) || todayDate()).slice(0, 4);
}

/** Short "Jun 23" / "6月23日" style label, used in range headers. */
export function formatMonthDay(value: string, lang: Language = "en"): string {
  const input = toDateInput(value);
  if (!input) {
    return "";
  }
  const [, month, day] = input.split("-").map(Number);
  return lang === "zh" ? `${month}月${day}日` : `${MONTH_ABBR[month - 1]} ${day}`;
}
