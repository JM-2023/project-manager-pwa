import { CircleAlert, CloudOff, RefreshCcw, UploadCloud } from "lucide-react";
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

  const state = online ? syncStatus : "offline";
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

  const Icon = !online
    ? CloudOff
    : syncStatus === "error"
      ? CircleAlert
      : syncStatus === "syncing"
        ? RefreshCcw
        : UploadCloud;

  return (
    <div className={`offline-banner ${state}`} role="status" aria-live="polite">
      <span className="offline-banner__icon">
        <Icon size={16} aria-hidden="true" />
      </span>
      <span className="offline-banner__text">{message}</span>
      {online ? (
        <button type="button" onClick={onSync} disabled={syncStatus === "syncing"} aria-label="Sync now">
          <RefreshCcw size={16} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
