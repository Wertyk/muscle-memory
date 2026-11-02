import { pathSegments, resolveBinding, expressionPaths } from "./evaluation.js";
import { immutableSnapshot, isIdentifier, isJsonValue, jsonEqual } from "./json.js";
import type { ActionStep, Binding, BindingContext, BindingTree, JsonObject, JsonValue, Trace } from "./model.js";
import { roundToInteger } from "./rounding.js";
import { inferenceSources, sourceBinding, sourcePaths, type Source } from "./inference-sources.js";
import { requestSpecificFragments, textCandidates } from "./text-inference.js";

export interface BindingCandidate {
  readonly binding: Binding;
  readonly reason: "exact-match" | "scale" | "rounded-scale" | "difference" | "template" | "constant";
  readonly sourcePaths: readonly string[];
}
export interface BindingProposal {
  readonly stepId: string;
  readonly argumentPath: string;
  readonly proposed: Binding;
  readonly candidates: readonly BindingCandidate[];
  readonly exhaustive: boolean;
}
export interface BindingAmbiguity {
  readonly stepId: string;
  readonly argumentPath: string;
  readonly kind: "multiple-candidates" | "constant-or-variable" | "candidate-limit" | "positional-array" | "request-specific-text";
  readonly message?: string | undefined;
  readonly fragments?: readonly string[] | undefined;
  readonly candidates: readonly BindingCandidate[];
}
export interface InferenceResult {
  readonly steps: readonly ActionStep[];
  readonly proposals: readonly BindingProposal[];
  readonly ambiguities: readonly BindingAmbiguity[];
}

interface Candidate extends BindingCandidate { readonly origin?: Source }
interface Candidates { readonly values: readonly Candidate[]; readonly exhaustive: boolean }
const MAX_CANDIDATES = 64;
export const INFERENCE_SCALES: readonly number[] = Object.freeze([0.1, 0.2, 0.25, 0.5, 0.75, 0.8, 0.9, 1.1, 1.2, 1.25, 1.5, 2, 3, 4, 10, 100]);

function limitCandidates(candidates: readonly Candidate[]): Candidates {
  const unique = new Map<string, Candidate>();
  for (const candidate of candidates) unique.set(JSON.stringify(candidate.binding), candidate);
  return { values: [...unique.values()].slice(0, MAX_CANDIDATES), exhaustive: unique.size <= MAX_CANDIDATES && candidates.every(candidate => candidate.origin?.exhaustive !== false) };
}

function numericCandidates(value: number, sources: readonly Source[]): Candidates {
  const numbers = sources.filter((source): source is Source & { value: number } => typeof source.value === "number");
  const result: Candidate[] = [];
  const byValue = new Map<number, typeof numbers>();
  for (const source of numbers) {
    const group = byValue.get(source.value) ?? [];
    group.push(source); byValue.set(source.value, group);
  }
  const add = (candidate: Candidate): boolean => { result.push(candidate); return result.length > MAX_CANDIDATES; };
  const limited = (): Candidates => ({ ...limitCandidates(result), exhaustive: false });
  // Prefer keyed identity over position. Within a tier retain the established
  // exact-scale, difference, rounded-scale order and deterministic source order.
  for (const rank of [...new Set(numbers.map(source => source.rank))].sort((a, b) => a - b)) {
    const tier = numbers.filter(source => source.rank === rank);
    for (const source of tier) for (const scale of INFERENCE_SCALES) {
      if (source.value !== 0 && source.value * scale === value && add({ binding: { mode: "expr", expr: { "*": [source.expr, scale] } }, reason: "scale", sourcePaths: sourcePaths(source), origin: source })) return limited();
    }
    for (const left of tier) for (const right of byValue.get(left.value - value) ?? []) {
      if (left.path !== right.path && right.value !== 0 && left.value - right.value === value && add({
        binding: { mode: "expr", expr: { "-": [left.expr, right.expr] } }, reason: "difference",
        sourcePaths: [...new Set([...sourcePaths(left), ...sourcePaths(right)])], origin: left,
      })) return limited();
    }
    if (Number.isInteger(value)) for (const source of tier) for (const scale of INFERENCE_SCALES) {
      const product = source.value * scale;
      if (!source.value || product === value || !Number.isFinite(product)) continue;
      for (const mode of ["round", "floor", "ceil"] as const) {
        if (roundToInteger(product, mode) === value && add({ binding: { mode: "expr", expr: { [mode]: [{ "*": [source.expr, scale] }] } },
          reason: "rounded-scale", sourcePaths: sourcePaths(source), origin: source })) return limited();
      }
    }
  }
  return limitCandidates(result);
}

function isLowInformation(value: JsonValue): boolean {
  return value === null || typeof value === "boolean"
    || (typeof value === "number" && Number.isInteger(value) && Math.abs(value) <= 10)
    || (typeof value === "string" && value.length < 4);
}

function positionalReturnPath(value: JsonValue): boolean {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(positionalReturnPath);
  const object = value as JsonObject;
  if (Array.isArray(object.find) && typeof object.find[3] === "string" && /(?:\[\d+\]|\.\d+(?:\.|$))/.test(object.find[3])) return true;
  return Object.values(object).some(positionalReturnPath);
}

/** Pure proposals only: saving, trigger selection, and resolving doubts belong to later use-cases. */
export function inferBindings(trace: Trace, trigger: JsonObject): InferenceResult {
  if (!isJsonValue(trigger) || !isJsonValue(trace)) throw new Error("Inference expects bounded finite JSON");
  const seen = new Set<string>();
  for (const step of trace.steps) {
    if (!isIdentifier(step.id) || step.id.length > 31 || seen.has(step.id)) throw new Error("Trace step IDs must be unique short identifiers");
    if (!step.action || step.input === null || Array.isArray(step.input) || typeof step.input !== "object") throw new Error("Trace steps require an action and argument object");
    seen.add(step.id);
  }
  const sources = [...inferenceSources(trigger, "trigger", trigger)];
  const outputs: Record<string, { output: JsonValue }> = {};
  const context: BindingContext = { trigger, steps: outputs };
  const proposals: BindingProposal[] = [];
  const ambiguities: BindingAmbiguity[] = [];
  const steps: ActionStep[] = [];

  const origins = new Map<string, Source>();
  const infer = (value: JsonValue, stepId: string, argumentPath: string, preferred?: Source): BindingTree => {
    let literals: readonly string[] = [];
    // Money leaves share provenance; an incidental equal money object on a
    // different line must not bypass keyed amount/currency inference.
    const moneyObject = value !== null && typeof value === "object" && !Array.isArray(value) && typeof (value as JsonObject).amountMinor === "number" && typeof (value as JsonObject).currency === "string";
    const exact = preferred ? [preferred] : moneyObject ? [] : sources.filter(source => jsonEqual(source.value, value)).sort((a, b) => a.rank - b.rank);
    let candidates: Candidates = limitCandidates(exact.map(source => ({ binding: sourceBinding(source), reason: "exact-match", sourcePaths: sourcePaths(source), origin: source })));
    if (typeof value === "number" && candidates.values.length) {
      const strongestExact = candidates.values[0]!.origin!.rank;
      const formulas = numericCandidates(value, sources);
      const keyed = formulas.values.filter(candidate => candidate.origin!.rank < strongestExact);
      if (keyed.length) {
        const combined = limitCandidates([...keyed, ...candidates.values]);
        candidates = { ...combined, exhaustive: combined.exhaustive && formulas.exhaustive };
      }
    }
    if (candidates.values.length === 0) {
      if (Array.isArray(value) && value.length > 0) return value.map((item, index) => infer(item, stepId, `${argumentPath}[${index}]`));
      if (value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0) {
        const object = value as JsonObject;
        return Object.fromEntries(Object.keys(value).sort().map(key => {
          const origin = key === "currency" && typeof object.amountMinor === "number" ? origins.get(`${stepId}:${argumentPath}.amountMinor`) : undefined;
          const currency = origin?.money;
          const coherent: Source | undefined = currency && currency.currency === object.currency
            ? { path: origin!.path.replace(/\.amountMinor$/, ".currency"), value: currency.currency, expr: currency.expr, rank: origin!.rank, exhaustive: origin!.exhaustive } : undefined;
          return [key, infer(object[key]!, stepId, `${argumentPath}.${key}`, coherent)];
        }));
      }
      if (typeof value === "number") candidates = numericCandidates(value, sources);
      if (typeof value === "string") { const text = textCandidates(value, sources); candidates = text; literals = text.literals; }
    }
    const fixed: BindingCandidate = { binding: { mode: "fixed", value }, reason: "constant", sourcePaths: [] };
    const origin = candidates.values[0]?.origin;
    if (origin) origins.set(`${stepId}:${argumentPath}`, origin);
    const all = [...candidates.values.map(({ binding, reason, sourcePaths }) => ({ binding, reason, sourcePaths })), fixed];
    const proposed = all[0]!.binding;
    // Check every proposal against the demonstration, including templates and composite paths.
    for (const candidate of all) if (!jsonEqual(resolveBinding(candidate.binding, context), value)) throw new Error("Inferred binding did not reproduce the demonstration");
    proposals.push({ stepId, argumentPath, proposed, candidates: all, exhaustive: candidates.exhaustive });
    const ambiguity = (kind: BindingAmbiguity["kind"]): void => { ambiguities.push({ stepId, argumentPath, kind, candidates: all }); };
    if (candidates.values.length > 1) ambiguity("multiple-candidates");
    const first = candidates.values[0];
    if (first !== undefined && (first.reason !== "exact-match" || isLowInformation(value))) ambiguity("constant-or-variable");
    if (!candidates.exhaustive) ambiguity("candidate-limit");
    const dependencies = proposed.mode === "expr" ? expressionPaths(proposed.expr) : all[0]!.sourcePaths;
    if (dependencies.some(path => pathSegments(path).some(part => /^\d+$/.test(part))) || (proposed.mode === "expr" && positionalReturnPath(proposed.expr))) ambiguity("positional-array");
    if (typeof value === "string") {
      const fragments = requestSpecificFragments(literals, sources);
      if (fragments.length) ambiguities.push({ stepId, argumentPath, kind: "request-specific-text", candidates: all,
        message: "Text may contain request-specific details.", fragments });
    }
    return proposed;
  };

  for (const step of trace.steps) {
    const args = Object.fromEntries(Object.keys(step.input).sort().map((key) => [key, infer(step.input[key]!, step.id, key)]));
    steps.push({ id: step.id, kind: "action", action: step.action, args });
    outputs[step.id] = { output: step.output };
    const root = `steps.${step.id}.output`;
    pathSegments(root);
    sources.push(...inferenceSources(step.output, root, trigger, step.action));
  }
  return immutableSnapshot({ steps, proposals, ambiguities });
}
