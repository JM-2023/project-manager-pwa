import { FileJson, HardDriveDownload } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getExportData, restoreData } from "../lib/api";
import { useI18n } from "../lib/i18n";

interface BackupControlsProps {
  // Re-pulls everything from the cloud after a restore so the local cache and
  // UI pick up the merged records.
  onRestored: () => void;
}

interface BackupShape {
  projects?: unknown;
  tasks?: unknown;
  nextProjects?: unknown;
  nextIdeas?: unknown;
}

function asArray(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

export function BackupControls({ onRestored }: BackupControlsProps) {
  const { m } = useI18n();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const operationControllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => {
    const controller = operationControllerRef.current;
    operationControllerRef.current = null;
    controller?.abort(new DOMException("Backup page closed", "AbortError"));
  }, []);

  function beginOperation(): AbortController {
    operationControllerRef.current?.abort(new DOMException("A newer backup operation started", "AbortError"));
    const controller = new AbortController();
    operationControllerRef.current = controller;
    setBusy(true);
    setMessage("");
    return controller;
  }

  function finishOperation(controller: AbortController): void {
    if (operationControllerRef.current !== controller) return;
    operationControllerRef.current = null;
    setBusy(false);
  }

  async function downloadBackup() {
    const controller = beginOperation();
    try {
      const data = await getExportData(controller.signal);
      if (controller.signal.aborted) return;
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `project-manager-backup-${data.exportedAt.replace(/[:.]/g, "-")}.json`;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
      setMessage(m.settings.backupDownloaded);
    } catch (error) {
      if (!controller.signal.aborted) {
        setMessage(error instanceof Error ? error.message : m.settings.backupFailed);
      }
    } finally {
      finishOperation(controller);
    }
  }

  async function restoreBackup(file: File | null) {
    if (!file) {
      return;
    }
    const controller = beginOperation();
    try {
      let parsed: BackupShape;
      try {
        const text = await file.text();
        if (controller.signal.aborted) return;
        parsed = JSON.parse(text) as BackupShape;
      } catch {
        throw new Error(m.settings.restoreInvalid);
      }
      const payload = {
        projects: asArray(parsed.projects),
        tasks: asArray(parsed.tasks),
        nextProjects: asArray(parsed.nextProjects),
        nextIdeas: asArray(parsed.nextIdeas)
      };
      const total = payload.projects.length + payload.tasks.length + payload.nextProjects.length + payload.nextIdeas.length;
      if (total === 0) {
        throw new Error(m.settings.restoreInvalid);
      }
      const confirmed = window.confirm(
        m.settings.restoreConfirm(payload.projects.length, payload.tasks.length, payload.nextProjects.length, payload.nextIdeas.length)
      );
      if (!confirmed) {
        return;
      }
      // The server ignores fields it doesn't know, so passing rows straight
      // through keeps the backup full-fidelity.
      const result = await restoreData(payload as never, controller.signal);
      if (controller.signal.aborted) return;
      setMessage(m.settings.restoreDone(result.projects, result.tasks, result.nextProjects, result.nextIdeas));
      onRestored();
    } catch (error) {
      if (!controller.signal.aborted) {
        setMessage(error instanceof Error ? error.message : m.settings.restoreFailed);
      }
    } finally {
      finishOperation(controller);
    }
  }

  return (
    <div className="export-actions">
      <button type="button" className="secondary-button" disabled={busy} onClick={downloadBackup}>
        <HardDriveDownload size={17} aria-hidden="true" />
        <span>{busy ? m.exporter.working : m.settings.downloadJson}</span>
      </button>
      <label className="file-picker">
        <FileJson size={18} aria-hidden="true" />
        <span>{busy ? m.settings.restoring : m.settings.restoreJson}</span>
        <input
          type="file"
          accept=".json,application/json"
          disabled={busy}
          onChange={(event) => {
            void restoreBackup(event.target.files?.[0] ?? null);
            event.target.value = "";
          }}
        />
      </label>
      {message ? <p className="inline-message">{message}</p> : null}
    </div>
  );
}
