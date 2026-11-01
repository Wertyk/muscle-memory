import type { JsonObject } from "../domain/model.js";

/** Shared by intake matching and demonstration capture. Trusted application
 * context (such as requestId/customerId/subject) overrides customer fields. */
export function buildRequestTrigger(fields: JsonObject, context: JsonObject): JsonObject {
  return { ...fields, ...context };
}
