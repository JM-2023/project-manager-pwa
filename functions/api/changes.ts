import { authenticate, isResponse } from "./_utils/auth";
import { ensureSyncStateStatement } from "./_utils/db";
import { json } from "./_utils/response";
import { nowIso } from "./_utils/time";
import type { AppContext } from "./_utils/types";

interface SyncStateRow {
  epoch: string;
  seq: number;
}

/** Longest a single wait is held open; the client immediately opens the next one. */
export const MAX_WAIT_MS = 25_000;
/** How often a held wait re-reads the one-row sync state. */
export const CHECK_INTERVAL_MS = 2_000;

function parseCursor(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseWaitMs(value: string | null): number {
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return MAX_WAIT_MS;
  return Math.min(MAX_WAIT_MS, Math.round(seconds * 1000));
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    function onAbort() {
      clearTimeout(timer);
      resolve();
    }
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Long-poll for cloud changes. Answers as soon as the user's sync cursor
 * differs from the one the client holds (another device wrote, or the
 * dataset was replaced), otherwise after `wait` seconds with changed=false.
 * Holding the request costs one single-row read every CHECK_INTERVAL_MS;
 * the client then runs its normal incremental bootstrap only when needed.
 */
export async function onRequestGet(context: AppContext): Promise<Response> {
  const user = await authenticate(context);
  if (isResponse(user)) return user;

  await ensureSyncStateStatement(context.env, user.id).run();

  const url = new URL(context.request.url);
  const requestedEpoch = url.searchParams.get("epoch")?.trim() || null;
  const requestedCursor = parseCursor(url.searchParams.get("cursor"));
  const deadline = Date.now() + parseWaitMs(url.searchParams.get("wait"));
  const signal = context.request.signal;

  for (;;) {
    const state = await context.env.DB.prepare("SELECT epoch, seq FROM sync_state WHERE user_id = ?")
      .bind(user.id)
      .first<SyncStateRow>();
    if (!state) {
      throw new Error("Synchronization state is missing");
    }
    const cursor = Number(state.seq);
    // A client without a cursor, on another epoch, or ahead of the server
    // (rolled back dataset) needs a pull just as much as one that is behind.
    const changed =
      requestedEpoch === null || requestedCursor === null || state.epoch !== requestedEpoch || cursor !== requestedCursor;
    const remaining = deadline - Date.now();
    if (changed || remaining <= 0 || signal?.aborted) {
      return json({ changed, epoch: state.epoch, cursor, serverTime: nowIso() });
    }
    await sleep(Math.min(CHECK_INTERVAL_MS, remaining), signal);
  }
}
