import type { JsonValue } from "@muscle-memory/recipe-engine";

import { atPath, bindingLabel, isObject } from "./recipe-studio";

/** Currency follows the same money binding as the amount; no recipe is evaluated. */
export function moneyCurrency(step: Record<string, JsonValue>, path: string) {
  const parent = path.split(".").slice(0, -1);
  const value = atPath(step.args ?? {}, parent);
  if (isObject(value) && value.mode === "fixed" && isObject(value.value))
    return value.value.currency;
  return isObject(value) ? value.currency : undefined;
}

export function moneyLabel(
  amountMinor: number,
  currency: JsonValue | undefined,
  labels: Readonly<Record<string, string>> = {},
  trim = false,
) {
  const code = isObject(currency) && currency.mode === "fixed"
    ? currency.value : currency;
  const amount = amountMinor / 100;
  if (typeof code === "string" && /^[A-Z]{3}$/.test(code))
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: code,
      minimumFractionDigits: trim && Number.isInteger(amount) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(amount);
  const source = isObject(currency) && currency.mode
    ? bindingLabel(currency as Parameters<typeof bindingLabel>[0], labels)
    : "this step’s currency";
  return `${trim ? amount : amount.toFixed(2)} in ${source}`;
}
