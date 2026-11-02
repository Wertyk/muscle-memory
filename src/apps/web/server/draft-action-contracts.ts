import { defineActionErrors, type ActionRunContext } from "@agent-native/core/action";
import { bindingSchema, DraftRecipeError, recipeVersionSchema, type RecipeDraft } from "@muscle-memory/recipe-engine";
import { z } from "zod";
import { demonstrationOwner } from "./infra/teach-session.js";

export const recipeVersionIdSchema = z.string().max(31).regex(/^[A-Za-z_][A-Za-z0-9_-]*$/);
export const recipeDraftSchema: z.ZodType<RecipeDraft> = z.object({
  demonstrationId: z.string(),
  recipe: z.object({ id: z.string(), name: z.string(), status: z.enum(["draft", "active"]), activeVersionId: z.string().nullable() }),
  draft: recipeVersionSchema,
  ambiguities: z.array(z.object({ stepId: z.string(), argumentPath: z.string(),
    kind: z.enum(["multiple-candidates", "constant-or-variable", "candidate-limit", "positional-array", "request-specific-text"]),
    message: z.string().optional(), fragments: z.array(z.string()).optional(),
    candidates: z.array(z.object({ binding: bindingSchema,
      reason: z.enum(["exact-match", "scale", "rounded-scale", "difference", "template", "constant"]), sourcePaths: z.array(z.string()) })),
  })),
});
export const draftErrors = defineActionErrors("DRAFT_INPUT", "DRAFT_NOT_FOUND", "DRAFT_UNAVAILABLE");
export function draftOwner(context?: ActionRunContext) {
  return demonstrationOwner(context) ?? draftErrors.noWrite("Sign in to draft or read a recipe.", "DRAFT_INPUT", { statusCode: 401 });
}
export async function draftOperation<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof DraftRecipeError) return draftErrors.noWrite(error.message,
      error.code === "NOT_FOUND" ? "DRAFT_NOT_FOUND" : "DRAFT_INPUT", { statusCode: error.code === "NOT_FOUND" ? 404 : 400 });
    return draftErrors.fail("Recipe draft could not be saved or read.", "DRAFT_UNAVAILABLE", { statusCode: 503 });
  }
}
