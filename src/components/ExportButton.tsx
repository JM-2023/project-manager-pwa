import { Download, UploadCloud } from "lucide-react";
import { useState } from "react";
import { getExportData, uploadCloudExcel } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { visibleTasks } from "../lib/sync";

interface ExportButtonProps {
  r2Enabled: boolean;
  onExported: (timestamp: string) => void;
}

export function ExportButton({ r2Enabled, onExported }: ExportButtonProps) {
  const { m } = useI18n();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function exportExcel(uploadToR2: boolean) {
    setBusy(true);
    setMessage("");
    try {
      const { downloadExport, workbookBlob } = await import("../lib/excelExport");
      const data = await getExportData();
      const filename = downloadExport(data);
      if (uploadToR2) {
        const blob = workbookBlob(data);
        await uploadCloudExcel(blob, "project-manager-latest.xlsx", visibleTasks(data.tasks).length);
        setMessage(m.exporter.downloadedUploaded);
      } else {
        setMessage(m.exporter.downloaded);
      }
      onExported(data.exportedAt);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : m.exporter.exportFailed);
    } finally {
      setBusy(false);
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
