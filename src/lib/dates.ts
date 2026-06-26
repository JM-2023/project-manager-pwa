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

export function formatShortDate(value?: string | null): string {
  const input = toDateInput(value);
  if (!input) {
    return "No date";
  }
  const [year, month, day] = input.split("-");
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
