import type { JsonObject, JsonValue, Mutation, MutationNormalizer } from "@muscle-memory/recipe-engine";

const knownActions = new Set([
  "issue-refund", "send-reply", "tag-request", "create-replacement-order",
  "generate-return-label", "update-shipping-address", "set-request-status", "escalate",
]);
const generated = new Set(["id", "createdAt", "updatedAt"]);

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
      if (normalized.action === "tag-request" && Object.keys(normalized.input).length === 2 &&
        typeof normalized.input.requestId === "string" && typeof normalized.input.tag === "string" && normalized.input.tag) tags.push(normalized);
      else { flushTags(); result.push(normalized); }
    }
    flushTags();
    return result;
  }
}
