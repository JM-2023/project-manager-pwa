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
}

interface FakeTransaction {
  objectStore: (name: string) => { put: (value: unknown) => void; delete: () => void; getAll: () => unknown; get: () => unknown };
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  error: unknown;
  abort: () => void;
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
    close: () => undefined,
    transaction: () => {
      if (db.closedByBrowser) throw invalidState();
      const tx: FakeTransaction = {
        oncomplete: null,
        onerror: null,
        onabort: null,
        error: null,
        abort: () => setTimeout(() => tx.onabort?.(), 0),
        objectStore: () => ({
          put: (value: unknown) => db.puts.push(value),
          delete: () => undefined,
          getAll: () => ({}),
          get: () => ({})
        })
      };
      setTimeout(() => tx.oncomplete?.(), 0);
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
