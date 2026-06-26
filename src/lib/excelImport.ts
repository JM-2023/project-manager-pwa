import { read, utils } from "xlsx";
import { detectHeaderIndex, makeUniqueHeaders, type ParsedSheet } from "./excelMapping";

export async function parseWorkbook(file: Blob): Promise<ParsedSheet[]> {
  const buffer = await file.arrayBuffer();
  const workbook = read(buffer, { cellDates: true });

  return workbook.SheetNames.map((name) => {
    const rows = utils.sheet_to_json<unknown[]>(workbook.Sheets[name], {
      header: 1,
      defval: "",
      raw: false,
      dateNF: "yyyy-mm-dd"
    });
    const headerIndex = detectHeaderIndex(rows);
    const headers = makeUniqueHeaders(rows[headerIndex] ?? []);
    return { name, rows, headerIndex, headers };
  });
}

export type { ParsedSheet } from "./excelMapping";
