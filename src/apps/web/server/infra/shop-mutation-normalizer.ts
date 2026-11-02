import type { DifferenceClassifier, JsonObject, JsonValue, Mutation, MutationNormalizer } from "@muscle-memory/recipe-engine";
import { isBookkeepingTag } from "../../shared/shop-mutation-comparison.js";

const knownActions = new Set([
  "issue-refund", "send-reply", "tag-request", "create-replacement-order",
  "generate-return-label", "update-shipping-address", "set-request-status", "escalate",
]);
const generated = new Set(["id", "createdAt", "updatedAt"]);

/** Wording and internal tags are allowlists; customer operations and unknown fields are outcomes. */
export class ShopDifferenceClassifier implements DifferenceClassifier {
  classify(path: string, historical: readonly Mutation[], intended: readonly Mutation[]) {
    const parts = path.split("/").slice(1).map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
    if (!/^(0|[1-9][0-9]*)$/.test(parts[0] ?? "")) return "outcome";
    const before = historical[Number(parts[0])];
    const after = intended[Number(parts[0])];
    const sidesAtIndex = [before, after].filter((mutation) => mutation !== undefined);
    const tags = sidesAtIndex.length > 0 && sidesAtIndex.every(isBookkeepingTag);
    if (tags && (parts.length === 1 || (parts.length === 3 && parts[1] === "input" && ["tag", "requestId"].includes(parts[2] ?? "")))) return "bookkeeping";
    if (parts[1] !== "input") return "outcome";
    if (!before || !after) return "outcome";
    const field = parts[2];
    const sides = [before, after].filter((mutation) => Object.prototype.hasOwnProperty.call(mutation.input, field ?? ""));
    return (sides.length ? sides : [before, after]).every(({ action }) =>
      (action === "issue-refund" && field === "reason" && parts.length === 3) ||
      (action === "send-reply" && ((["template", "body"].includes(field ?? "") && parts.length === 3) || field === "variables"))) ? "wording" : "outcome";
  }
}

/** Comparison-only literal rendering with SendReply's placeholder semantics.
 * Invalid inputs stay exact; normalization must not make them look successful. */
function renderedReply(input: JsonObject): string | null {
  const { template, variables } = input;
  if (typeof template !== "string" || !template.trim() || !variables || typeof variables !== "object" || Array.isArray(variables)) return null;
  const values = variables as JsonObject;
  const token = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
  if (/[{}]/.test(template.replace(token, ""))) return null;
  for (const match of template.matchAll(token)) {
    if (!Object.prototype.hasOwnProperty.call(values, match[1]!)) return null;
    const value = values[match[1]!];
    if (typeof value !== "string" && (typeof value !== "number" || !Number.isFinite(value))) return null;
  }
  return template.replace(token, (_match, name: string) => String(values[name]));
}

function normalizeOne({ action, input }: Mutation): Mutation {
  if (!knownActions.has(action)) return { action, input: structuredClone(input) };
  const cleaned: Record<string, JsonValue> = Object.fromEntries(
    Object.entries(structuredClone(input)).filter(([key]) => !generated.has(key)),
  );
  if (action === "send-reply") {
    const body = renderedReply(cleaned);
    if (body !== null && !Object.prototype.hasOwnProperty.call(cleaned, "body")) {
      delete cleaned.template;
      delete cleaned.variables;
      return { action, input: { ...cleaned, body } };
    }
  }
  if (["issue-refund", "escalate"].includes(action) && typeof cleaned.reason === "string") cleaned.reason = cleaned.reason.trim();
  if (action === "tag-request" && typeof cleaned.tag === "string") cleaned.tag = cleaned.tag.trim();
  return { action, input: cleaned };
}

/** Pure symmetric normalization; never resolves omitted defaults against live DB
 * state and never drops semantic orderId/requestId/productId references. */
export class ShopMutationNormalizer implements MutationNormalizer {
  normalize(mutations: readonly Mutation[]): readonly Mutation[] {
    const result: Mutation[] = [];
    let tags: Mutation[] = [];
    const flushTags = () => {
      const key = (m: Mutation) => JSON.stringify(Object.entries(m.input).sort(([a], [b]) => a.localeCompare(b)));
      const unique = new Map(tags.map((m) => [key(m), m]));
      result.push(...[...unique.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, m]) => m));
      tags = [];
    };
    for (const mutation of mutations) {
      const normalized = normalizeOne(mutation);
      // Only exact tag inputs are known set-like/idempotent operations.
      if (isBookkeepingTag(normalized)) tags.push(normalized);
      else result.push(normalized);
    }
    flushTags();
    return result;
  }
}
