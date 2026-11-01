import type { JsonValue } from "@muscle-memory/recipe-engine";

/** Reject unsafe/non-JSON framework results before they enter a checkpoint. */
export function isRecipeJson(value: unknown): value is JsonValue {
  const pending = [{ value, depth: 0 }];
  const seen = new Set<object>();
  let nodes = 0;
  while (pending.length) {
    const entry = pending.pop()!;
    if (++nodes > 20_000 || entry.depth > 64) return false;
    const item = entry.value;
    if (item === null || typeof item === "string" || typeof item === "boolean") continue;
    if (typeof item === "number") { if (!Number.isFinite(item)) return false; continue; }
    if (typeof item !== "object" || seen.has(item)) return false;
    if (!Array.isArray(item) && ![Object.prototype, null].includes(Object.getPrototypeOf(item))) return false;
    seen.add(item);
    // Repeated object references are also rejected: external results should be JSON trees.
    const entries = Array.isArray(item) ? Array.from(item).map((v, i) => [String(i), v] as const) : Object.entries(item);
    for (const [key, child] of entries) {
      if (["__proto__", "prototype", "constructor"].includes(key)) return false;
      pending.push({ value: child, depth: entry.depth + 1 });
    }
  }
  return true;
}
