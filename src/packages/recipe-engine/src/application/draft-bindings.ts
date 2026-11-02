import { expressionPaths, isBinding, pathSegments, readPath, resolveBindingTree, templatePaths } from "../domain/evaluation.js";
import type { Demonstration } from "../domain/demonstration.js";
import type { BindingCandidate, InferenceResult } from "../domain/inference.js";
import { jsonEqual } from "../domain/json.js";
import type { ActionStep, Binding, BindingTree, Expression, JsonObject, JsonValue } from "../domain/model.js";

export function bindingPaths(tree: BindingTree): readonly string[] {
  if (!isBinding(tree)) return Object.values(tree).flatMap(bindingPaths);
  switch (tree.mode) {
    case "fixed": return [];
    case "path": return [tree.path];
    case "expr": return expressionPaths(tree.expr);
    case "template": return templatePaths(tree.template);
  }
}

function candidateReason(binding: Binding, fallback: BindingCandidate["reason"]): BindingCandidate["reason"] {
  if (binding.mode === "template") return "template";
  if (binding.mode !== "expr" || binding.expr === null || typeof binding.expr !== "object") return fallback;
  if ("cat" in binding.expr) return "template";
  if ("round" in binding.expr || "floor" in binding.expr || "ceil" in binding.expr) return "rounded-scale";
  if ("*" in binding.expr) return "scale";
  if ("-" in binding.expr) return "difference";
  return fallback;
}

/** A copied mutation input is a provenance hypothesis, never a simulated output.
 * Keep generated result values dependent on the mutation. Preserve the original
 * candidate and surface every substitution for review in the ambiguity list. */
export function rebaseMutationInputs(inference: InferenceResult, demo: Demonstration, effects: ReadonlyMap<string, string>) {
  const context = { trigger: demo.trigger, steps: Object.fromEntries(demo.steps.map(step => [step.id, { output: step.output }])) };
  const copies = new Map<string, readonly { value: JsonValue; binding: BindingTree }[]>();
  const substitutions = new Set<string>();
  const ambiguities = [...inference.ambiguities];
  const replacement = (path: string): Binding => {
    const parts = pathSegments(path);
    const value = readPath(context, path);
    const copy = parts[0] === "steps" && value !== undefined
      ? copies.get(parts[1]!)?.find(candidate => jsonEqual(candidate.value, value)) : undefined;
    if (copy && isBinding(copy.binding)) { substitutions.add(path); return copy.binding; }
    return { mode: "path", path };
  };
  const asExpression = (tree: Binding): Expression => {
    switch (tree.mode) {
      case "path": return { var: tree.path };
      case "expr": return tree.expr;
      case "fixed": return tree.value;
      case "template": return templateExpression(tree.template);
    }
  };
  const templateExpression = (template: string): Expression => {
    const parts: Expression[] = [];
    let start = 0;
    for (const match of template.matchAll(/\{\{([^{}]+)\}\}/g)) {
      if (match.index! > start) parts.push(template.slice(start, match.index));
      parts.push(asExpression(replacement(match[1]!.trim())));
      start = match.index! + match[0].length;
    }
    if (start < template.length) parts.push(template.slice(start));
    return { cat: parts };
  };
  const expression = (value: Expression): Expression => {
    if (Array.isArray(value)) return value.map(expression);
    if (value === null || typeof value !== "object") return value;
    const object = value as JsonObject;
    if (typeof object.var === "string") return asExpression(replacement(object.var));
    // Inference emits plain var paths, not var defaults.
    return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, expression(child)]));
  };
  const rewrite = (tree: BindingTree): BindingTree => {
    if (!isBinding(tree)) return Array.isArray(tree) ? tree.map(rewrite)
      : Object.fromEntries(Object.entries(tree).map(([key, child]) => [key, rewrite(child)]));
    switch (tree.mode) {
      case "fixed": return tree;
      case "path": return replacement(tree.path);
      case "expr": return { mode: "expr", expr: expression(tree.expr) };
      case "template": {
        const replacements = templatePaths(tree.template).map(path => replacement(path));
        if (replacements.every(item => isBinding(item) && item.mode === "path")) {
          let index = 0;
          return { mode: "template", template: tree.template.replace(/\{\{[^{}]+\}\}/g, () => `{{${(replacements[index++] as Binding & { mode: "path" }).path}}}`) };
        }
        return { mode: "expr", expr: templateExpression(tree.template) };
      }
    }
  };
  const steps: ActionStep[] = [];
  for (const [index, step] of inference.steps.entries()) {
    const rewritten = { ...step, args: Object.fromEntries(Object.entries(step.args).map(([key, tree]) => [key, rewrite(tree)])) };
    steps.push(rewritten);
    // Evidence check: a substitution must still reproduce every original input.
    for (const [key, tree] of Object.entries(rewritten.args)) {
      if (!jsonEqual(resolveBindingTree(tree, context), demo.steps[index]!.input[key]!)) throw new Error("Rebased binding changed the demonstration.");
    }
    for (const proposal of inference.proposals.filter(item => item.stepId === step.id)) {
      const sources = proposal.candidates[0]?.sourcePaths ?? [];
      if (!sources.some(path => substitutions.has(path))) continue;
      const changed = rewrite(proposal.proposed);
      if (!isBinding(changed)) continue;
      const reason = candidateReason(changed, proposal.candidates[0]!.reason);
      const candidate: BindingCandidate = { binding: changed, reason, sourcePaths: bindingPaths(changed) };
      const evidence = { stepId: step.id, argumentPath: proposal.argumentPath, candidates: [candidate, ...proposal.candidates] };
      ambiguities.push({ ...evidence, kind: "multiple-candidates" });
      if ((changed.mode === "expr" || changed.mode === "template") && !ambiguities.some(item => item.stepId === step.id && item.argumentPath === proposal.argumentPath && item.kind === "constant-or-variable")) {
        ambiguities.push({ ...evidence, kind: "constant-or-variable" });
      }
    }
    if (effects.get(step.id) === "mutation") {
      const values: { value: JsonValue; binding: BindingTree }[] = [];
      const collect = (value: JsonValue, tree: BindingTree) => {
        values.push({ value, binding: tree });
        if (isBinding(tree) || value === null || typeof value !== "object") return;
        for (const [key, child] of Object.entries(tree)) collect((value as JsonObject)[key]!, child);
      };
      for (const [key, tree] of Object.entries(rewritten.args)) collect(demo.steps[index]!.input[key]!, tree);
      copies.set(step.id, values);
    }
  }
  return { steps, ambiguities };
}
