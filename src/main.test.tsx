import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createRoot: vi.fn(),
  initMeterStyle: vi.fn(),
  render: vi.fn()
}));

vi.mock("react-dom/client", () => ({
  default: { createRoot: mocks.createRoot }
}));
vi.mock("./App", () => ({ App: () => null }));
vi.mock("./lib/i18n", () => ({ I18nProvider: ({ children }: { children: unknown }) => children }));
vi.mock("./lib/meterStyle", () => ({ initMeterStyle: mocks.initMeterStyle }));

const FIRST_REVEAL_SEEN_KEY = "project-manager:first-reveal-seen";

class FakeClassList {
  private readonly values = new Set<string>();

  add(...tokens: string[]): void {
    tokens.forEach((token) => this.values.add(token));
  }

  remove(...tokens: string[]): void {
    tokens.forEach((token) => this.values.delete(token));
  }

  contains(token: string): boolean {
    return this.values.has(token);
  }
}

interface StorageStub {
  getItem: ReturnType<typeof vi.fn<(key: string) => string | null>>;
  setItem: ReturnType<typeof vi.fn<(key: string, value: string) => void>>;
}

interface BootResult {
  classes: FakeClassList;
  timers: Array<{ callback: () => void; delay: number }>;
}

function createStorage(initial: Record<string, string> = {}): StorageStub {
  const values = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      values.set(key, value);
    })
  };
}

async function boot(storage: StorageStub): Promise<BootResult> {
  vi.resetModules();
  const classes = new FakeClassList();
  const timers: BootResult["timers"] = [];

  mocks.createRoot.mockReturnValue({ render: mocks.render });
  vi.stubGlobal("document", {
    documentElement: { classList: classes },
    getElementById: () => ({})
  });
  vi.stubGlobal("navigator", { onLine: true });
  vi.stubGlobal("window", {
    addEventListener: vi.fn(),
    localStorage: storage,
    location: { reload: vi.fn() },
    setTimeout: (callback: () => void, delay: number) => {
      timers.push({ callback, delay });
      return timers.length;
    }
  });

  await import("./main");
  return { classes, timers };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("first-entry reveal", () => {
  it("plays once after durably marking the first visit", async () => {
    const storage = createStorage();
    const firstBoot = await boot(storage);

    expect(storage.setItem).toHaveBeenCalledWith(FIRST_REVEAL_SEEN_KEY, "1");
    expect(firstBoot.classes.contains("first-reveal")).toBe(true);
    expect(firstBoot.classes.contains("reveal-complete")).toBe(false);
    expect(firstBoot.timers).toHaveLength(1);
    expect(firstBoot.timers[0].delay).toBe(1320);

    firstBoot.timers[0].callback();
    expect(firstBoot.classes.contains("first-reveal")).toBe(false);
    expect(firstBoot.classes.contains("reveal-complete")).toBe(true);

    const refreshedBoot = await boot(storage);
    expect(refreshedBoot.classes.contains("first-reveal")).toBe(false);
    expect(refreshedBoot.classes.contains("reveal-complete")).toBe(true);
    expect(refreshedBoot.timers).toHaveLength(0);
  });

  it("skips the optional reveal when storage cannot be read", async () => {
    const storage = createStorage();
    storage.getItem.mockImplementation(() => {
      throw new Error("storage unavailable");
    });

    const result = await boot(storage);

    expect(result.classes.contains("first-reveal")).toBe(false);
    expect(result.classes.contains("reveal-complete")).toBe(true);
    expect(result.timers).toHaveLength(0);
  });

  it("does not start a reveal that cannot be durably marked", async () => {
    const storage = createStorage();
    storage.setItem.mockImplementation(() => {
      throw new Error("storage unavailable");
    });

    const result = await boot(storage);

    expect(result.classes.contains("first-reveal")).toBe(false);
    expect(result.classes.contains("reveal-complete")).toBe(true);
    expect(result.timers).toHaveLength(0);
  });
});
