/**
 * In-memory trace of the sync pipeline: every trigger, local commit, lease
 * wait, IndexedDB hiccup and sync cycle step lands here with a timestamp. The
 * Settings page renders it so a device that cannot be attached to a debugger
 * (an iPhone) can still show where syncing stalls. Nothing here is persisted
 * and no record contents are traced, only step names, counts and errors.
 */
export interface SyncTraceEntry {
  at: number;
  step: string;
  detail?: string;
}

const MAX_ENTRIES = 160;

let entries: SyncTraceEntry[] = [];
const listeners = new Set<() => void>();
let globalTraceInstalled = false;

export function trace(step: string, detail?: string): void {
  const entry: SyncTraceEntry = detail === undefined ? { at: Date.now(), step } : { at: Date.now(), step, detail };
  entries = entries.length >= MAX_ENTRIES ? [...entries.slice(entries.length - MAX_ENTRIES + 1), entry] : [...entries, entry];
  for (const listener of listeners) listener();
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return `${error.name}: ${error.message}`;
  if (typeof error === "object" && error !== null) {
    const named = error as { name?: unknown; message?: unknown };
    if (typeof named.message === "string") return `${String(named.name ?? "Error")}: ${named.message}`;
  }
  return String(error);
}

/** Snapshot for useSyncExternalStore; a new array identity per trace call. */
export function readSyncTrace(): SyncTraceEntry[] {
  return entries;
}

export function subscribeSyncTrace(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function clearSyncTrace(): void {
  entries = [];
  for (const listener of listeners) listener();
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

export function formatTraceTime(at: number): string {
  const date = new Date(at);
  return `${pad(date.getHours(), 2)}:${pad(date.getMinutes(), 2)}:${pad(date.getSeconds(), 2)}.${pad(date.getMilliseconds(), 3)}`;
}

export function formatSyncTrace(list: SyncTraceEntry[]): string {
  return list.map((entry) => `${formatTraceTime(entry.at)} ${entry.step}${entry.detail ? ` — ${entry.detail}` : ""}`).join("\n");
}

/** Facts about the runtime that decide which sync code paths are taken. */
export function syncEnvironmentSummary(): string[] {
  if (typeof navigator === "undefined") return [];
  const nav = navigator as Navigator & { standalone?: boolean; locks?: unknown };
  const lines = [
    `ua: ${nav.userAgent}`,
    `online: ${nav.onLine} · visibility: ${typeof document === "undefined" ? "n/a" : document.visibilityState}`,
    `webLocks: ${nav.locks ? "yes" : "no"} · indexedDB: ${typeof indexedDB === "undefined" ? "no" : "yes"} · standalone: ${nav.standalone === true}`,
    `serviceWorker: ${nav.serviceWorker ? (nav.serviceWorker.controller ? "controlling" : "registered/none") : "unsupported"}`
  ];
  return lines;
}

/** Record uncaught errors and rejections, which otherwise vanish on a phone. */
export function installGlobalTrace(): void {
  if (globalTraceInstalled || typeof window === "undefined") return;
  globalTraceInstalled = true;
  window.addEventListener("error", (event) => {
    trace("uncaught error", event.message || describeError(event.error));
  });
  window.addEventListener("unhandledrejection", (event) => {
    trace("unhandled rejection", describeError(event.reason));
  });
  trace("page loaded");
}
