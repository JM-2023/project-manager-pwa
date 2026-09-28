import { describe, expect, it } from "vitest";
import { mergeExits, type MotionEntry } from "./listMotion";

const keyOf = (item: string) => item;
const live = (...keys: string[]): MotionEntry<string>[] => keys.map((key) => ({ key, item: key, exiting: false }));
const shape = (entries: MotionEntry<string>[]) => entries.map((entry) => (entry.exiting ? `~${entry.key}` : entry.key));
const none = new Set<string>();

describe("mergeExits", () => {
  it("keeps a deleted row folding out in its old slot", () => {
    const next = mergeExits(live("a", "b", "c"), ["a", "c"], keyOf, new Set(["a", "c"]), none);
    expect(shape(next)).toEqual(["a", "~b", "c"]);
  });

  it("keeps a row folding out when it was first, and when every row leaves", () => {
    expect(shape(mergeExits(live("a", "b"), ["b"], keyOf, new Set(["b"]), none))).toEqual(["~a", "b"]);
    expect(shape(mergeExits(live("a", "b"), [], keyOf, none, none))).toEqual(["~a", "~b"]);
  });

  it("keeps a run of exits together behind the row they followed", () => {
    const next = mergeExits(live("a", "b", "c", "d"), ["d", "a"], keyOf, new Set(["a", "d"]), none);
    expect(shape(next)).toEqual(["d", "a", "~b", "~c"]);
  });

  it("drops a row paged out of view without an exit", () => {
    const next = mergeExits(live("a", "b", "c"), ["a", "b"], keyOf, new Set(["a", "b", "c"]), none);
    expect(shape(next)).toEqual(["a", "b"]);
  });

  it("keeps folding rows until their fold lands, then drops them", () => {
    const folding = mergeExits(live("a", "b"), ["b"], keyOf, new Set(["b"]), none);
    expect(shape(mergeExits(folding, ["b"], keyOf, new Set(["b"]), none))).toEqual(["~a", "b"]);
    expect(shape(mergeExits(folding, ["b"], keyOf, new Set(["b"]), new Set(["a"])))).toEqual(["b"]);
  });

  it("revives a folding row that comes back, at its new position", () => {
    const folding = mergeExits(live("a", "b"), ["b"], keyOf, new Set(["b"]), none);
    expect(shape(mergeExits(folding, ["b", "a"], keyOf, new Set(["a", "b"]), none))).toEqual(["b", "a"]);
  });

  it("holds the last snapshot of a folding row's item", () => {
    const previous: MotionEntry<{ id: string; title: string }>[] = [{ key: "a", item: { id: "a", title: "old" }, exiting: false }];
    const next = mergeExits(previous, [], (item) => item.id, none, none);
    expect(next).toEqual([{ key: "a", item: { id: "a", title: "old" }, exiting: true }]);
  });
});
