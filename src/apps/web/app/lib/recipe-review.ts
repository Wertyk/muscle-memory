import type { JsonValue } from "@muscle-memory/recipe-engine";

import { moneyCurrency, moneyLabel } from "./recipe-money";
import { argumentLabel, atPath, bindingLabel, expressionLabel, isObject } from "./recipe-studio";

function flatten(steps: JsonValue | undefined): Record<string, JsonValue>[] {
  if (!Array.isArray(steps)) return [];
  return steps.flatMap((step) =>
    isObject(step) ? [step, ...flatten(step.then), ...flatten(step.else)] : [],
  );
}
function currentBinding(
  step: Record<string, JsonValue> | undefined,
  argument: string,
) {
  return step?.args
    ? atPath(step.args, argument.replace(/\[(\d+)\]/g, ".$1").split("."))
    : undefined;
}
function duplicateIdentity(
  entry: Record<string, JsonValue>,
  chosen: JsonValue | undefined,
  steps: readonly Record<string, JsonValue>[],
) {
  if (
    entry.kind !== "multiple-candidates" ||
    !isObject(chosen) ||
    chosen.mode !== "path" ||
    typeof chosen.path !== "string" ||
    !/^trigger\.(orderId|requestId|customerId)$/.test(chosen.path) ||
    !Array.isArray(entry.candidates)
  )
    return false;
  const path = chosen.path;
  const key = path.split(".")[1]!;
  const candidates = entry.candidates.filter(
    (candidate) => isObject(candidate) && candidate.reason !== "constant",
  );
  return (
    candidates.length > 0 &&
    candidates.every((candidate) => {
      if (
        !isObject(candidate) ||
        !isObject(candidate.binding) ||
        candidate.binding.mode !== "path" ||
        typeof candidate.binding.path !== "string"
      )
        return false;
      if (candidate.binding.path === path) return true;
      const match = candidate.binding.path.match(
        /^steps\.([^.]+)\.output\.(.+)$/,
      );
      const source = steps.find((step) => step.id === match?.[1]);
      if (!source || !match || !isObject(source.args)) return false;
      const sourceArgument = source.args[key];
      if (
        !isObject(sourceArgument) ||
        sourceArgument.mode !== "path" ||
        sourceArgument.path !== path
      )
        return false;
      const action = String(source.action);
      if (match[2] === "id")
        return key === "orderId"
          ? ["get-order", "update-shipping-address"].includes(action)
          : key === "customerId"
            ? action === "get-customer"
            : [
                "get-request",
                "tag-request",
                "set-request-status",
                "escalate",
              ].includes(action);
      return (
        match[2] === key &&
        [
          "issue-refund",
          "send-reply",
          "get-request",
          "generate-return-label",
        ].includes(action)
      );
    })
  );
}
function priceScale(value: JsonValue | undefined): number | undefined {
  if (!isObject(value)) return;
  if (value.mode === "expr") return priceScale(value.expr);
  for (const key of ["round", "floor", "ceil"])
    if (Array.isArray(value[key])) return priceScale(value[key][0]);
  if (
    Array.isArray(value["*"]) &&
    JSON.stringify(value["*"]).includes("unitPrice")
  )
    return value["*"].find(
      (part): part is number =>
        typeof part === "number" && part > 0 && part <= 1,
    );
}
export interface ReviewQuestion {
  entry: JsonValue;
  title: string;
  step: string;
  question: string;
  minor: boolean;
}
function candidateLabel(
  binding: JsonValue | undefined,
  argument: string,
  step: Record<string, JsonValue> | undefined,
  labels: Readonly<Record<string, string>>,
) {
  if (!isObject(binding)) return undefined;
  if (binding.mode === "fixed") {
    if (typeof binding.value === "number" && argument.endsWith("amountMinor"))
      return `a fixed ${moneyLabel(binding.value, moneyCurrency(step ?? {}, argument), labels)}`;
    if (typeof binding.value === "string") {
      const text = binding.value.length > 100 ? `${binding.value.slice(0, 100)}…` : binding.value;
      return `fixed text “${text}”`;
    }
    return `a fixed ${JSON.stringify(binding.value)}`;
  }
  if (binding.mode === "expr" && isObject(binding.expr) && Array.isArray(binding.expr.cat)) {
    const parts = binding.expr.cat.filter((part) => typeof part !== "string")
      .map((part) => expressionLabel(part, labels));
    return `a message using ${parts.join(" and ")}`;
  }
  if (["path", "expr", "template"].includes(String(binding.mode)))
    return bindingLabel(binding as Parameters<typeof bindingLabel>[0], labels);
  return undefined;
}
export function reviewQuestions(
  entries: readonly JsonValue[],
  content: JsonValue,
  labels: Readonly<Record<string, string>>,
): ReviewQuestion[] {
  const steps = flatten(isObject(content) ? content.steps : undefined);
  return entries.map((entry) => {
    if (!isObject(entry))
      return {
        entry,
        title: "Recipe",
        step: "",
        question: String(entry),
        minor: false,
      };
    const step = steps.find((step) => step.id === entry.stepId);
    const argument = String(entry.argumentPath ?? "");
    const chosen = currentBinding(step, argument);
    const title =
      argumentLabel(argument, String(step?.action ?? "")) || "Recipe";
    let question = "Which source should supply this value?";
    if (entry.kind === "request-specific-text") {
      const fragments = Array.isArray(entry.fragments)
        ? entry.fragments
            .filter((value) => typeof value === "string")
            .map((value) => `“${value}”`)
            .join(", ")
        : "";
      question = fragments
        ? `Mentions ${fragments}; should it change per request?`
        : "Should any names, products or amounts in this text change per request?";
    } else if (entry.kind === "constant-or-variable") {
      const scale = priceScale(chosen);
      question =
        scale !== undefined
          ? `Is ${Number((scale * 100).toFixed(4))}% of the item price a rule or a one-off?`
          : isObject(chosen) && chosen.mode === "fixed"
            ? `Should this stay the same for every request?`
            : "Should this follow the request, or stay as shown in the demonstration?";
    } else if (entry.kind === "multiple-candidates" && Array.isArray(entry.candidates)) {
      const candidates = [...new Set([chosen, ...entry.candidates.map((candidate) =>
        isObject(candidate) ? candidate.binding : undefined,
      )].map((binding) => candidateLabel(binding, argument, step, labels))
        .filter((label): label is string => Boolean(label)))];
      if (candidates.length) {
        const choices = candidates.length === 1 ? candidates[0]
          : `${candidates.slice(0, -1).join(", ")} and ${candidates[candidates.length - 1]}`;
        question = `${title} matched ${choices} — which should future requests use?`;
      }
    } else if (entry.kind === "positional-array")
      question =
        "Should this follow the matching item when order lines change?";
    else if (entry.kind === "candidate-limit")
      question = "There are more possible sources. Which one should this use?";
    const minor = duplicateIdentity(entry, chosen, steps);
    if (minor)
      question =
        "These sources identify the same record. The trigger field is selected.";
    return {
      entry,
      title,
      step: labels[String(entry.stepId)] ?? "Original demonstration",
      question,
      minor,
    };
  });
}
