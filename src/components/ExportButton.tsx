import { Download, UploadCloud } from "lucide-react";
import { useState } from "react";
import { getExportData, uploadCloudExcel } from "../lib/api";
import { visibleTasks } from "../lib/sync";

interface ExportButtonProps {
  r2Enabled: boolean;
  onExported: (timestamp: string) => void;
}

export function ExportButton({ r2Enabled, onExported }: ExportButtonProps) {
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
        setMessage("Export downloaded and uploaded.");
      } else {
        setMessage("Export downloaded.");
      }
      onExported(data.exportedAt);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Export failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="export-actions">
      <button type="button" className="primary-button" disabled={busy} onClick={() => exportExcel(false)}>
        <Download size={17} aria-hidden="true" />
        <span>{busy ? "Working" : "Export Excel"}</span>
      </button>
      {r2Enabled ? (
        <button type="button" className="secondary-button" disabled={busy} onClick={() => exportExcel(true)}>
          <UploadCloud size={17} aria-hidden="true" />
          <span>Export + R2</span>
        </button>
      ) : null}
      {message ? <p className="inline-message">{message}</p> : null}
    </div>
  );
}
