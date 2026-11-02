import type { JsonValue } from "@muscle-memory/recipe-engine";
import { REQUEST_TYPES, type RequestType } from "@muscle-memory/shop-domain";

import { isObject } from "./recipe-studio";

/** Recognize an explicit type equality, including conjunctions. Never guess a cohort. */
export function backtestRequestType(match: JsonValue): RequestType | undefined {
  if (!isObject(match)) return;
  for (const operator of ["===", "=="]) {
    const args = match[operator];
    if (!Array.isArray(args) || args.length !== 2) continue;
    for (const [field, value] of [[args[0], args[1]], [args[1], args[0]]]) {
      if (isObject(field) && field.var === "trigger.type")
        return REQUEST_TYPES.find((type) => type === value);
    }
  }
  if (Array.isArray(match.and)) {
    const types = [...new Set(match.and.map(backtestRequestType).filter((type) => type !== undefined))];
    if (types.length === 1) return types[0];
  }
}
