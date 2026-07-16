import { authenticate, isResponse } from "./_utils/auth";
import { ensureSyncStateStatement } from "./_utils/db";
import { streamSnapshotResponse } from "./_utils/snapshotStream";
import { nowIso } from "./_utils/time";
import type { AppContext } from "./_utils/types";

interface SyncStateRow {
  epoch: string;
  seq: number;
}

function parseCursor(value: string | null): number | null {
  if (value === null || value.trim() === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export async function onRequestGet(context: AppContext): Promise<Response> {
  const user = await authenticate(context);
  if (isResponse(user)) return user;

  await ensureSyncStateStatement(context.env, user.id).run();

  const url = new URL(context.request.url);
  const requestedEpoch = url.searchParams.get("epoch")?.trim() || null;
  const requestedCursor = parseCursor(url.searchParams.get("cursor"));
  let full = !requestedEpoch || requestedCursor === null;
  const state = await context.env.DB.prepare("SELECT epoch, seq FROM sync_state WHERE user_id = ?")
    .bind(user.id)
    .first<SyncStateRow>();
  if (!state) {
    throw new Error("Synchronization state is missing");
  }

  // An epoch mismatch means that the server dataset was replaced or rolled
  // back. A cursor ahead of the server has the same recovery requirement.
  if (!full && (state.epoch !== requestedEpoch || requestedCursor! > Number(state.seq))) {
    full = true;
  }

  // Capture the cursor before any page is read. A write that races with the
  // stream is then replayed by the next incremental sync instead of being
  // hidden behind a cursor captured after that write.
  return streamSnapshotResponse({
    db: context.env.DB,
    userId: user.id,
    serverTime: nowIso(),
    syncEpoch: state.epoch,
    syncCursor: Number(state.seq),
    full,
    cursor: requestedCursor ?? 0
  });
}
