import type { JsonValue } from "@muscle-memory/recipe-engine";

import { moneyCurrency, moneyLabel } from "./recipe-money";
import { argumentLabel, expressionLabel, isObject } from "./recipe-studio";

export interface ApprovalArgument {
  path: string;
  label: string;
  kind: "money" | "number" | "text" | "boolean";
}
export const approvalOperators = [">", ">=", "<", "<=", "===", "!=="] as const;
export type ApprovalOperator = (typeof approvalOperators)[number];
export interface ApprovalChoice {
  mode: "never" | "always" | "when" | "advanced";
  argument: string;
  operator: ApprovalOperator;
  value: string;
}
export function approvalArguments(
  step: Record<string, JsonValue>,
): ApprovalArgument[] {
  const args =
    step.kind === "action" && isObject(step.args)
      ? step.args
      : step.kind === "extract"
        ? { text: null }
        : step.kind === "handoff"
          ? { to: null, note: null }
          : {};
  const fields: ApprovalArgument[] = [];
  const visit = (value: JsonValue, path: string) => {
    if (
      path === "amount" &&
      step.action === "issue-refund" &&
      isObject(value) &&
      value.mode
    ) {
      fields.push({
        path: "amount.amountMinor",
        label: "Refund amount",
        kind: "money",
      });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, `${path}.${index}`));
      return;
    }
    if (
      isObject(value) &&
      value.amountMinor !== undefined &&
      value.currency !== undefined
    ) {
      fields.push({
        path: `${path}.amountMinor`,
        label: argumentLabel(path, String(step.action)),
        kind: "money",
      });
      return;
    }
    if (
      isObject(value) &&
      value.mode === "fixed" &&
      isObject(value.value) &&
      typeof value.value.amountMinor === "number" &&
      typeof value.value.currency === "string"
    ) {
      fields.push({
        path: `${path}.amountMinor`,
        label: argumentLabel(path, String(step.action)),
        kind: "money",
      });
      return;
    }
    if (isObject(value) && !value.mode) {
      for (const [key, child] of Object.entries(value))
        visit(child, `${path}.${key}`);
      return;
    }
    const fixed =
      isObject(value) && value.mode === "fixed" ? value.value : undefined;
    if (fixed && typeof fixed === "object") return;
    fields.push({
      path,
      label: argumentLabel(path, String(step.action)),
      kind:
        typeof fixed === "boolean"
          ? "boolean"
          : typeof fixed === "number" ||
              /quantity|count|days|amount/i.test(path)
            ? "number"
            : "text",
    });
  };
  for (const [key, value] of Object.entries(args)) visit(value, key);
  return fields;
}
export function readApproval(
  value: JsonValue | undefined,
  args: readonly ApprovalArgument[],
): ApprovalChoice {
  const fallback: ApprovalChoice = {
    mode: "never",
    argument: (args.find((arg) => arg.kind === "money") ?? args[0])?.path ?? "",
    operator: ">",
    value: "100",
  };
  if (value === undefined || value === null || value === false) return fallback;
  if (value === true) return { ...fallback, mode: "always" };
  if (isObject(value) && Object.keys(value).length === 1) {
    const [op, operands] = Object.entries(value)[0] ?? [];
    if (
      approvalOperators.includes(op as ApprovalOperator) &&
      Array.isArray(operands) &&
      operands.length === 2 &&
      isObject(operands[0]) &&
      typeof operands[0].var === "string"
    ) {
      const argument = args.find(
        (arg) => `input.${arg.path}` === operands[0]!.var,
      );
      const threshold = operands[1];
      const compatible =
        argument?.kind === "money"
          ? typeof threshold === "number" &&
            Number.isSafeInteger(threshold) &&
            threshold >= 0
          : argument?.kind === "number"
            ? typeof threshold === "number"
            : argument?.kind === "boolean"
              ? typeof threshold === "boolean"
              : typeof threshold === "string";
      if (argument && compatible)
        return {
          mode: "when",
          argument: argument.path,
          operator: op as ApprovalOperator,
          value: String(
            argument.kind === "money" && typeof operands[1] === "number"
              ? operands[1] / 100
              : operands[1],
          ),
        };
    }
  }
  return { ...fallback, mode: "advanced" };
}
export function approvalExpression(
  choice: ApprovalChoice,
  args: readonly ApprovalArgument[],
): JsonValue {
  if (choice.mode === "never") return false;
  if (choice.mode === "always") return true;
  const field = args.find((arg) => arg.path === choice.argument);
  if (!field) throw new Error("Choose an argument of this step.");
  let value: JsonValue = choice.value;
  if (field.kind === "money") {
    if (!/^\d+(?:\.\d{1,2})?$/.test(choice.value.trim()))
      throw new Error("Enter a dollar amount with at most two decimal places.");
    const [whole, cents = ""] = choice.value.trim().split(".");
    value = Number(whole) * 100 + Number(cents.padEnd(2, "0"));
    if (!Number.isSafeInteger(value))
      throw new Error("Enter a smaller amount.");
  } else if (field.kind === "number") {
    if (!choice.value.trim() || !Number.isFinite(Number(choice.value)))
      throw new Error("Enter a finite number.");
    value = Number(choice.value);
  } else if (field.kind === "boolean") value = choice.value === "true";
  return { [choice.operator]: [{ var: `input.${field.path}` }, value] };
}
export function approvalSummary(
  choice: ApprovalChoice,
  args: readonly ApprovalArgument[],
  moneyValue = `$${choice.value}`,
) {
  if (choice.mode === "never") return "Never · continue automatically";
  if (choice.mode === "always") return "Always";
  if (choice.mode === "advanced") return "Custom condition";
  const arg = args.find((arg) => arg.path === choice.argument);
  const op =
    choice.operator === "==="
      ? "is"
      : choice.operator === "!=="
        ? "is not"
        : choice.operator;
  return `When ${arg?.label.toLowerCase() ?? choice.argument} ${op} ${arg?.kind === "money" ? moneyValue : choice.value}`;
}

export function approvalDescription(
  step: Record<string, JsonValue>,
  labels: Readonly<Record<string, string>> = {},
  concise = false,
) {
  const args = approvalArguments(step);
  const choice = readApproval(step.approval, args);
  if (concise && choice.mode === "never") return "Never";
  if (choice.mode === "advanced") return expressionLabel(step.approval ?? false, labels);
  return approvalSummary(choice, args, moneyLabel(
    Math.round(Number(choice.value) * 100),
    moneyCurrency(step, choice.argument), labels, true,
  ));
}
