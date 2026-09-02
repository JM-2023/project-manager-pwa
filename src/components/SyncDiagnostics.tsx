import type { LucideIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore } from "react";
import {
  clearSyncTrace,
  formatSyncTrace,
  formatTraceTime,
  readSyncTrace,
  subscribeSyncTrace,
  syncEnvironmentSummary
} from "../lib/syncTrace";

interface SyncDiagnosticsProps {
  emptyLabel: string;
  copyLabel: string;
  copiedLabel: string;
  clearLabel: string;
  CopyIcon: LucideIcon;
  ClearIcon: LucideIcon;
}

const VISIBLE_ENTRIES = 60;

export function SyncDiagnostics({ emptyLabel, copyLabel, copiedLabel, clearLabel, CopyIcon, ClearIcon }: SyncDiagnosticsProps) {
  const entries = useSyncExternalStore(subscribeSyncTrace, readSyncTrace, readSyncTrace);
  const [copied, setCopied] = useState(false);
  const environment = syncEnvironmentSummary();

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  async function copyLog() {
    const text = [...environment, "", formatSyncTrace(entries)].join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Clipboard access can be refused; the log stays on screen for a screenshot.
    }
  }

  // Newest first: on a phone the interesting line is the last thing that
  // happened, and it should be visible without scrolling.
  const recent = entries.slice(-VISIBLE_ENTRIES).reverse();

  return (
    <div className="settings-trace">
      <pre className="settings-trace__env">{environment.join("\n")}</pre>
      <pre className="settings-trace__log" aria-live="off">
        {recent.length === 0
          ? emptyLabel
          : recent.map((entry, index) => (
              <span key={`${entry.at}-${index}`}>
                {formatTraceTime(entry.at)} <strong>{entry.step}</strong>
                {entry.detail ? ` — ${entry.detail}` : ""}
                {"\n"}
              </span>
            ))}
      </pre>
      <div className="settings-trace__actions">
        <button type="button" className="secondary-button" onClick={() => void copyLog()}>
          <CopyIcon size={16} aria-hidden="true" />
          <span>{copied ? copiedLabel : copyLabel}</span>
        </button>
        <button type="button" className="ghost-button" onClick={clearSyncTrace}>
          <ClearIcon size={16} aria-hidden="true" />
          <span>{clearLabel}</span>
        </button>
      </div>
    </div>
  );
}
