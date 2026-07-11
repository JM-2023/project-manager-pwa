import { Download, UploadCloud } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { getExportData, uploadCloudExcel } from "../lib/api";
import { buildWorkbookBlobInWorker, WorkbookWorkerUnavailableError } from "../lib/excelWorkbookClient";
import { useI18n } from "../lib/i18n";
import { visibleTasks } from "../lib/sync";

interface ExportButtonProps {
  r2Enabled: boolean;
  onExported: (timestamp: string) => void;
}

async function buildExportBlob(data: Awaited<ReturnType<typeof getExportData>>, signal: AbortSignal): Promise<Blob> {
  try {
    return await buildWorkbookBlobInWorker(data, signal);
  } catch (error) {
    if (signal.aborted) throw error;
    if (!(error instanceof WorkbookWorkerUnavailableError)) throw error;
    // Workers can be unavailable under restrictive browser policies. Keep a
    // main-thread fallback, while still building exactly one workbook.
    const { workbookBlob } = await import("../lib/excelExport");
    if (signal.aborted) throw signal.reason ?? new DOMException("Excel export aborted", "AbortError");
    const blob = workbookBlob(data);
    if (signal.aborted) throw signal.reason ?? new DOMException("Excel export aborted", "AbortError");
    return blob;
  }
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.appendChild(link);
  link.click();
  link.remove();
  // WebKit may begin consuming an object URL after click() returns.
  window.setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

export function ExportButton({ r2Enabled, onExported }: ExportButtonProps) {
  const { m } = useI18n();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const exportControllerRef = useRef<AbortController | null>(null);

  useEffect(() => () => {
    const controller = exportControllerRef.current;
    exportControllerRef.current = null;
    controller?.abort(new DOMException("Export page closed", "AbortError"));
  }, []);

  async function exportExcel(uploadToR2: boolean) {
    exportControllerRef.current?.abort(new DOMException("A newer export started", "AbortError"));
    const controller = new AbortController();
    exportControllerRef.current = controller;
    setBusy(true);
    setMessage("");
    try {
      const data = await getExportData(controller.signal);
      const blob = await buildExportBlob(data, controller.signal);
      if (controller.signal.aborted) return;
      const stamp = data.exportedAt.replace(/[:.]/g, "-");
      const filename = `project-manager-${stamp}.xlsx`;
      downloadBlob(blob, filename);
      if (uploadToR2) {
        await uploadCloudExcel(
          blob,
          "project-manager-latest.xlsx",
          visibleTasks(data.tasks).length,
          data.syncEpoch,
          data.syncCursor,
          controller.signal
        );
        if (controller.signal.aborted) return;
        setMessage(m.exporter.downloadedUploaded);
      } else {
        setMessage(m.exporter.downloaded);
      }
      onExported(data.exportedAt);
    } catch (error) {
      if (!controller.signal.aborted) {
        setMessage(error instanceof Error ? error.message : m.exporter.exportFailed);
      }
    } finally {
      if (exportControllerRef.current === controller) {
        exportControllerRef.current = null;
        setBusy(false);
      }
    }
  }

  // Fragment children of the Settings page's shared .export-actions row, so
  // the export buttons sit beside the import picker with the standard gap.
  return (
    <>
      <button type="button" className="primary-button" disabled={busy} onClick={() => exportExcel(false)}>
        <Download size={17} aria-hidden="true" />
        <span>{busy ? m.exporter.working : m.exporter.export}</span>
      </button>
      {r2Enabled ? (
        <button type="button" className="secondary-button" disabled={busy} onClick={() => exportExcel(true)}>
          <UploadCloud size={17} aria-hidden="true" />
          <span>{m.exporter.exportR2}</span>
        </button>
      ) : null}
      {message ? <p className="inline-message">{message}</p> : null}
    </>
  );
}
