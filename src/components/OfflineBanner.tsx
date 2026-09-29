import { CircleAlert, CloudOff, RefreshCcw, UploadCloud } from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
  /** Raw error text: often an English exception message, so it stays out of
   * the localized pill and only rides along as a tooltip. Settings shows it. */
  detail: string | undefined;
  Icon: typeof CloudOff;
  showSync: boolean;
  syncing: boolean;
}

// A healthy edit queues, pushes and settles in about a second. Announcing
// that on every commit made the pill blink in and out (with three different
// labels) after each edit, so routine traffic only surfaces once it has run
// this long. Offline and errors still show at once.
const SLOW_SYNC_MS = 2000;

/** True once `active` has held continuously for `ms`; false as soon as it drops. */
function useSustained(active: boolean, ms: number): boolean {
  const [sustained, setSustained] = useState(false);
  useEffect(() => {
    setSustained(false);
    if (!active) return;
    const timer = window.setTimeout(() => setSustained(true), ms);
    return () => window.clearTimeout(timer);
  }, [active, ms]);
  return active && sustained;
}

export function OfflineBanner({ online, pendingCount, syncStatus, error, onSync }: OfflineBannerProps) {
  const { m } = useI18n();
  const urgent = Boolean(error) || !online || syncStatus === "error";
  const slow = useSustained(pendingCount > 0 || syncStatus === "syncing", SLOW_SYNC_MS);
  const visible = urgent || slow;
  const presence = usePresence(visible, 320);
  // Freeze the last visible content for the exit animation — by the time the
  // pill leaves, the live props have already gone back to "all synced".
  const lastViewRef = useRef<BannerView | null>(null);

  if (visible) {
    const state = error ? "error" : online ? syncStatus : "offline";
    const message = error
      ? m.offline.syncIssue
      : !online
      ? pendingCount > 0
        ? m.offline.savedOffline(pendingCount)
        : m.offline.offline
      : syncStatus === "error"
        ? m.offline.syncIssue
        : syncStatus === "syncing"
          ? m.offline.syncing(pendingCount)
          : syncStatus === "queued"
            ? m.offline.queued(pendingCount)
            : m.offline.pending(pendingCount);
    const Icon = error
      ? CircleAlert
      : !online
      ? CloudOff
      : syncStatus === "error"
        ? CircleAlert
        : syncStatus === "syncing"
          ? RefreshCcw
          : UploadCloud;
    lastViewRef.current = { state, message, detail: error ?? undefined, Icon, showSync: online, syncing: syncStatus === "syncing" };
  }

  const view = lastViewRef.current;
  if (!presence.mounted || !view) {
    return null;
  }

  const { state, message, detail, Icon, showSync, syncing } = view;
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
      <span className="offline-banner__text" title={detail}>{message}</span>
      {showSync ? (
        <button type="button" onClick={onSync} disabled={syncing || presence.closing} aria-label={m.offline.syncNow}>
          <RefreshCcw size={16} aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}
