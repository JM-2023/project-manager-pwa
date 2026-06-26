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
  if (online && pendingCount === 0 && syncStatus !== "error") {
    return null;
  }

  return (
    <div className={`offline-banner ${online ? "" : "offline"}`}>
      <div>
        <CloudOff size={17} aria-hidden="true" />
        <span>
          {online ? `${pendingCount} pending change${pendingCount === 1 ? "" : "s"}` : "Offline changes pending"}
          {error ? `: ${error}` : ""}
        </span>
      </div>
      {online ? (
        <button type="button" onClick={onSync} aria-label="Sync now">
          <RefreshCcw size={16} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
