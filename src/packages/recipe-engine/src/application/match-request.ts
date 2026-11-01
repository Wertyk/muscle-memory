import { evaluateCondition } from "../domain/evaluation.js";
import { immutableSnapshot, isJsonValue } from "../domain/json.js";
import type { JsonObject, RecipeVersion } from "../domain/model.js";
import type { TokenUsage } from "../domain/run.js";
import type { ActiveRecipeSource, RequestExtractor } from "./ports.js";
import { parseRecipeVersion } from "./recipe-schema.js";
import { buildRequestTrigger } from "./request-trigger.js";

export interface MatchInput {
  readonly event: string;
  /** Trusted application identity/context, kept separate from customer fields. */
  readonly context: JsonObject;
  readonly content: { readonly source: "structured"; readonly fields: JsonObject }
    | { readonly source: "free_text"; readonly text: string };
}
export type MatchReason = "matched" | "no_match" | "extraction_failed" | "ambiguous" | "matching_failed";
export interface RequestMatch {
  readonly recipe: RecipeVersion | null;
  readonly trigger: JsonObject;
  readonly tokens: TokenUsage;
  readonly reason: MatchReason;
}

/** Domain-agnostic matching: the app supplies field validation through a port. */
export class MatchRequest {
  constructor(private readonly deps: { readonly recipes: ActiveRecipeSource; readonly extractor: RequestExtractor }) {}

  async execute(input: MatchInput): Promise<RequestMatch> {
    if (!input.event || !isJsonValue(input.context)) throw new Error("Invalid matching context");
    let tokens: TokenUsage = { input: 0, output: 0 };
    let trigger: JsonObject = input.context;
    const result = (reason: MatchReason, recipe: RecipeVersion | null = null): RequestMatch =>
      immutableSnapshot({ recipe, trigger, tokens, reason });
    let fields: JsonObject;
    if (input.content.source === "structured") {
      fields = input.content.fields;
      if (!isJsonValue(fields) || !fields || Array.isArray(fields) || typeof fields !== "object") throw new Error("Invalid structured fields");
    } else {
      try {
        // Exactly one attempt, independent of the number of active recipes.
        const extracted = await this.deps.extractor.extract(input.content.text);
        if (!Number.isSafeInteger(extracted.tokens.input) || extracted.tokens.input < 0 ||
          !Number.isSafeInteger(extracted.tokens.output) || extracted.tokens.output < 0) throw new Error("Invalid usage");
        tokens = extracted.tokens;
        if (!extracted.fields || !isJsonValue(extracted.fields) || Array.isArray(extracted.fields) || typeof extracted.fields !== "object") return result("extraction_failed");
        fields = extracted.fields;
      } catch { return result("extraction_failed"); }
    }
    // Customer fields cannot overwrite request identity supplied by the app.
    trigger = buildRequestTrigger(fields, input.context);
    try {
      const versions = (await this.deps.recipes.listActive()).map(parseRecipeVersion);
      const matches = versions.filter((version) => version.trigger.event === input.event &&
        evaluateCondition(version.trigger.match, { trigger, steps: {} }));
      if (matches.length > 1) return result("ambiguous");
      return matches[0] ? result("matched", matches[0]) : result("no_match");
    } catch { return result("matching_failed"); }
  }
}
