import type { JsonValue } from "@muscle-memory/recipe-engine";

import { atPath, isObject } from "./recipe-presentation";

/** Currency follows the same money binding as the amount; no recipe is evaluated. */
export function moneyCurrency(step: Record<string, JsonValue>, path: string) {
  const parent = path.split(".").slice(0, -1);
  const value = atPath(step.args ?? {}, parent);
  if (isObject(value) && value.mode === "fixed" && isObject(value.value))
    return value.value.currency;
  return isObject(value) ? value.currency : undefined;
}

export { moneyLabel } from "./recipe-presentation";
