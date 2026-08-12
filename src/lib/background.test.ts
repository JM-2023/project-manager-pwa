import { afterEach, describe, expect, it, vi } from "vitest";
import { applyBackground, getStoredBackground, setStoredBackground } from "./background";

interface MetaStub {
  getAttribute: (name: string) => string | null;
  content: string;
}

function makeMeta(media: string | null): MetaStub {
  return {
    getAttribute: (name: string) => (name === "media" ? media : null),
    content: ""
  };
}

function stubDocument(attributes: Map<string, string>, metas: MetaStub[]): void {
  vi.stubGlobal("document", {
    documentElement: {
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
      getAttribute: (name: string) => attributes.get(name) ?? null
    },
    querySelectorAll: () => metas
  });
}

function stubStorage(initial: Record<string, string> = {}): Map<string, string> {
  const values = new Map(Object.entries(initial));
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key)
  });
  return values;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("background preference", () => {
  it("defaults to paper and ignores unknown stored values", () => {
    stubStorage({ "pm:bg": "tartan" });
    expect(getStoredBackground()).toBe("default");
  });

  it("stores gray, pins the root attribute and retints both chrome metas", () => {
    const storage = stubStorage();
    const attributes = new Map<string, string>();
    const light = makeMeta("(prefers-color-scheme: light)");
    const dark = makeMeta("(prefers-color-scheme: dark)");
    stubDocument(attributes, [light, dark]);

    setStoredBackground("gray");

    expect(storage.get("pm:bg")).toBe("gray");
    expect(attributes.get("data-bg")).toBe("gray");
    expect(light.content).toBe("#eef0f3");
    expect(dark.content).toBe("#17181a");
  });

  it("returning to paper clears the key, the attribute and the retint", () => {
    const storage = stubStorage({ "pm:bg": "gray" });
    const attributes = new Map<string, string>([["data-bg", "gray"]]);
    const light = makeMeta("(prefers-color-scheme: light)");
    const dark = makeMeta("(prefers-color-scheme: dark)");
    stubDocument(attributes, [light, dark]);

    setStoredBackground("default");

    expect(storage.has("pm:bg")).toBe(false);
    expect(attributes.has("data-bg")).toBe(false);
    expect(light.content).toBe("#f5f3ee");
    expect(dark.content).toBe("#131211");
  });

  it("follows a pinned theme when retinting the metas", () => {
    stubStorage();
    const attributes = new Map<string, string>([["data-theme", "dark"]]);
    const light = makeMeta("(prefers-color-scheme: light)");
    const dark = makeMeta("(prefers-color-scheme: dark)");
    stubDocument(attributes, [light, dark]);

    applyBackground("gray");

    expect(light.content).toBe("#17181a");
    expect(dark.content).toBe("#17181a");
  });
});
