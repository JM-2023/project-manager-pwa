import { CloudOff, RefreshCcw } from "lucide-react";
import type { SyncStatus } from "../state/appStore";

interface OfflineBannerProps {
  online: boolean;
  pendingCount: number;
  syncStatus: SyncStatus;
  error: string | null;
  onSync: () => void;
}

export function OfflineBanner({ online, pendingCount, syncStatus, error, onSync }: OfflineBannerProps) {
  const visible = !online || pendingCount > 0 || syncStatus === "syncing" || syncStatus === "error";
  if (!visible) {
    return null;
  }

  const countText = `${pendingCount} change${pendingCount === 1 ? "" : "s"}`;
  const message = !online
    ? pendingCount > 0
      ? `${countText} saved offline`
      : "Offline"
    : syncStatus === "error"
      ? error
        ? `Sync issue: ${error}`
        : "Sync issue"
      : syncStatus === "syncing"
        ? pendingCount > 0
          ? `Syncing ${countText}`
          : "Syncing"
        : syncStatus === "queued"
          ? `${countText} queued`
          : `${countText} pending`;

  return (
    <div className={`offline-banner ${online ? syncStatus : "offline"}`} role="status" aria-live="polite">
      <div>
        <CloudOff size={17} aria-hidden="true" />
        <span>{message}</span>
      </div>
      {online ? (
        <button type="button" onClick={onSync} disabled={syncStatus === "syncing"} aria-label="Sync now">
          <RefreshCcw size={16} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
