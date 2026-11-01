import { pathSegments, resolveBinding } from "./evaluation.js";
import { immutableSnapshot, isIdentifier, isJsonValue, jsonEqual } from "./json.js";
import type { ActionStep, Binding, BindingContext, BindingTree, JsonObject, JsonValue, Trace } from "./model.js";
import { roundToInteger } from "./rounding.js";

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
  readonly kind: "multiple-candidates" | "constant-or-variable" | "candidate-limit";
  readonly candidates: readonly BindingCandidate[];
}
export interface InferenceResult {
  readonly steps: readonly ActionStep[];
  readonly proposals: readonly BindingProposal[];
  readonly ambiguities: readonly BindingAmbiguity[];
}

interface Source { readonly path: string; readonly value: JsonValue }
interface Candidates { readonly values: readonly BindingCandidate[]; readonly exhaustive: boolean }
const MAX_CANDIDATES = 64;
// Deliberately bounded hypotheses: a single sample cannot justify an arbitrary ratio.
export const INFERENCE_SCALES: readonly number[] = Object.freeze([0.1, 0.2, 0.25, 0.5, 0.75, 0.8, 0.9, 1.1, 1.2, 1.25, 1.5, 2, 3, 4, 10, 100]);

function collectSources(value: JsonValue, path: string): readonly Source[] {
  const result: Source[] = [{ path, value }];
  if (Array.isArray(value)) value.forEach((entry, index) => result.push(...collectSources(entry, `${path}[${index}]`)));
  else if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value).sort()) {
      if (isIdentifier(key)) result.push(...collectSources((value as JsonObject)[key]!, `${path}.${key}`));
    }
  }
  return result;
}

function limitCandidates(candidates: readonly BindingCandidate[]): Candidates {
  const unique = new Map<string, BindingCandidate>();
  for (const candidate of candidates) unique.set(JSON.stringify(candidate.binding), candidate);
  return { values: [...unique.values()].slice(0, MAX_CANDIDATES), exhaustive: unique.size <= MAX_CANDIDATES };
}

function numericCandidates(value: number, sources: readonly Source[]): Candidates {
  const numbers = sources.filter((source): source is Source & { value: number } => typeof source.value === "number");
  const result: BindingCandidate[] = [];
  // Exact scale candidates precede differences, and source traversal order is stable.
  for (const source of numbers) {
    for (const scale of INFERENCE_SCALES) {
      if (source.value !== 0 && source.value * scale === value) {
        result.push({ binding: { mode: "expr", expr: { "*": [{ var: source.path }, scale] } }, reason: "scale", sourcePaths: [source.path] });
        if (result.length > MAX_CANDIDATES) return { values: result.slice(0, MAX_CANDIDATES), exhaustive: false };
      }
    }
  }
  const byValue = new Map<number, typeof numbers>();
  for (const source of numbers) {
    const group = byValue.get(source.value) ?? [];
    group.push(source);
    byValue.set(source.value, group);
  }
  for (const left of numbers) {
    for (const right of byValue.get(left.value - value) ?? []) {
      if (left.path !== right.path && right.value !== 0 && left.value - right.value === value) {
        const binding: Binding = { mode: "expr", expr: { "-": [{ var: left.path }, { var: right.path }] } };
        result.push({ binding, reason: "difference", sourcePaths: [left.path, right.path] });
        if (result.length > MAX_CANDIDATES) return { values: result.slice(0, MAX_CANDIDATES), exhaustive: false };
      }
    }
  }
  // Prefer all unrounded formulas before considering integer rounding of a scale.
  if (Number.isInteger(value)) {
    for (const source of numbers) {
      for (const scale of INFERENCE_SCALES) {
        const product = source.value * scale;
        if (source.value === 0 || product === value || !Number.isFinite(product)) continue;
        for (const mode of ["round", "floor", "ceil"] as const) {
          if (roundToInteger(product, mode) !== value) continue;
          result.push({
            binding: { mode: "expr", expr: { [mode]: [{ "*": [{ var: source.path }, scale] }] } },
            reason: "rounded-scale", sourcePaths: [source.path],
          });
          if (result.length > MAX_CANDIDATES) return { values: result.slice(0, MAX_CANDIDATES), exhaustive: false };
        }
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

function textCandidates(value: string, sources: readonly Source[]): Candidates {
  // Literal placeholder syntax cannot be safely mixed with inferred placeholders.
  if (value.includes("{{") || value.includes("}}")) return { values: [], exhaustive: true };
  const tokens = new Map<string, string[]>();
  for (const source of sources) {
    if (typeof source.value !== "string" && typeof source.value !== "number") continue;
    const token = String(source.value);
    if (token.length === 0 || !value.includes(token)) continue;
    const paths = tokens.get(token) ?? [];
    paths.push(source.path);
    tokens.set(token, paths);
  }
  // Prefer longest non-overlapping whole tokens; do not infer "20" inside "1200".
  const orderedTokens = [...tokens.keys()].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  const parts: (string | { token: string })[] = [];
  const used = new Set<string>();
  let literal = "";
  for (let i = 0; i < value.length;) {
    const token = orderedTokens.find((candidate) => {
      if (!value.startsWith(candidate, i)) return false;
      const word = (char: string | undefined): boolean => char !== undefined && /[A-Za-z0-9_]/.test(char);
      return !(word(candidate[0]) && word(value[i - 1])) && !(word(candidate[candidate.length - 1]) && word(value[i + candidate.length]));
    });
    if (token === undefined) { literal += value[i]!; i++; continue; }
    if (literal) { parts.push(literal); literal = ""; }
    parts.push({ token });
    used.add(token);
    i += token.length;
  }
  if (literal) parts.push(literal);
  if (used.size === 0) return { values: [], exhaustive: true };
  let assignments: ReadonlyMap<string, string>[] = [new Map()];
  let exhaustive = true;
  for (const token of used) {
    const expanded: ReadonlyMap<string, string>[] = [];
    for (const assignment of assignments) {
      for (const path of tokens.get(token)!) {
        if (expanded.length < MAX_CANDIDATES) expanded.push(new Map([...assignment, [token, path]]));
        else exhaustive = false;
      }
    }
    assignments = expanded;
  }
  return {
    values: assignments.map((assignment) => ({
      binding: { mode: "template", template: parts.map((part) => typeof part === "string" ? part : `{{${assignment.get(part.token)!}}}`).join("") },
      reason: "template", sourcePaths: [...new Set(assignment.values())],
    })),
    exhaustive,
  };
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
  const sources = [...collectSources(trigger, "trigger")];
  const outputs: Record<string, { output: JsonValue }> = {};
  const context: BindingContext = { trigger, steps: outputs };
  const proposals: BindingProposal[] = [];
  const ambiguities: BindingAmbiguity[] = [];
  const steps: ActionStep[] = [];

  const infer = (value: JsonValue, stepId: string, argumentPath: string): BindingTree => {
    let candidates: Candidates = limitCandidates(sources.filter((source) => jsonEqual(source.value, value)).map((source) => ({
      binding: { mode: "path", path: source.path }, reason: "exact-match", sourcePaths: [source.path],
    })));
    if (candidates.values.length === 0) {
      if (Array.isArray(value) && value.length > 0) return value.map((item, index) => infer(item, stepId, `${argumentPath}[${index}]`));
      if (value !== null && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length > 0) {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, infer((value as JsonObject)[key]!, stepId, `${argumentPath}.${key}`)]));
      }
      if (typeof value === "number") candidates = numericCandidates(value, sources);
      if (typeof value === "string") candidates = textCandidates(value, sources);
    }
    const fixed: BindingCandidate = { binding: { mode: "fixed", value }, reason: "constant", sourcePaths: [] };
    const all = [...candidates.values, fixed];
    const proposed = all[0]!.binding;
    // Check every proposal against the demonstration, including templates and composite paths.
    if (!jsonEqual(resolveBinding(proposed, context), value)) throw new Error("Inferred binding did not reproduce the demonstration");
    proposals.push({ stepId, argumentPath, proposed, candidates: all, exhaustive: candidates.exhaustive });
    const ambiguity = (kind: BindingAmbiguity["kind"]): void => { ambiguities.push({ stepId, argumentPath, kind, candidates: all }); };
    if (candidates.values.length > 1) ambiguity("multiple-candidates");
    const first = candidates.values[0];
    if (first !== undefined && (first.reason !== "exact-match" || isLowInformation(value))) ambiguity("constant-or-variable");
    if (!candidates.exhaustive) ambiguity("candidate-limit");
    return proposed;
  };

  for (const step of trace.steps) {
    const args = Object.fromEntries(Object.keys(step.input).sort().map((key) => [key, infer(step.input[key]!, step.id, key)]));
    steps.push({ id: step.id, kind: "action", action: step.action, args });
    outputs[step.id] = { output: step.output };
    const root = `steps.${step.id}.output`;
    pathSegments(root);
    sources.push(...collectSources(step.output, root));
  }
  return immutableSnapshot({ steps, proposals, ambiguities });
}
