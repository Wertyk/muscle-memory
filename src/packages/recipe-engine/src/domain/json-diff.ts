import type { JsonDifference } from "./backtest.js";
import { hasOwn, immutableSnapshot, isJsonValue, jsonEqual } from "./json.js";
import type { JsonObject, JsonValue } from "./model.js";

const segment = (key: string): string => key.replace(/~/g, "~0").replace(/\//g, "~1");

/** Exact structural JSON comparison; object order is irrelevant, array order is significant. */
export function diffJson(historical: JsonValue, intended: JsonValue): readonly JsonDifference[] {
  if (!isJsonValue(historical) || !isJsonValue(intended)) throw new Error("Comparison requires bounded finite JSON");
  const diff: JsonDifference[] = [];
  const visit = (left: JsonValue, right: JsonValue, path: string): void => {
    if (jsonEqual(left, right)) return;
    if (Array.isArray(left) && Array.isArray(right)) {
      for (let i = 0; i < Math.max(left.length, right.length); i++) {
        const child = `${path}/${i}`;
        if (i >= left.length) diff.push({ kind: "added", path: child, intended: right[i]! });
        else if (i >= right.length) diff.push({ kind: "removed", path: child, historical: left[i]! });
        else visit(left[i]!, right[i]!, child);
      }
    } else if (left !== null && right !== null && typeof left === "object" && typeof right === "object" &&
      !Array.isArray(left) && !Array.isArray(right)) {
      const a = left as JsonObject;
      const b = right as JsonObject;
      for (const key of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
        const child = `${path}/${segment(key)}`;
        if (!hasOwn(a, key)) diff.push({ kind: "added", path: child, intended: b[key]! });
        else if (!hasOwn(b, key)) diff.push({ kind: "removed", path: child, historical: a[key]! });
        else visit(a[key]!, b[key]!, child);
      }
    } else diff.push({ kind: "changed", path, historical: left, intended: right });
  };
  visit(historical, intended, "");
  return immutableSnapshot(diff);
}
