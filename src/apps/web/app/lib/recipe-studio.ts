import type {
  Binding,
  JsonValue,
  RecipeStudio,
} from "@muscle-memory/recipe-engine";

export type RecipeSummary = Awaited<ReturnType<RecipeStudio["list"]>>[number];
export type RecipeDetail = Awaited<ReturnType<RecipeStudio["get"]>>;
export type RecipeDraft = Awaited<ReturnType<RecipeStudio["getDraft"]>>;
export const RECIPES_PATH = "/recipes";
export const recipePath = (id: string) => `/recipes/${encodeURIComponent(id)}`;
export function recipeIdFromPath(path: string) {
  const match = path.match(/^\/recipes\/([^/]+)\/?$/)?.[1];
  try {
    return match ? decodeURIComponent(match) : undefined;
  } catch {
    return undefined;
  }
}
export const words = (value: string) =>
  value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .replace(/\bId\b/g, "ID");
export const isObject = (value: unknown): value is Record<string, JsonValue> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
export function pathLabel(
  path: string,
  labels: Readonly<Record<string, string>> = {},
) {
  const source = path.startsWith("trigger.")
    ? "Request"
    : (labels[path.split(".")[1] ?? ""] ?? words(path.split(".")[1] ?? "Step"));
  const tail = path
    .replace(/^trigger\.?|^steps\.[^.]+\.output\.?/g, "")
    .replace(/\[0\]|\.0(?=\.|$)/g, " · first item")
    .replace(/\[(\d+)\]/g, " · item $1")
    .split(".")
    .filter(Boolean)
    .map(words)
    .join(" → ");
  return `${tail || "Output"} · ${source}`;
}
const infix: Record<string, string> = {
  "===": "is",
  "==": "equals",
  "!==": "is not",
  "!=": "does not equal",
  "*": "×",
  "/": "÷",
  "+": "+",
  "-": "−",
  "%": "mod",
  ">": ">",
  ">=": "≥",
  "<": "<",
  "<=": "≤",
  and: "and",
  or: "or",
  in: "is in",
};
/** Display only. All execution and allowlist validation remain in recipe-engine. */
export function expressionLabel(
  value: JsonValue,
  labels: Readonly<Record<string, string>> = {},
  depth = 0,
): string {
  if (depth > 32) return "…";
  const render = (v: JsonValue) => expressionLabel(v, labels, depth + 1);
  if (typeof value === "string") {
    const categories: Record<string, string> = {
      damaged_item: "Damaged item",
      where_is_my_order: "Delivery question",
      address_change: "Address change",
      wholesale_inquiry: "Wholesale inquiry",
    };
    return `“${categories[value] ?? value}”`;
  }
  if (value === true) return "Always";
  if (value === false) return "Never";
  if (value === null) return "Empty";
  if (typeof value !== "object") return String(value);
  if (Array.isArray(value)) return value.map(render).join(", ");
  const [op, raw] = Object.entries(value)[0] ?? ["", null];
  const args = Array.isArray(raw) ? raw : [raw];
  if (op === "var")
    return typeof args[0] === "string"
      ? pathLabel(args[0], labels) +
          (args.length > 1 ? ` (default ${render(args[1]!)})` : "")
      : "Missing source";
  if (op === "find" && args.length === 4) {
    const damaged =
      args[1] === "productId" &&
      isObject(args[2]) &&
      args[2].var === "trigger.productId";
    const field =
      args[3] === "unitPrice.amountMinor"
        ? "unit price"
        : words(String(args[3] ?? "value")).replace(/\./g, " → ");
    return damaged
      ? `${field} of the line matching productId · ${render(args[0]!)}`
      : `${field} of item in ${render(args[0]!)} where ${words(String(args[1]))} is ${render(args[2]!)}`;
  }
  if (op === "firstWord") {
    const path = isObject(args[0]) ? args[0].var : undefined;
    return `${typeof path === "string" && path.endsWith(".name") ? "First name" : "First word"} of ${render(args[0] ?? null)}`;
  }
  if (op === "money") {
    if (args[2] === "decimal")
      return `Decimal amount of ${render(args[0] ?? null)} in ${render(args[1] ?? null)}`;
    return args[1] === "USD"
      ? `$ amount of ${render(args[0] ?? null)}`
      : `Money amount of ${render(args[0] ?? null)} in ${render(args[1] ?? null)}`;
  }
  if (op === "cat") return args.map(render).join(" + ");
  if (op === "!" || op === "!!")
    return `${op === "!" ? "Not" : "Is true"} (${args.map(render).join(", ")})`;
  if (op === "-" && args.length === 1) return `−(${render(args[0]!)})`;
  if (op === "if")
    return args
      .map(
        (arg, i) =>
          `${i === args.length - 1 ? "otherwise" : i % 2 === 0 ? "if" : "then"} ${render(arg)}`,
      )
      .join(" · ");
  if (infix[op]) {
    const parts = args.map((arg) =>
      op === "*" && typeof arg === "number" && arg > 0 && arg < 1
        ? `${Number((arg * 100).toFixed(6))}%`
        : render(arg),
    );
    if (op === "*" && parts.length > 1)
      parts.sort((a, b) => Number(b.endsWith("%")) - Number(a.endsWith("%")));
    const text = parts.join(` ${infix[op]} `);
    return depth > 0 && args.length > 1 ? `(${text})` : text;
  }
  const names: Record<string, string> = {
    round: "Round",
    floor: "Round down",
    ceil: "Round up",
    min: "Minimum",
    max: "Maximum",
  };
  return `${names[op] ?? words(op)}(${args.map(render).join(", ")})`;
}

export function differenceLabel(
  pointer: string,
  content: JsonValue,
  labels: Readonly<Record<string, string>> = {},
) {
  const segments = pointer
    .split("/")
    .slice(1)
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
  const path: (string | number)[] = [];
  return segments
    .map((part) => {
      path.push(part);
      const value = atPath(content, path);
      if (/^\d+$/.test(part) && isObject(value) && typeof value.id === "string")
        return labels[value.id] ?? `Step ${Number(part) + 1}`;
      if (part === "then") return "If true";
      if (part === "else") return "Otherwise";
      return (
        (
          {
            steps: "Steps",
            args: "Arguments",
            approval: "Approval",
            trigger: "Trigger",
            expr: "Formula",
            match: "Match",
            name: "Name",
          } as Record<string, string>
        )[part] ?? words(part)
      );
    })
    .join(" → ");
}
export type WireSource =
  | "trigger"
  | "output"
  | "constant"
  | "formula"
  | "template";
export function wireSource(binding: Binding): WireSource {
  return binding.mode === "path"
    ? String(binding.path).startsWith("trigger")
      ? "trigger"
      : "output"
    : binding.mode === "fixed"
      ? "constant"
      : binding.mode === "expr"
        ? "formula"
        : "template";
}
export function bindingLabel(
  binding: Binding,
  labels: Readonly<Record<string, string>> = {},
) {
  switch (binding.mode) {
    case "path":
      return pathLabel(String(binding.path ?? ""), labels);
    case "expr":
      return expressionLabel(binding.expr, labels);
    case "template":
      return String(binding.template ?? "");
    case "fixed":
      return typeof binding.value === "string"
        ? binding.value
        : JSON.stringify(binding.value);
  }
}
export function atPath(
  content: JsonValue,
  path: readonly (string | number)[],
): JsonValue | undefined {
  let value: unknown = content;
  for (const part of path) {
    if (
      !value ||
      typeof value !== "object" ||
      !Object.prototype.hasOwnProperty.call(value, part)
    )
      return undefined;
    value = (value as Record<string | number, unknown>)[part];
  }
  return value as JsonValue;
}
export function replaceAtPath(
  content: JsonValue,
  path: readonly (string | number)[],
  value: JsonValue,
): JsonValue {
  if (!path.length) return value;
  const copy = structuredClone(content) as Record<string | number, JsonValue>;
  let target = copy;
  for (const key of path.slice(0, -1))
    target = target[key] as Record<string | number, JsonValue>;
  target[path[path.length - 1]!] = value;
  return copy as JsonValue;
}
