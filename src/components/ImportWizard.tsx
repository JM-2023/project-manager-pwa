import { FileSpreadsheet, Upload } from "lucide-react";
import { useMemo, useState } from "react";
import {
  defaultMapping,
  normalizeImportRows,
  type ColumnMapping,
  type ImportField,
  type ParsedSheet
} from "../lib/excelMapping";
import type { ImportResponse, ImportRow } from "../lib/types";

interface ImportWizardProps {
  onImport: (filename: string, rows: ImportRow[]) => Promise<ImportResponse>;
}

const fieldOptions: Array<{ value: ImportField; label: string }> = [
  { value: "skip", label: "Skip" },
  { value: "id", label: "ID" },
  { value: "external_key", label: "External key" },
  { value: "project", label: "Project" },
  { value: "title", label: "Title" },
  { value: "status", label: "Status" },
  { value: "priority", label: "Priority" },
  { value: "due_date", label: "Due date" },
  { value: "start_date", label: "Start date" },
  { value: "next_action", label: "Next action" },
  { value: "notes", label: "Notes" },
  { value: "description", label: "Description" },
  { value: "tags", label: "Tags" },
  { value: "progress", label: "Progress" },
  { value: "blocker", label: "Blocker" },
  { value: "output", label: "Output" }
];

export function ImportWizard({ onImport }: ImportWizardProps) {
  const [filename, setFilename] = useState("");
  const [sheets, setSheets] = useState<ParsedSheet[]>([]);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [mapping, setMapping] = useState<ColumnMapping>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  const selectedSheet = sheets[sheetIndex];
  const rows = useMemo(() => (selectedSheet ? normalizeImportRows(selectedSheet, mapping) : []), [mapping, selectedSheet]);

  async function loadFile(file: File | null) {
    if (!file) {
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const { parseWorkbook } = await import("../lib/excelImport");
      const parsed = await parseWorkbook(file);
      if (parsed.length === 0) {
        throw new Error("Workbook does not contain any worksheets.");
      }
      const scoredSheets = parsed.map((sheet) => {
        const nextMapping = defaultMapping(sheet.headers);
        return { mapping: nextMapping, rowCount: normalizeImportRows(sheet, nextMapping).length };
      });
      const bestSheetIndex = scoredSheets.reduce((bestIndex, sheet, index) => (sheet.rowCount > scoredSheets[bestIndex].rowCount ? index : bestIndex), 0);
      setFilename(file.name);
      setSheets(parsed);
      setSheetIndex(bestSheetIndex);
      setMapping(scoredSheets[bestSheetIndex]?.mapping ?? {});
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not read workbook");
    } finally {
      setBusy(false);
    }
  }

  function selectSheet(index: number) {
    const sheet = sheets[index];
    setSheetIndex(index);
    setMapping(defaultMapping(sheet.headers));
  }

  async function confirmImport() {
    if (!rows.length) {
      setMessage("No mapped task rows found.");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const result = await onImport(filename, rows);
      setMessage(`Imported ${rows.length} rows. Created ${result.created}, updated ${result.updated}, skipped ${result.skipped}.`);
      setSheets([]);
      setFilename("");
      setMapping({});
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Import failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="import-wizard">
      <label className="file-picker">
        <FileSpreadsheet size={18} aria-hidden="true" />
        <span>{busy ? "Reading" : "Import Excel"}</span>
        <input type="file" accept=".xlsx,.xls" onChange={(event) => loadFile(event.target.files?.[0] ?? null)} />
      </label>

      {selectedSheet ? (
        <div className="mapping-panel">
          <label className="field-label">
            <span>Worksheet</span>
            <select value={sheetIndex} onChange={(event) => selectSheet(Number(event.target.value))}>
              {sheets.map((sheet, index) => (
                <option key={sheet.name} value={index}>
                  {sheet.name}
                </option>
              ))}
            </select>
          </label>

          <div className="import-detection">
            <span>{selectedSheet.headers.length} columns detected</span>
            <span>Header row {selectedSheet.headerIndex + 1}</span>
          </div>

          <div className="mapping-grid">
            {selectedSheet.headers.map((header) => (
              <label key={header} className="mapping-row">
                <span>{header}</span>
                <select value={mapping[header] ?? "skip"} onChange={(event) => setMapping({ ...mapping, [header]: event.target.value as ImportField })}>
                  {fieldOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          <div className="import-preview">
            <strong>{rows.length} task rows ready</strong>
            {rows.slice(0, 3).map((row, index) => (
              <p key={`${row.title}-${index}`}>
                {[row.start_date, row.project, row.title].filter(Boolean).join(" · ")}
              </p>
            ))}
          </div>

          <button type="button" className="primary-button" disabled={busy} onClick={confirmImport}>
            <Upload size={17} aria-hidden="true" />
            <span>Confirm Import</span>
          </button>
        </div>
      ) : null}

      {message ? <p className="inline-message">{message}</p> : null}
    </section>
  );
}
