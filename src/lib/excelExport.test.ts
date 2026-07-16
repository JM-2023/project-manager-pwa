import { utils } from "xlsx";
import { describe, expect, it } from "vitest";
import type { ExportDataResponse } from "./types";
import { buildWorkbook } from "./excelExport";

describe("Excel export ordering", () => {
  it("keeps Next project columns in presentation order regardless of snapshot transport order", () => {
    const data: ExportDataResponse = {
      exportedAt: "2026-07-16T00:00:00.000Z",
      serverTime: "2026-07-16T00:00:00.000Z",
      syncEpoch: "epoch-1",
      syncCursor: 1,
      full: true,
      projects: [],
      tasks: [],
      nextProjects: [
        {
          id: "next-z",
          name: "Zulu",
          sort_order: 2,
          archived: 0,
          created_at: "2026-07-16T00:00:00.000Z",
          updated_at: "2026-07-16T00:00:00.000Z",
          version: 1
        },
        {
          id: "next-b",
          name: "Beta",
          sort_order: 1,
          archived: 0,
          created_at: "2026-07-16T00:00:00.000Z",
          updated_at: "2026-07-16T00:00:00.000Z",
          version: 1
        },
        {
          id: "next-a",
          name: "Alpha",
          sort_order: 1,
          archived: 0,
          created_at: "2026-07-16T00:00:00.000Z",
          updated_at: "2026-07-16T00:00:00.000Z",
          version: 1
        }
      ],
      nextIdeas: [],
      settings: {}
    };

    const workbook = buildWorkbook(data);
    const rows = utils.sheet_to_json<unknown[]>(workbook.Sheets["项目缓存"], { header: 1 });
    expect(rows[0]).toEqual(["Alpha", "Beta", "Zulu"]);
  });
});
