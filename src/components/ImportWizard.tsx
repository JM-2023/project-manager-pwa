import { FileSpreadsheet, Upload } from "lucide-react";
import { useMemo, useState } from "react";
import {
  defaultMapping,
  normalizeImportRows,
  type ColumnMapping,
  type ImportField,
  type ParsedSheet
} from "../lib/excelMapping";
import { useI18n } from "../lib/i18n";
import type { ImportResponse, ImportRow } from "../lib/types";

interface ImportWizardProps {
  onImport: (filename: string, rows: ImportRow[]) => Promise<ImportResponse>;
}

const IMPORT_FIELDS: ImportField[] = [
  "skip",
  "id",
  "external_key",
  "project",
  "title",
  "status",
  "priority",
  "importance",
  "due_date",
  "start_date",
  "next_action",
  "notes",
  "description",
  "progress",
  "blocker",
  "output"
];

export function ImportWizard({ onImport }: ImportWizardProps) {
  const { m } = useI18n();
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
        throw new Error(m.importer.emptyWorkbook);
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
      setMessage(error instanceof Error ? error.message : m.importer.couldNotRead);
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
      setMessage(m.importer.noRows);
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      const result = await onImport(filename, rows);
      setMessage(m.importer.importedSummary(rows.length, result.created, result.updated, result.skipped));
      setSheets([]);
      setFilename("");
      setMapping({});
    } catch (error) {
      setMessage(error instanceof Error ? error.message : m.importer.importFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="import-wizard">
      <label className="file-picker">
        <FileSpreadsheet size={18} aria-hidden="true" />
        <span>{busy ? m.importer.reading : m.importer.pick}</span>
        <input type="file" accept=".xlsx,.xls" onChange={(event) => loadFile(event.target.files?.[0] ?? null)} />
      </label>

      {selectedSheet ? (
        <div className="mapping-panel">
          <label className="field-label">
            <span>{m.importer.worksheet}</span>
            <select value={sheetIndex} onChange={(event) => selectSheet(Number(event.target.value))}>
              {sheets.map((sheet, index) => (
                <option key={sheet.name} value={index}>
                  {sheet.name}
                </option>
              ))}
            </select>
          </label>

          <div className="import-detection">
            <span>{m.importer.columnsDetected(selectedSheet.headers.length)}</span>
            <span>{m.importer.headerRow(selectedSheet.headerIndex + 1)}</span>
          </div>

          <div className="mapping-grid">
            {selectedSheet.headers.map((header) => (
              <label key={header} className="mapping-row">
                <span>{header}</span>
                <select value={mapping[header] ?? "skip"} onChange={(event) => setMapping({ ...mapping, [header]: event.target.value as ImportField })}>
                  {IMPORT_FIELDS.map((field) => (
                    <option key={field} value={field}>
                      {m.importer.fields[field]}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>

          <div className="import-preview">
            <strong>{m.importer.rowsReady(rows.length)}</strong>
            {rows.slice(0, 3).map((row, index) => (
              <p key={`${row.title}-${index}`}>
                {[row.start_date, row.project, row.title].filter(Boolean).join(" · ")}
              </p>
            ))}
          </div>

          <button type="button" className="primary-button" disabled={busy} onClick={confirmImport}>
            <Upload size={17} aria-hidden="true" />
            <span>{m.importer.confirmImport}</span>
          </button>
        </div>
      ) : null}

      {message ? <p className="inline-message">{message}</p> : null}
    </section>
  );
}
