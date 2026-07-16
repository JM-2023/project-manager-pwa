import { authenticate, isResponse } from "./_utils/auth";
import { ensureSyncStateStatement } from "./_utils/db";
import { streamSnapshotResponse } from "./_utils/snapshotStream";
import { nowIso } from "./_utils/time";
import type { AppContext } from "./_utils/types";

interface SyncStateRow {
  epoch: string;
  seq: number;
}

export async function onRequestGet(context: AppContext): Promise<Response> {
  const user = await authenticate(context);
  if (isResponse(user)) return user;
  await ensureSyncStateStatement(context.env, user.id).run();

  const state = await context.env.DB.prepare("SELECT epoch, seq FROM sync_state WHERE user_id = ?")
    .bind(user.id)
    .first<SyncStateRow>() ?? { epoch: "", seq: 0 };
  const timestamp = nowIso();
  return streamSnapshotResponse({
    db: context.env.DB,
    userId: user.id,
    exportedAt: timestamp,
    serverTime: timestamp,
    syncEpoch: state.epoch,
    syncCursor: Number(state.seq),
    full: true,
    cursor: 0
  });
}
