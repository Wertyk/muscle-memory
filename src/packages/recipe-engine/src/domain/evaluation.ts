import { hasOwn, isJsonValue, isSafeKey } from "./json.js";
import type { Binding, BindingContext, BindingTree, Expression, JsonObject, JsonValue } from "./model.js";
import { roundToInteger } from "./rounding.js";

export class EvaluationError extends Error {
  override name = "EvaluationError";
}

export function pathSegments(path: string): readonly string[] {
  if (!/^(?:[A-Za-z_][A-Za-z0-9_-]*)(?:\.[A-Za-z0-9_-]+|\[(?:0|[1-9][0-9]*)\])*$/.test(path)) throw new EvaluationError(`Invalid path: ${path}`);
  const parts = path.replace(/\[([0-9]+)\]/g, ".$1").split(".");
  if (parts.some((part) => !isSafeKey(part))) throw new EvaluationError("Unsafe path segment");
  if (parts[0] !== "trigger" && !(parts[0] === "steps" && parts.length >= 3 && parts[2] === "output")) throw new EvaluationError("Paths must reference trigger or steps.<id>.output");
  return parts;
}

export function readPath(context: BindingContext, path: string): JsonValue | undefined {
  let value: unknown = context;
  for (const part of pathSegments(path)) {
    if (value === null || typeof value !== "object" || !hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value as JsonValue | undefined;
}

export function templatePaths(template: string): readonly string[] {
  const paths: string[] = [];
  const remaining = template.replace(/\{\{([^{}]+)\}\}/g, (_match, raw: string) => {
    const path = raw.trim();
    pathSegments(path);
    paths.push(path);
    return "";
  });
  if (remaining.includes("{{") || remaining.includes("}}")) throw new EvaluationError("Malformed template placeholder");
  return paths;
}

const arities: Readonly<Record<string, readonly [number, number]>> = {
  "==": [2, 2], "!=": [2, 2], "===": [2, 2], "!==": [2, 2],
  ">": [2, 2], ">=": [2, 2], "<": [2, 3], "<=": [2, 3],
  "+": [1, 64], "-": [1, 2], "*": [1, 64], "/": [2, 2], "%": [2, 2],
  min: [1, 64], max: [1, 64], and: [1, 64], or: [1, 64], "!": [1, 1], "!!": [1, 1],
  if: [3, 63], cat: [1, 64], in: [2, 2],
  round: [1, 1], floor: [1, 1], ceil: [1, 1],
};

/** Validates both shape and operator/path allowlists, and returns all dependencies. */
export function expressionPaths(expression: unknown): readonly string[] {
  if (!isJsonValue(expression)) throw new EvaluationError("Expression must be bounded finite JSON");
  const paths: string[] = [];
  let nodes = 0;
  const visit = (value: JsonValue, depth: number): void => {
    if (++nodes > 1024 || depth > 32) throw new EvaluationError("Expression complexity limit exceeded");
    if (value === null || typeof value !== "object") return;
    if (Array.isArray(value)) { value.forEach((v) => visit(v, depth + 1)); return; }
    const entries = Object.entries(value);
    if (entries.length !== 1) throw new EvaluationError("An expression object must have one operator");
    const [operator, raw] = entries[0]!;
    if (operator === "var") {
      const args = Array.isArray(raw) ? raw : [raw];
      if (args.length < 1 || args.length > 2 || typeof args[0] !== "string") throw new EvaluationError("var expects a path and optional default");
      pathSegments(args[0]);
      paths.push(args[0]);
      if (args.length === 2) visit(args[1]!, depth + 1);
      return;
    }
    if (!hasOwn(arities, operator)) throw new EvaluationError(`Unsupported operator: ${operator}`);
    const args = Array.isArray(raw) ? raw : [raw];
    const [min, max] = arities[operator]!;
    if (args.length < min || args.length > max || (operator === "if" && args.length % 2 === 0)) throw new EvaluationError(`Invalid arity for ${operator}`);
    args.forEach((v) => visit(v, depth + 1));
  };
  visit(expression, 0);
  return paths;
}

/** JSONLogic truthiness: an empty array is false (unlike JavaScript). */
export function logicTruthy(value: JsonValue): boolean {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}

export function evaluateExpression(expression: Expression, context: BindingContext): JsonValue {
  expressionPaths(expression);
  const numeric = (value: JsonValue): number => {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new EvaluationError("Arithmetic expects finite numbers");
    return value;
  };
  const finite = (value: number): number => {
    if (!Number.isFinite(value)) throw new EvaluationError("Non-finite arithmetic result");
    return value;
  };
  const scalar = (value: JsonValue): string => {
    if (value !== null && typeof value === "object") throw new EvaluationError("Expected a scalar");
    return value === null ? "" : String(value);
  };
  const compare = (a: JsonValue, b: JsonValue, inclusive: boolean): boolean => {
    if (!(typeof a === "number" && typeof b === "number") && !(typeof a === "string" && typeof b === "string")) throw new EvaluationError("Comparison expects two numbers or two strings");
    return inclusive ? a <= b : a < b;
  };
  const run = (value: Expression): JsonValue => {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(run);
    const [operator, raw] = Object.entries(value)[0]!;
    const args = Array.isArray(raw) ? raw : [raw];
    if (operator === "var") {
      const found = readPath(context, args[0] as string);
      return found === undefined ? (args.length === 2 ? run(args[1]!) : null) : found;
    }
    if (operator === "if") {
      for (let i = 0; i < args.length - 1; i += 2) if (logicTruthy(run(args[i]!))) return run(args[i + 1]!);
      return run(args[args.length - 1]!);
    }
    if (operator === "and" || operator === "or") {
      let result: JsonValue = null;
      for (const arg of args) {
        result = run(arg);
        if (logicTruthy(result) === (operator === "or")) return result;
      }
      return result;
    }
    const values = args.map(run);
    const a = values[0]!;
    const b = values[1]!;
    switch (operator) {
      // Loose equality is restricted to JSON scalars; no JS object coercion/hooks.
      case "==": case "!=": {
        const isScalar = (v: JsonValue): boolean => v !== null && typeof v !== "object";
        const equal = a === b || (isScalar(a) && isScalar(b) && typeof a !== typeof b && Number(a) === Number(b));
        return operator === "==" ? equal : !equal;
      }
      case "===": return a === b;
      case "!==": return a !== b;
      case "<": case "<=": return compare(a, b, operator === "<=") && (values.length < 3 || compare(b, values[2]!, operator === "<="));
      case ">": return compare(b, a, false);
      case ">=": return compare(b, a, true);
      case "!": return !logicTruthy(a);
      case "!!": return logicTruthy(a);
      case "+": return finite(values.reduce<number>((sum, v) => sum + numeric(v), 0));
      case "*": return finite(values.reduce<number>((product, v) => product * numeric(v), 1));
      case "-": return finite(values.length === 1 ? -numeric(a) : numeric(a) - numeric(b));
      case "/": return finite(numeric(a) / numeric(b));
      case "%": return finite(numeric(a) % numeric(b));
      case "round": case "floor": case "ceil": return roundToInteger(numeric(a), operator);
      case "min": return Math.min(...values.map(numeric));
      case "max": return Math.max(...values.map(numeric));
      case "cat": return values.map(scalar).join("");
      case "in": return typeof b === "string" ? b.includes(scalar(a)) : Array.isArray(b) && b.includes(a);
      default: throw new EvaluationError(`Unsupported operator: ${operator}`);
    }
  };
  return run(expression);
}

export function evaluateCondition(expression: Expression, context: BindingContext): boolean {
  return logicTruthy(evaluateExpression(expression, context));
}

export function resolveBinding(binding: Binding, context: BindingContext): JsonValue {
  switch (binding.mode) {
    case "fixed": return binding.value;
    case "path": {
      const value = readPath(context, binding.path);
      if (value === undefined) throw new EvaluationError(`Missing binding path: ${binding.path}`);
      return value;
    }
    case "expr": return evaluateExpression(binding.expr, context);
    case "template": {
      templatePaths(binding.template);
      return binding.template.replace(/\{\{([^{}]+)\}\}/g, (_match, raw: string) => {
        const value = readPath(context, raw.trim());
        if (value === undefined) throw new EvaluationError(`Missing template path: ${raw.trim()}`);
        if (value !== null && typeof value === "object") throw new EvaluationError("Templates require scalar values");
        return value === null ? "" : String(value);
      });
    }
  }
}

export function isBinding(tree: BindingTree): tree is Binding {
  return !Array.isArray(tree) && typeof (tree as { mode?: unknown }).mode === "string";
}

export function resolveBindingTree(tree: BindingTree, context: BindingContext): JsonValue {
  if (isBinding(tree)) return resolveBinding(tree, context);
  if (Array.isArray(tree)) return tree.map((item) => resolveBindingTree(item, context));
  return Object.fromEntries(Object.entries(tree).map(([key, value]) => [key, resolveBindingTree(value, context)]));
}

export function resolveArguments(args: Readonly<Record<string, BindingTree>>, context: BindingContext): JsonObject {
  return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, resolveBindingTree(value, context)]));
}
