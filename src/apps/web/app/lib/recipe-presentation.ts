import type { BacktestResult, Binding, JsonValue } from "@muscle-memory/recipe-engine";

export const words = (value: string) =>
  value
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]/g, " ")
    .toLowerCase()
    .replace(/\b(id|url|api)\b/g, (word) => word.toUpperCase());
export function fieldLabel(value: string) {
  const label = words(value);
  return label.charAt(0).toUpperCase() + label.slice(1);
}
type Translate = (key: string) => string;
export function backtestSummary(summary: BacktestResult["summary"], t: (key: string, values: Record<string, number>) => string) {
  return t("recipes.backtests.counts", { ...summary });
}
export function backtestComparisonLabel(item: { changed: boolean; nonOutcomeOnly: boolean }, t: Translate) {
  return t(item.changed ? "recipes.backtests.outcomeChanged" : item.nonOutcomeOnly ? "recipes.backtests.nonOutcomeOnly" : "recipes.backtests.unchanged");
}

export function stepLabel(step: { kind: string; action?: string | null | undefined }, t?: Translate) {
  const key = step.action ? `shop.teachActions.${step.action}` : `recipes.kinds.${step.kind}`;
  const translated = t?.(key);
  return translated && translated !== key ? translated : fieldLabel(step.action ?? step.kind);
}
export const actionLabel = (action: string, t?: Translate) => stepLabel({ kind: "action", action }, t);

export interface PresentationContext {
  currency?: string | undefined;
  productNames?: Readonly<Record<string, string>> | undefined;
  /** Newest run first, followed by the source demonstration. Historical values only. */
  snapshots?: readonly { trigger: JsonValue; steps: readonly { id: string; input: JsonValue; output: JsonValue }[] }[] | undefined;
}
const shopCurrency = "USD";
const currencyCode = (value: unknown): value is string => typeof value === "string" && /^[A-Z]{3}$/.test(value);
const bounded = (value: string, limit: number) => value.length > limit ? `${value.slice(0, limit - 1)}…` : value;

/** Read saved evidence only: this never executes bindings or recipe expressions. */
type EvidenceStep = { id: string; input: JsonValue; output: JsonValue };
export function presentationContext(
  run?: { trigger: JsonValue; steps: readonly (Omit<EvidenceStep, "id"> & { stepId: string })[] } | null,
  demonstration?: { trigger: JsonValue; steps: readonly EvidenceStep[] } | null,
): PresentationContext {
  const snapshots = [
    ...(run ? [{ trigger: run.trigger, steps: run.steps.map((step) => ({ id: step.stepId, input: step.input, output: step.output })) }] : []),
    ...(demonstration ? [{ trigger: demonstration.trigger, steps: demonstration.steps ?? [] }] : []),
  ];
  const productNames: Record<string, string> = {};
  let currency: string | undefined;
  const collect = (value: JsonValue, depth = 0) => {
    if (!value || typeof value !== "object" || depth > 16) return;
    if (isObject(value)) {
      if (!currency && currencyCode(value.currency)) currency = value.currency;
      if (typeof value.productId === "string" && typeof value.name === "string")
        productNames[value.productId] ??= value.name;
    }
    Object.values(value).forEach((child) => collect(child, depth + 1));
  };
  snapshots.forEach((snapshot) => {
    [...snapshot.steps].reverse().forEach((step) => { collect(step.input); collect(step.output); });
    collect(snapshot.trigger);
  });
  return { currency: currency ?? shopCurrency, productNames, snapshots };
}

export function resolvedCurrency(
  currency: JsonValue | undefined,
  context: PresentationContext = {},
  stepId?: string,
  argument = "amount.amountMinor",
) {
  const code = isObject(currency) && currency.mode === "fixed" ? currency.value : currency;
  if (currencyCode(code)) return code;
  for (const snapshot of context.snapshots ?? []) {
    const step = [...snapshot.steps].reverse().find((step) => step.id === stepId);
    const saved = step && atPath(step.input, [...argument.split(".").slice(0, -1), "currency"]);
    if (currencyCode(saved)) return saved;
    // Path bindings can also be read directly from the historical source snapshot.
    if (isObject(currency) && currency.mode === "path" && typeof currency.path === "string") {
      const sources: JsonValue = { trigger: snapshot.trigger, steps: Object.fromEntries(snapshot.steps.map((step) => [step.id, { output: step.output }])) };
      const saved = atPath(sources, currency.path.replace(/\[(\d+)\]/g, ".$1").split("."));
      if (currencyCode(saved)) return saved;
    }
  }
  return currencyCode(context.currency) ? context.currency : shopCurrency;
}

export function moneyLabel(
  amountMinor: number,
  currency?: JsonValue,
  context: PresentationContext = {},
) {
  const formatter = new Intl.NumberFormat("en-US", {
    style: "currency", currency: resolvedCurrency(currency, context),
  });
  return formatter.format(amountMinor / 10 ** (formatter.resolvedOptions().maximumFractionDigits ?? 2));
}

/** Bounded previews; money and order lines are recognized before nesting limits. */
export function valueSummary(value: JsonValue, context: PresentationContext = {}): string {
  const render = (value: JsonValue, depth: number): string => {
    if (value === null) return "—";
    if (typeof value !== "object") return bounded(String(value), 220);
    if (isObject(value) && typeof value.amountMinor === "number" && typeof value.currency === "string")
      return moneyLabel(value.amountMinor, value.currency, context);
    if (isObject(value) && typeof value.productId === "string" && typeof value.quantity === "number") {
      const name = typeof value.name === "string" ? value.name : context.productNames?.[value.productId] ?? value.productId;
      return `${bounded(name, 120)} × ${value.quantity}${isObject(value.unitPrice) ? ` (${render(value.unitPrice, depth + 1)} each)` : ""}`;
    }
    if (depth > 5) return Array.isArray(value) ? `${value.length} items` : "…";
    if (Array.isArray(value)) return value.slice(0, 3).map((item) => render(item, depth + 1)).join(" · ") + (value.length > 3 ? ` · +${value.length - 3}` : "");
    const preferred = ["body", "amount", "orderId", "requestId", "productId", "tag", "reason", "status", "orderStatus", "note", "id"];
    const rank = (key: string) => preferred.includes(key) ? preferred.indexOf(key) : preferred.length;
    const entries = Object.entries(value).sort(([a], [b]) => rank(a) - rank(b));
    return entries.slice(0, 4).map(([key, child]) => `${fieldLabel(key)}: ${render(child, depth + 1)}`).join(" · ") + (entries.length > 4 ? ` · +${entries.length - 4} fields` : "");
  };
  return bounded(render(value, 0), typeof value === "string" ? 220 : 350);
}

export function mutationSummary(action: string, input: JsonValue, context: PresentationContext = {}, t?: Translate) {
  const name = actionLabel(action, t);
  if (action === "tag-request" && isObject(input) && typeof input.tag === "string") return `${name} “${bounded(input.tag, 120)}”`;
  return bounded(`${name} · ${valueSummary(input, context)}`, 350);
}

function itemPrice(value: JsonValue | undefined): string | undefined {
  if (!isObject(value)) return;
  if (typeof value.var === "string" && /\.unitPrice(?:\.amountMinor)?$/.test(value.var))
    return /items(?:\[0\]|\.0)\./.test(value.var) ? "the first item's unit price" : "the item's unit price";
  if (Array.isArray(value.find) && value.find[1] === "productId" && isObject(value.find[2]) && value.find[2].var === "trigger.productId" && value.find[3] === "unitPrice.amountMinor")
    return "the item's unit price";
}
/** Short choices for decisions; the original binding remains in Source evidence. */
export function candidateLabel(binding: JsonValue | undefined, currency: string, labels: Readonly<Record<string, string>> = {}, money = false): string | undefined {
  if (!isObject(binding)) return;
  if (binding.mode === "fixed") {
    if (typeof binding.value === "number" && money) return `a fixed ${moneyLabel(binding.value, currency)}`;
    return typeof binding.value === "string" ? `fixed text “${bounded(binding.value, 100)}”` : `a fixed ${valueSummary(binding.value ?? null)}`;
  }
  if (binding.mode === "expr") {
    let expr = binding.expr;
    for (let depth = 0; depth < 32 && isObject(expr); depth++) {
      const rounded = expr.round ?? expr.floor ?? expr.ceil;
      if (!Array.isArray(rounded)) break;
      expr = rounded[0];
    }
    if (isObject(expr) && Array.isArray(expr["*"]) && expr["*"].length === 2) {
      const scale = expr["*"].find((part) => typeof part === "number");
      const source = expr["*"].map(itemPrice).find(Boolean);
      if (typeof scale === "number" && source) return `${Number((scale * 100).toFixed(6))}% of ${source}`;
    }
    const price = itemPrice(expr);
    if (price) return price;
    if (isObject(expr) && Array.isArray(expr.cat)) return "a message with values from the request";
    return bounded(expressionLabel(binding.expr ?? null, labels), 120);
  }
  if (binding.mode === "path" && typeof binding.path === "string") {
    const price = itemPrice({ var: binding.path });
    if (price) return price;
    const field = words(binding.path.split(".").slice(-1)[0] ?? "value");
    return binding.path.startsWith("trigger.") ? `the request's ${field}` : `${field} from ${labels[binding.path.split(".")[1] ?? ""] ?? "a previous step"}`;
  }
  if (binding.mode === "template") return "a message template";
}
export function argumentLabel(path: string, action = "") {
  if (path === "amount" || path === "amount.amountMinor")
    return action === "issue-refund" ? "Refund amount" : "Amount";
  const names: Record<string, string> = {
    orderId: "Order ID",
    requestId: "Request ID",
    customerId: "Customer ID",
    template: "Reply",
    "amount.currency": "Currency",
    tag: "Tag",
    reason: "Reason",
    "variables.name": "Customer name",
    "variables.amount": "Reply amount",
  };
  return names[path] ?? fieldLabel(path).replace(/\./g, " · ");
}
export const isObject = (value: unknown): value is Record<string, JsonValue> =>
  Boolean(value && typeof value === "object" && !Array.isArray(value));
export function pathLabel(
  path: string,
  labels: Readonly<Record<string, string>> = {},
) {
  if (path.startsWith("input."))
    return `${argumentLabel(path.slice(6))} · this step`;
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
        : valueSummary(binding.value);
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
