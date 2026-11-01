import { describe, expect, it } from "vitest";
import { diffJson } from "./json-diff.js";
import type { JsonValue } from "./model.js";

describe("generic JSON field differences", () => {
  it("ignores object insertion order and compares nested fields in stable key order", () => {
    expect(diffJson({ b: [1, { y: false, x: 3 }], a: null }, { a: null, b: [1, { x: 3, y: false }] })).toEqual([]);
    expect(diffJson({ z: 1, a: { price: 1200 } }, { z: 2, a: { price: 2400 } })).toEqual([
      { kind: "changed", path: "/a/price", historical: 1200, intended: 2400 },
      { kind: "changed", path: "/z", historical: 1, intended: 2 },
    ]);
  });

  it("distinguishes missing fields from null and escapes JSON Pointer segments", () => {
    expect(diffJson({ removed: null, "a/b": { "~x": 1 } }, { added: null, "a/b": { "~x": 2 } })).toEqual([
      { kind: "changed", path: "/a~1b/~0x", historical: 1, intended: 2 },
      { kind: "added", path: "/added", intended: null },
      { kind: "removed", path: "/removed", historical: null },
    ]);
  });

  it("compares ordered arrays, additions/removals, types, and root values", () => {
    expect(diffJson([1, 2], [2, 1, null])).toEqual([
      { kind: "changed", path: "/0", historical: 1, intended: 2 },
      { kind: "changed", path: "/1", historical: 2, intended: 1 },
      { kind: "added", path: "/2", intended: null },
    ]);
    expect(diffJson([{}], [])).toEqual([{ kind: "removed", path: "/0", historical: {} }]);
    expect(diffJson(1, "1")).toEqual([{ kind: "changed", path: "", historical: 1, intended: "1" }]);
    expect(diffJson([], {})).toEqual([{ kind: "changed", path: "", historical: [], intended: {} }]);
  });

  it("returns detached frozen evidence without freezing caller data", () => {
    const source = { removed: { items: [1] } };
    const diff = diffJson(source, {});
    source.removed.items.push(2);
    expect(diff).toEqual([{ kind: "removed", path: "/removed", historical: { items: [1] } }]);
    expect(Object.isFrozen(diff)).toBe(true);
    expect(Object.isFrozen(diff[0])).toBe(true);
  });

  it("rejects nonfinite, cyclic, unsafe, or excessive JSON before recursion", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    let deep: JsonValue = null;
    for (let i = 0; i < 66; i++) deep = [deep];
    for (const invalid of [Infinity, cycle, deep, JSON.parse('{"__proto__":null}')]) {
      expect(() => diffJson(invalid as JsonValue, null)).toThrow(/bounded finite JSON/);
      expect(() => diffJson(null, invalid as JsonValue)).toThrow(/bounded finite JSON/);
    }
  });
});
