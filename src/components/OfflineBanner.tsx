import { CircleAlert, CloudOff, RefreshCcw, UploadCloud } from "lucide-react";
import { useRef } from "react";
import { useI18n } from "../lib/i18n";
import { usePresence } from "../lib/usePresence";
import type { SyncStatus } from "../state/appStore";

interface OfflineBannerProps {
  online: boolean;
  pendingCount: number;
  syncStatus: SyncStatus;
  error: string | null;
  onSync: () => void;
}

interface BannerView {
  state: string;
  message: string;
  Icon: typeof CloudOff;
  showSync: boolean;
  syncing: boolean;
}

export function OfflineBanner({ online, pendingCount, syncStatus, error, onSync }: OfflineBannerProps) {
  const { m } = useI18n();
  const visible = !online || pendingCount > 0 || syncStatus === "syncing" || syncStatus === "error";
  const presence = usePresence(visible, 320);
  // Freeze the last visible content for the exit animation — by the time the
  // pill leaves, the live props have already gone back to "all synced".
  const lastViewRef = useRef<BannerView | null>(null);

  if (visible) {
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
    lastViewRef.current = { state, message, Icon, showSync: online, syncing: syncStatus === "syncing" };
  }

  const view = lastViewRef.current;
  if (!presence.mounted || !view) {
    return null;
  }

  const { state, message, Icon, showSync, syncing } = view;
  return (
    <div
      className={`offline-banner ${state}${presence.closing ? " is-leaving" : ""}`}
      role="status"
      aria-live="polite"
      onAnimationEnd={(event) => {
        if (presence.closing && event.target === event.currentTarget) presence.onExited();
      }}
    >
      <span className="offline-banner__icon">
        <Icon size={16} aria-hidden="true" />
      </span>
      <span className="offline-banner__text">{message}</span>
      {showSync ? (
        <button type="button" onClick={onSync} disabled={syncing || presence.closing} aria-label={m.offline.syncNow}>
          <RefreshCcw size={16} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
