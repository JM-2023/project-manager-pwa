// Builds the autosync Excel workbook off the main thread. Large worklogs make
// xlsx's write path CPU-heavy enough to jank mobile Safari, so the cloud
// autosync ships the data here and gets a Blob back.
import { workbookBlob } from "./excelExport";
import type { ExportDataResponse } from "./types";

type WorkerResult = { ok: true; blob: Blob } | { ok: false; error: string };

const scope = self as unknown as { postMessage: (message: WorkerResult) => void };

self.onmessage = (event: MessageEvent<ExportDataResponse>) => {
  try {
    scope.postMessage({ ok: true, blob: workbookBlob(event.data) });
  } catch (error) {
    scope.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  }
};
