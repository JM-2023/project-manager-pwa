import { CircleAlert, CloudOff, RefreshCcw, UploadCloud } from "lucide-react";
import { useI18n } from "../lib/i18n";
import type { SyncStatus } from "../state/appStore";

interface OfflineBannerProps {
  online: boolean;
  pendingCount: number;
  syncStatus: SyncStatus;
  error: string | null;
  onSync: () => void;
}

export function OfflineBanner({ online, pendingCount, syncStatus, error, onSync }: OfflineBannerProps) {
  const { m } = useI18n();
  const visible = !online || pendingCount > 0 || syncStatus === "syncing" || syncStatus === "error";
  if (!visible) {
    return null;
  }

  const state = online ? syncStatus : "offline";
  const message = !online
    ? pendingCount > 0
      ? m.offline.savedOffline(pendingCount)
      : m.offline.offline
    : syncStatus === "error"
      ? m.offline.syncIssue(error)
      : syncStatus === "syncing"
        ? m.offline.syncing(pendingCount)
        : syncStatus === "queued"
          ? m.offline.queued(pendingCount)
          : m.offline.pending(pendingCount);

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
        <button type="button" onClick={onSync} disabled={syncStatus === "syncing"} aria-label={m.offline.syncNow}>
          <RefreshCcw size={16} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
