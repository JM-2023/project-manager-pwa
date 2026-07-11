import type { ExportDataResponse } from "./types";

type WorkerResult = { ok: true; blob: Blob } | { ok: false; error: string };
const WORKBOOK_WORKER_TIMEOUT_MS = 60_000;

export class WorkbookWorkerUnavailableError extends Error {
  constructor(message = "Excel worker is unavailable") {
    super(message);
    this.name = "WorkbookWorkerUnavailableError";
  }
}

export class WorkbookWorkerTimeoutError extends Error {
  constructor() {
    super("Excel worker timed out after 60 seconds");
    this.name = "WorkbookWorkerTimeoutError";
  }
}

export class WorkbookWorkerBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkbookWorkerBuildError";
  }
}

/**
 * Build the autosync workbook in a dedicated worker so the xlsx write path
 * never blocks the UI thread. The worker is spawned per build and terminated
 * when done — autosync runs are debounced and rare, so there is nothing to
 * keep warm. Callers may fall back only when the worker itself is unavailable;
 * build failures and the watchdog timeout should be surfaced without repeating
 * the same CPU-heavy work on the main thread.
 */
function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException("Excel workbook build aborted", "AbortError");
}

export function buildWorkbookBlobInWorker(data: ExportDataResponse, signal?: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }

    let worker: Worker;
    try {
      worker = new Worker(new URL("./excelWorkbook.worker.ts", import.meta.url), { type: "module" });
    } catch (error) {
      reject(new WorkbookWorkerUnavailableError(error instanceof Error ? error.message : undefined));
      return;
    }

    let settled = false;
    let timeoutId: number | undefined;
    function finish(settle: () => void): void {
      if (settled) return;
      settled = true;
      if (timeoutId !== undefined) window.clearTimeout(timeoutId);
      signal?.removeEventListener("abort", handleAbort);
      worker.terminate();
      settle();
    }
    function handleAbort(): void {
      finish(() => reject(abortReason(signal!)));
    }

    worker.onmessage = (event: MessageEvent<WorkerResult>) => {
      const result = event.data;
      if (result.ok) {
        finish(() => resolve(result.blob));
      } else {
        finish(() => reject(new WorkbookWorkerBuildError(result.error)));
      }
    };
    worker.onerror = (event) => {
      finish(() => reject(new WorkbookWorkerUnavailableError(event.message || "Excel worker failed to start")));
    };
    timeoutId = window.setTimeout(() => {
      finish(() => reject(new WorkbookWorkerTimeoutError()));
    }, WORKBOOK_WORKER_TIMEOUT_MS);
    signal?.addEventListener("abort", handleAbort, { once: true });
    if (signal?.aborted) {
      handleAbort();
      return;
    }
    try {
      worker.postMessage(data);
    } catch (error) {
      finish(() =>
        reject(new WorkbookWorkerUnavailableError(error instanceof Error ? error.message : "Excel worker rejected data"))
      );
    }
  });
}
