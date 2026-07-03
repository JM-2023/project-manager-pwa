import type { ExportDataResponse } from "./types";

type WorkerResult = { ok: true; blob: Blob } | { ok: false; error: string };

/**
 * Build the autosync workbook in a dedicated worker so the xlsx write path
 * never blocks the UI thread. The worker is spawned per build and terminated
 * when done — autosync runs are debounced and rare, so there is nothing to
 * keep warm. Rejections fall back to the caller's inline build.
 */
export function buildWorkbookBlobInWorker(data: ExportDataResponse): Promise<Blob> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(new URL("./excelWorkbook.worker.ts", import.meta.url), { type: "module" });
    } catch (error) {
      reject(error);
      return;
    }

    const finish = (settle: () => void) => {
      worker.terminate();
      settle();
    };

    worker.onmessage = (event: MessageEvent<WorkerResult>) => {
      const result = event.data;
      if (result.ok) {
        finish(() => resolve(result.blob));
      } else {
        finish(() => reject(new Error(result.error)));
      }
    };
    worker.onerror = (event) => {
      finish(() => reject(new Error(event.message || "Excel worker failed")));
    };
    worker.postMessage(data);
  });
}
