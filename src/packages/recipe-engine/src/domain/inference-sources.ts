import { evaluateExpression, expressionPaths, MAX_FIND_ITEMS } from "./evaluation.js";
import { isIdentifier, jsonEqual } from "./json.js";
import type { Binding, Expression, JsonObject, JsonValue } from "./model.js";

export interface Source {
  readonly path: string;
  readonly value: JsonValue;
  readonly expr: Expression;
  readonly rank: number;
  readonly exhaustive: boolean;
  readonly derived?: boolean;
  readonly personName?: boolean;
  readonly money?: { readonly currency: string; readonly expr: Expression };
}
interface RawSource { path: string; value: JsonValue }
interface Reference { expr: Expression; rank: number; exhaustive: boolean }
const MAX_REFERENCES = 64;
const scalar = (value: JsonValue) => value === null || typeof value !== "object";

function rawSources(value: JsonValue, path: string, result: RawSource[] = []): RawSource[] {
  result.push({ value, path });
  if (Array.isArray(value)) value.forEach((child, index) => rawSources(child, `${path}[${index}]`, result));
  else if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value).sort()) if (isIdentifier(key)) rawSources((value as JsonObject)[key]!, `${path}.${key}`, result);
  }
  return result;
}
export function sourceBinding(source: Source): Binding {
  const expr = source.expr as JsonObject;
  return typeof expr.var === "string" ? { mode: "path", path: expr.var } : { mode: "expr", expr: source.expr };
}
export const sourcePaths = (source: Source): readonly string[] => expressionPaths(source.expr);

/** Keyed references keep the same observed value, with static own-property paths.
 * Recursive array bases allow nested keyed selections without positional roots. */
export function inferenceSources(value: JsonValue, path: string, trigger: JsonObject, action = ""): readonly Source[] {
  const raw = rawSources(value, path);
  const byPath = new Map(raw.map(source => [source.path, source.value]));
  const triggerScalars = rawSources(trigger, "trigger").filter(source => scalar(source.value));
  const byTriggerValue = new Map<string, RawSource[]>();
  for (const source of triggerScalars) {
    const key = JSON.stringify(source.value);
    const group = byTriggerValue.get(key) ?? [];
    group.push(source); byTriggerValue.set(key, group);
  }
  const references = new Map<string, readonly Reference[]>();
  const keyCache = new Map<string, readonly { key: string; wanted: Expression; rank: number }[]>();
  const append = (reference: Reference, tail: string): Reference => {
    const expr = reference.expr as JsonObject;
    if (typeof expr.var === "string") return { ...reference, expr: { var: `${expr.var}${tail}` }, rank: /\[\d+\]/.test(tail) ? 100 : reference.rank };
    const args = expr.find as readonly JsonValue[];
    const returned = args[3] as string;
    return { ...reference, expr: { find: [args[0]!, args[1]!, args[2]!, `${returned}${returned || !tail.startsWith(".") ? tail : tail.slice(1)}`] }, rank: /\[\d+\]/.test(tail) ? 100 : reference.rank };
  };
  const refs = (sourcePath: string): readonly Reference[] => {
    const cached = references.get(sourcePath);
    if (cached) return cached;
    const indices = [...sourcePath.matchAll(/\[(\d+)\]/g)];
    const last = indices[indices.length - 1];
    if (!last) return [{ expr: { var: sourcePath }, rank: sourcePath.startsWith("trigger") ? -100 : 50, exhaustive: true }];
    const arrayPath = sourcePath.slice(0, last.index);
    const array = byPath.get(arrayPath);
    const index = Number(last[1]);
    const item = Array.isArray(array) ? array[index] : undefined;
    const suffix = sourcePath.slice(last.index! + last[0].length);
    const base = refs(arrayPath);
    const keyId = `${arrayPath}[${index}]`;
    let keys = keyCache.get(keyId);
    if (!keys) {
      keys = [];
      if (Array.isArray(array) && array.length <= MAX_FIND_ITEMS && item !== null && typeof item === "object" && !Array.isArray(item)) {
        const candidates: { key: string; wanted: Expression; rank: number }[] = [];
        for (const key of Object.keys(item).sort().filter(isIdentifier)) {
          const observed = (item as JsonObject)[key]!;
          if (!scalar(observed)) continue;
          if (array.filter(entry => entry !== null && typeof entry === "object" && !Array.isArray(entry) && Object.prototype.hasOwnProperty.call(entry, key) && jsonEqual((entry as JsonObject)[key]!, observed)).length !== 1) continue;
          for (const source of byTriggerValue.get(JSON.stringify(observed)) ?? []) {
            const lowInformation = typeof observed !== "string" || observed.length < 4;
            candidates.push({ key, wanted: { var: source.path }, rank: (source.path.endsWith(`.${key}`) ? 0 : 10) + (lowInformation ? 20 : 0) });
          }
        }
        keys = candidates.sort((a, b) => a.rank - b.rank);
      }
      keyCache.set(keyId, keys);
    }
    const alternatives = [
      ...keys.flatMap(key => base.map(reference => ({ expr: { find: [reference.expr, key.key, key.wanted, suffix.replace(/^\./, "")] }, rank: reference.rank === 100 ? 100 : key.rank, exhaustive: reference.exhaustive }))),
      ...base.map(reference => append(reference, `[${index}]${suffix}`)),
    ].sort((a, b) => a.rank - b.rank);
    const unique = [...new Map(alternatives.map(reference => [JSON.stringify(reference.expr), reference])).values()];
    const limited = unique.slice(0, MAX_REFERENCES).map(reference => ({ ...reference, exhaustive: reference.exhaustive && unique.length <= MAX_REFERENCES }));
    references.set(sourcePath, limited);
    return limited;
  };
  const sources: Source[] = [];
  for (const source of raw) {
    for (const reference of refs(source.path)) {
      let money: Source["money"];
      const parent = byPath.get(source.path.replace(/\.amountMinor$/, ""));
      if (source.path.endsWith(".amountMinor") && parent !== null && typeof parent === "object" && !Array.isArray(parent) && typeof (parent as JsonObject).currency === "string") {
        const expression = reference.expr as JsonObject;
        const currencyExpr: Expression = typeof expression.var === "string"
          ? { var: expression.var.replace(/\.amountMinor$/, ".currency") }
          : { find: (expression.find as readonly JsonValue[]).map((entry, i) => i === 3 ? (entry as string).replace(/(^|\.)amountMinor$/, "$1currency") : entry) };
        money = { currency: (parent as JsonObject).currency as string, expr: currencyExpr };
      }
      const personName = /\.(?:fullName|customerName|shippingName|personName|recipientName)$/.test(source.path)
        || (source.path.endsWith(".name") && (source.path === "trigger.name"
          || /(?:shippingAddress|billingAddress|customer|person|recipient|contact|user|profile)\.name$/.test(source.path)
          || (source.path === `${path}.name` && /customer|person|recipient|contact|user|profile/i.test(action))));
      sources.push({ ...source, ...reference, personName, ...(money ? { money } : {}) });
    }
  }
  // Keep source ordering stable within a priority tier, including trigger before outputs.
  return sources.sort((a, b) => a.rank - b.rank);
}

/** Bounded derived text tokens; the expression is retained rather than its sample value. */
export function derivedTextSources(sources: readonly Source[]): readonly Source[] {
  const derived: Source[] = [];
  for (const source of sources) {
    const candidates: Expression[] = [];
    if (source.personName && typeof source.value === "string" && /\S+\s+\S+/.test(source.value.trim())) candidates.push({ firstWord: [source.expr] });
    if (source.money && typeof source.value === "number") {
      candidates.push({ money: [source.expr, source.money.expr] }, { money: [source.expr, source.money.expr, "decimal"] });
    }
    for (const expr of candidates) {
      try {
        // Only source-local expressions are evaluated; no outside state is accessed.
        const context = { trigger: {}, steps: {} };
        const sample: Expression = "money" in (expr as JsonObject)
          ? { money: [source.value, source.money!.currency, ...((expr as JsonObject).money as readonly JsonValue[]).slice(2)] }
          : { firstWord: [source.value] };
        const value = evaluateExpression(sample, context);
        if (!jsonEqual(value, source.value)) derived.push({ ...source, value, expr, derived: true });
      } catch { /* Unsupported currency, unsafe/fractional money or oversized text is not a token. */ }
    }
  }
  return derived;
}
