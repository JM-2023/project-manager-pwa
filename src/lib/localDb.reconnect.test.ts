import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Minimal IndexedDB stand-in: enough surface for localDb's meta writes, plus
 * the two ways a browser-closed connection shows up to page code — the
 * `close` event, and `transaction()` throwing InvalidStateError.
 */
interface FakeDb {
  objectStoreNames: { contains: (name: string) => boolean };
  transaction: (stores: string | string[], mode: string) => FakeTransaction;
  close: () => void;
  onclose: (() => void) | null;
  onversionchange: (() => void) | null;
  puts: unknown[];
  closedByBrowser: boolean;
  /** Simulate WebKit leaving a request pending forever. */
  hang: boolean;
}

interface FakeTransaction {
  objectStore: (name: string) => { put: (value: unknown) => void; delete: () => void; getAll: () => unknown; get: () => unknown };
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  error: unknown;
  abort: () => void;
  addEventListener: (type: string, callback: () => void) => void;
}

function invalidState(): DOMException {
  return new DOMException("The database connection is closing.", "InvalidStateError");
}

function createFakeDb(): FakeDb {
  const db: FakeDb = {
    objectStoreNames: { contains: () => true },
    onclose: null,
    onversionchange: null,
    puts: [],
    closedByBrowser: false,
    hang: false,
    close: () => undefined,
    transaction: () => {
      if (db.closedByBrowser) throw invalidState();
      const listeners = new Map<string, Array<() => void>>();
      const buffered: unknown[] = [];
      let ended = false;
      const emit = (type: string) => { for (const listener of listeners.get(type) ?? []) listener(); };
      const tx: FakeTransaction = {
        addEventListener: (type, callback) => listeners.set(type, [...(listeners.get(type) ?? []), callback]),
        oncomplete: null,
        onerror: null,
        onabort: null,
        error: null,
        abort: () => {
          if (ended) throw invalidState();
          ended = true;
          setTimeout(() => { emit("abort"); tx.onabort?.(); }, 0);
        },
        objectStore: () => ({
          put: (value: unknown) => buffered.push(value),
          delete: () => undefined,
          getAll: () => ({}),
          get: () => ({})
        })
      };
      if (!db.hang) setTimeout(() => {
        if (ended || tx.error) return;
        ended = true;
        db.puts.push(...buffered);
        emit("complete");
        tx.oncomplete?.();
      }, 0);
      return tx;
    }
  };
  return db;
}

const openedDbs: FakeDb[] = [];

const fakeIndexedDb = {
  open: () => {
    const request: {
      result: FakeDb;
      error: unknown;
      onsuccess: (() => void) | null;
      onerror: (() => void) | null;
      onblocked: (() => void) | null;
      onupgradeneeded: (() => void) | null;
    } = { result: createFakeDb(), error: null, onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null };
    openedDbs.push(request.result);
    setTimeout(() => request.onsuccess?.(), 0);
    return request;
  }
};

async function loadLocalDb() {
  vi.resetModules();
  return import("./localDb");
}

describe("localDb connection recovery", () => {
  beforeEach(() => {
    openedDbs.length = 0;
    vi.stubGlobal("indexedDB", fakeIndexedDb);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reuses one connection while it stays open", async () => {
    const { setLastSync } = await loadLocalDb();
    await setLastSync("2026-09-03T00:00:00.000Z");
    await setLastSync("2026-09-03T00:00:01.000Z");
    expect(openedDbs).toHaveLength(1);
    expect(openedDbs[0].puts).toHaveLength(2);
  });

  it("reopens after the browser fires close on the cached connection", async () => {
    const { setLastSync } = await loadLocalDb();
    await setLastSync("first");
    const [first] = openedDbs;
    // Safari closes the connections of a page it suspended in the background.
    first.closedByBrowser = true;
    first.onclose?.();

    await setLastSync("second");
    expect(openedDbs).toHaveLength(2);
    expect(openedDbs[1].puts).toEqual([{ key: "lastSync", value: "second" }]);
  });

  it("retries once on a fresh connection when transaction() reports a closed connection", async () => {
    const { setLastSync } = await loadLocalDb();
    await setLastSync("first");
    const [first] = openedDbs;
    // No close event this time: the dead handle is only discovered on use.
    first.closedByBrowser = true;

    await setLastSync("second");
    expect(openedDbs).toHaveLength(2);
    expect(openedDbs[1].puts).toEqual([{ key: "lastSync", value: "second" }]);
  });

  it("reopens when a transaction never completes", async () => {
    vi.useFakeTimers();
    const { setLastSync, LOCAL_DB_TIMEOUT_MS } = await loadLocalDb();
    const first = setLastSync("first");
    await vi.runAllTimersAsync();
    await first;
    openedDbs[0].hang = true;

    const second = setLastSync("second");
    await vi.advanceTimersByTimeAsync(LOCAL_DB_TIMEOUT_MS - 1);
    expect(openedDbs).toHaveLength(1);
    await vi.runAllTimersAsync();
    await second;
    expect(openedDbs).toHaveLength(2);
    expect(openedDbs[1].puts).toEqual([{ key: "lastSync", value: "second" }]);
    expect(openedDbs[0].puts).toEqual([{ key: "lastSync", value: "first" }]);
  });

  it("surfaces an error when the reopened connection hangs too", async () => {
    vi.useFakeTimers();
    const { setLastSync } = await loadLocalDb();
    const first = setLastSync("first");
    await vi.runAllTimersAsync();
    await first;
    openedDbs[0].hang = true;
    const originalOpen = fakeIndexedDb.open;
    fakeIndexedDb.open = () => {
      const request = originalOpen();
      request.result.hang = true;
      return request;
    };
    try {
      const outcome = expect(setLastSync("second")).rejects.toMatchObject({ name: "LocalDbTimeoutError" });
      await vi.runAllTimersAsync();
      await outcome;
      expect(openedDbs).toHaveLength(2);
    } finally {
      fakeIndexedDb.open = originalOpen;
    }
  });

  it("does not start a late write when a timed-out open eventually resolves", async () => {
    vi.useFakeTimers();
    const originalOpen = fakeIndexedDb.open;
    let delayed!: ReturnType<typeof originalOpen>;
    let calls = 0;
    fakeIndexedDb.open = () => {
      calls++;
      if (calls !== 1) return originalOpen();
      delayed = { result: createFakeDb(), error: null, onsuccess: null, onerror: null, onblocked: null, onupgradeneeded: null };
      return delayed;
    };
    try {
      const { setLastSync } = await loadLocalDb();
      const write = setLastSync("once");
      await vi.runAllTimersAsync(); await write;
      delayed.onsuccess?.();
      await vi.runAllTimersAsync();
      expect(delayed.result.puts).toEqual([]);
      expect(openedDbs[0].puts).toEqual([{ key: "lastSync", value: "once" }]);
    } finally { fakeIndexedDb.open = originalOpen; }
  });

  it("does not retry when abort cannot be confirmed", async () => {
    vi.useFakeTimers();
    const { setLastSync } = await loadLocalDb();
    const first = setLastSync("first"); await vi.runAllTimersAsync(); await first;
    openedDbs[0].hang = true;
    const transaction = openedDbs[0].transaction;
    openedDbs[0].transaction = (...args) => {
      const tx = transaction(...args);
      tx.abort = () => { throw invalidState(); };
      return tx;
    };
    const result = expect(setLastSync("uncertain")).rejects.toMatchObject({ name: "LocalDbTimeoutError" });
    await vi.runAllTimersAsync(); await result;
    expect(openedDbs).toHaveLength(1);
    expect(openedDbs[0].puts).toEqual([{ key: "lastSync", value: "first" }]);
  });

  it("does not retry ordinary transaction failures", async () => {
    const { setLastSync } = await loadLocalDb();
    await setLastSync("first");
    const [first] = openedDbs;
    const originalTransaction = first.transaction;
    first.transaction = (stores, mode) => {
      const tx = originalTransaction(stores, mode);
      tx.error = new DOMException("Quota exceeded", "QuotaExceededError");
      setTimeout(() => tx.onerror?.(), 0);
      tx.oncomplete = null;
      Object.defineProperty(tx, "oncomplete", { set: () => undefined, get: () => null });
      return tx;
    };

    await expect(setLastSync("second")).rejects.toMatchObject({ name: "QuotaExceededError" });
    expect(openedDbs).toHaveLength(1);
  });
});
