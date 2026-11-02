import type { Binding, JsonValue } from "@muscle-memory/recipe-engine";
import {
  IconBraces,
  IconLink,
  IconArrowRight,
  IconCoins,
} from "@tabler/icons-react";

import {
  bindingLabel,
  expressionLabel,
  isObject,
  pathLabel,
  wireSource,
} from "@/lib/recipe-studio";

interface MessagePart {
  text?: string;
  binding?: Binding;
}
export function messageParts(
  binding: Binding,
  variables?: JsonValue,
): MessagePart[] | null {
  if (
    binding.mode === "expr" &&
    isObject(binding.expr) &&
    binding.expr.cat !== undefined
  ) {
    const parts: MessagePart[] = [];
    const visit = (value: JsonValue, depth: number) => {
      if (depth > 32) return;
      if (isObject(value) && value.cat !== undefined) {
        for (const child of Array.isArray(value.cat) ? value.cat : [value.cat])
          visit(child, depth + 1);
      } else if (value === null || typeof value !== "object")
        parts.push({ text: value === null ? "" : String(value) });
      else parts.push({ binding: { mode: "expr", expr: value } });
    };
    visit(binding.expr, 0);
    return parts;
  }
  const template =
    binding.mode === "template"
      ? binding.template
      : binding.mode === "fixed" &&
          typeof binding.value === "string" &&
          variables !== undefined
        ? binding.value
        : undefined;
  if (typeof template !== "string") return null;
  const parts: MessagePart[] = [];
  let cursor = 0;
  for (const match of template.matchAll(/\{\{([^{}]+)\}\}/g)) {
    const index = match.index ?? 0;
    if (index > cursor) parts.push({ text: template.slice(cursor, index) });
    const path = match[1]!.trim();
    if (binding.mode === "template")
      parts.push({ binding: { mode: "path", path } });
    else {
      const variable = isObject(variables) ? variables[path] : undefined;
      if (isObject(variable) && typeof variable.mode === "string")
        parts.push({ binding: variable as unknown as Binding });
      else parts.push({ text: match[0] });
    }
    cursor = index + match[0].length;
  }
  parts.push({ text: template.slice(cursor) });
  return parts;
}
function stepRecords(
  value: JsonValue | undefined,
): Record<string, JsonValue>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((step) =>
    isObject(step)
      ? [step, ...stepRecords(step.then), ...stepRecords(step.else)]
      : [],
  );
}
function dynamicLabel(
  binding: Binding,
  steps: JsonValue | undefined,
  labels: Readonly<Record<string, string>>,
) {
  const expr =
    binding.mode === "expr" && isObject(binding.expr)
      ? binding.expr
      : undefined;
  if (expr?.firstWord !== undefined) {
    const operand = Array.isArray(expr.firstWord)
      ? expr.firstWord[0]
      : expr.firstWord;
    const path =
      isObject(operand) && typeof operand.var === "string" ? operand.var : "";
    return path.endsWith(".name")
      ? `First name · ${path.includes("shippingAddress") ? "recipient" : "customer"}`
      : "First word";
  }
  if (expr?.money !== undefined) {
    const operands = Array.isArray(expr.money) ? expr.money : [expr.money];
    const refund = stepRecords(steps).find((step) => {
      if (step.action !== "issue-refund" || !isObject(step.args)) return false;
      const amount = step.args.amount;
      const minor = isObject(amount) ? amount.amountMinor : undefined;
      return (
        isObject(minor) &&
        minor.mode === "expr" &&
        JSON.stringify(minor.expr) === JSON.stringify(operands[0])
      );
    });
    const amountPath =
      isObject(operands[0]) && typeof operands[0].var === "string"
        ? operands[0].var
        : "";
    const refundOutput = stepRecords(steps).some(
      (step) =>
        step.action === "issue-refund" &&
        amountPath === `steps.${step.id}.output.amount.amountMinor`,
    );
    return refund || refundOutput ? "Refund amount" : "Formatted amount";
  }
  const path =
    binding.mode === "path"
      ? binding.path
      : typeof expr?.var === "string"
        ? expr.var
        : undefined;
  if (typeof path === "string" && path) {
    const source = stepRecords(steps).find(
      (step) => step.id === path.split(".")[1],
    );
    if (
      source?.action === "issue-refund" &&
      path.endsWith(".amount.amountMinor")
    )
      return "Refund amount (minor units)";
    return pathLabel(path, labels);
  }
  return bindingLabel(binding, labels);
}
export function MessagePreview({
  parts,
  labels,
  steps,
  source,
}: {
  parts: readonly MessagePart[];
  labels: Readonly<Record<string, string>>;
  steps?: JsonValue | undefined;
  source?: string;
}) {
  return (
    <span className="recipe-message" data-source={source}>
      {parts.map((part, index) => {
        if (!part.binding) return <span key={index}>{part.text}</span>;
        const source = wireSource(part.binding);
        const label = dynamicLabel(part.binding, steps, labels);
        const full =
          part.binding.mode === "expr"
            ? expressionLabel(part.binding.expr, labels)
            : bindingLabel(part.binding, labels);
        const money =
          part.binding.mode === "expr" &&
          isObject(part.binding.expr) &&
          part.binding.expr.money !== undefined;
        const Icon = money
          ? IconCoins
          : source === "trigger"
            ? IconLink
            : source === "output"
              ? IconArrowRight
              : IconBraces;
        return (
          <span
            key={index}
            className="recipe-wire recipe-inline-wire"
            data-source={source}
            title={full}
            aria-label={full}
          >
            <span className="recipe-wire-source">
              <Icon className="size-3" aria-hidden="true" />
            </span>
            <span className="recipe-wire-value">{label}</span>
          </span>
        );
      })}
    </span>
  );
}
