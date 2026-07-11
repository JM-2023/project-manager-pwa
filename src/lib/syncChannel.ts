const CHANNEL_NAME = "project-manager-sync-v1";
const LOCAL_DATA_LOCK = "project-manager-local-data-v1";
const POLL_LOCK = "project-manager-background-poll-v1";
const STORAGE_KEY = "project-manager-sync-hint";
const LOGOUT_BARRIER_KEY = "project-manager-logout-barrier";
const LAST_POLL_KEY = "project-manager-last-background-poll";
const LOGOUT_BARRIER_STALE_MS = 60_000;

export type SyncMessageType = "sync-hint" | "logout-start" | "logout-cancel" | "logout-complete";

export interface SyncMessage {
  type: SyncMessageType;
  source: string;
  at: number;
}

export interface SyncChannelHandlers {
  onSyncHint: () => void;
  onLogoutStart?: () => void;
  onLogoutCancel?: () => void;
  onLogoutComplete?: () => void;
}

let channel: BroadcastChannel | null = null;
let memoryLogoutBarrier = false;
let memoryLogoutBarrierAt: number | null = null;

function sharedChannel(): BroadcastChannel | null {
  if (typeof BroadcastChannel === "undefined") return null;
  channel ??= new BroadcastChannel(CHANNEL_NAME);
  return channel;
}

function publish(message: SyncMessage): void {
  const broadcast = sharedChannel();
  if (broadcast) {
    broadcast.postMessage(message);
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(message));
  } catch {
    // Storage can be disabled in private browsing; BroadcastChannel still works.
  }
}

/** Wake other open tabs after an outbox entry is durable. */
export function publishSyncHint(source: string): void {
  publish({ type: "sync-hint", source, at: Date.now() });
}

export function beginLogoutBarrier(source: string): void {
  const at = Date.now();
  memoryLogoutBarrier = true;
  memoryLogoutBarrierAt = at;
  try {
    localStorage.setItem(LOGOUT_BARRIER_KEY, String(at));
  } catch {
    // The in-memory flag still protects this tab; the channel pauses peers.
  }
  publish({ type: "logout-start", source, at });
}

export function finishLogoutBarrier(source: string, completed: boolean): void {
  if (!completed) {
    memoryLogoutBarrier = false;
    memoryLogoutBarrierAt = null;
  }
  if (!completed) {
    try {
      localStorage.removeItem(LOGOUT_BARRIER_KEY);
    } catch {
      // Ignore: peers also receive the explicit cancellation message.
    }
  }
  publish({ type: completed ? "logout-complete" : "logout-cancel", source, at: Date.now() });
}

/** A successful login is the only operation that releases a completed logout barrier. */
export function releaseLogoutBarrier(source: string): void {
  memoryLogoutBarrier = false;
  memoryLogoutBarrierAt = null;
  try {
    localStorage.removeItem(LOGOUT_BARRIER_KEY);
  } catch {
    // The current tab can still resume from the in-memory flag.
  }
  publish({ type: "logout-cancel", source, at: Date.now() });
}

export function isLogoutBarrierActive(): boolean {
  if (memoryLogoutBarrier) return true;
  try {
    return Boolean(localStorage.getItem(LOGOUT_BARRIER_KEY));
  } catch {
    return false;
  }
}

function logoutBarrierStartedAt(): number | null {
  if (memoryLogoutBarrierAt !== null) return memoryLogoutBarrierAt;
  try {
    const value = Number(localStorage.getItem(LOGOUT_BARRIER_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return memoryLogoutBarrier ? Date.now() : null;
  }
}

/** Time before a newly opened tab may validate and recover an abandoned start marker. */
export function logoutBarrierRetryDelay(now = Date.now()): number {
  const startedAt = logoutBarrierStartedAt();
  if (startedAt === null) return 0;
  return Math.max(0, startedAt + LOGOUT_BARRIER_STALE_MS - now);
}

export function isLogoutBarrierStale(now = Date.now()): boolean {
  return isLogoutBarrierActive() && logoutBarrierRetryDelay(now) === 0;
}

export function subscribeToSyncEvents(source: string, handlers: SyncChannelHandlers): () => void {
  const broadcast = sharedChannel();
  const deliver = (message: SyncMessage) => {
    if (!message || message.source === source) return;
    if (message.type === "sync-hint") handlers.onSyncHint();
    else if (message.type === "logout-start") handlers.onLogoutStart?.();
    else if (message.type === "logout-cancel") handlers.onLogoutCancel?.();
    else if (message.type === "logout-complete") handlers.onLogoutComplete?.();
  };
  const onMessage = (event: MessageEvent<SyncMessage>) => deliver(event.data);
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY || !event.newValue) return;
    try {
      deliver(JSON.parse(event.newValue) as SyncMessage);
    } catch {
      handlers.onSyncHint();
    }
  };
  broadcast?.addEventListener("message", onMessage);
  window.addEventListener("storage", onStorage);
  return () => {
    broadcast?.removeEventListener("message", onMessage);
    window.removeEventListener("storage", onStorage);
  };
}

async function withNamedLease<T>(name: string, work: () => Promise<T>): Promise<T> {
  const locks = navigator.locks;
  if (!locks) return work();
  return locks.request(name, { mode: "exclusive" }, work);
}

/** Serialize network reconciliation across tabs sharing the same IndexedDB. */
export function withSyncLease<T>(work: () => Promise<T>): Promise<T> {
  return withNamedLease(CHANNEL_NAME, work);
}

/** Serialize optimistic commits against logout/reset of the shared local database. */
export function withLocalDataLease<T>(work: () => Promise<T>): Promise<T> {
  return withNamedLease(LOCAL_DATA_LOCK, work);
}

/** Coalesce the visible-window 30-second poll across tabs/windows. */
export function claimBackgroundPoll(source: string, minimumGapMs = 25_000): Promise<boolean> {
  return withNamedLease(POLL_LOCK, async () => {
    const now = Date.now();
    try {
      const previous = Number(localStorage.getItem(LAST_POLL_KEY) ?? "0");
      if (Number.isFinite(previous) && now - previous < minimumGapMs) return false;
      localStorage.setItem(LAST_POLL_KEY, JSON.stringify(now));
    } catch {
      // Without storage, allow the visible tab to poll.
    }
    void source;
    return true;
  });
}
