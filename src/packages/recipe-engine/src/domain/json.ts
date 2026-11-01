import type { JsonValue } from "./model.js";

export const MAX_DATA_DEPTH = 64;
export const MAX_DATA_NODES = 20_000;
export const isSafeKey = (key: string): boolean => !["__proto__", "prototype", "constructor"].includes(key);
export const isIdentifier = (key: string): boolean => /^[A-Za-z_][A-Za-z0-9_-]*$/.test(key) && isSafeKey(key);
// Consumers may typecheck workspace sources with an ES2020 library target.
export const hasOwn = (value: object, key: string): boolean => Object.prototype.hasOwnProperty.call(value, key);

/** Reject non-JSON values, cycles, unsafe keys, and unbounded input before recursion. */
export function isJsonValue(value: unknown): value is JsonValue {
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (item: unknown, depth: number): boolean => {
    if (++nodes > MAX_DATA_NODES || depth > MAX_DATA_DEPTH) return false;
    if (item === null || typeof item === "string" || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (typeof item !== "object" || ancestors.has(item)) return false;
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) return false;
    ancestors.add(item);
    const valid = Array.isArray(item)
      ? Array.from(item).every((entry) => visit(entry, depth + 1))
      : Object.entries(item).every(([key, entry]) => isSafeKey(key) && visit(entry, depth + 1));
    ancestors.delete(item);
    return valid;
  };
  return visit(value, 0);
}

export function jsonEqual(left: JsonValue, right: JsonValue): boolean {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left)) return Array.isArray(right) && left.length === right.length && left.every((v, i) => jsonEqual(v, right[i]!));
  if (Array.isArray(right)) return false;
  const a = left as Record<string, JsonValue>;
  const b = right as Record<string, JsonValue>;
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every((key) => hasOwn(b, key) && jsonEqual(a[key]!, b[key]!));
}

/** Internal helper for validated JSON-shaped models; never freezes the caller's objects. */
export function immutableSnapshot<T>(value: T): T {
  const freeze = (item: unknown): void => {
    if (item !== null && typeof item === "object") {
      Object.values(item).forEach(freeze);
      Object.freeze(item);
    }
  };
  const copy = JSON.parse(JSON.stringify(value)) as T;
  freeze(copy);
  return copy;
}
