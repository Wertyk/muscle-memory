import { defineActionErrors } from "@agent-native/core/action";
import { buildDeepLink } from "@agent-native/core/server";
import {
  RecipeStudioError,
  type StudioDraft,
  type StudioIssue,
} from "@muscle-memory/recipe-engine";
import { z } from "zod";

import { recipeJsonSchema } from "./recipe-action-contracts.js";

export const studioId = z
  .string()
  .max(31)
  .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/);
export const studioRevision = z.number().int().nonnegative();
export const studioContent = z.record(z.string(), recipeJsonSchema);
// Keep the tool's root schema an object for OpenAI-compatible action callers.
export const studioDraftRead = z
  .object({ recipeId: studioId.optional(), versionId: studioId.optional() })
  .strict()
  .refine(
    (input) => Boolean(input.recipeId) !== Boolean(input.versionId),
    "Provide exactly one of recipeId or versionId.",
  );
export const studioDraftOutputSchema: z.ZodType<
  StudioDraft & { readonly issues: readonly StudioIssue[] }
> = z.object({
  recipeId: studioId,
  revision: studioRevision,
  baseVersionId: studioId.nullable(),
  content: studioContent,
  ambiguities: z.array(recipeJsonSchema),
  issues: z.array(z.object({ path: z.string(), message: z.string() })),
});
export const studioErrors = defineActionErrors(
  "RECIPE_NOT_FOUND",
  "RECIPE_CONFLICT",
  "RECIPE_INVALID",
);
export async function studioResult<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (error) {
    if (error instanceof RecipeStudioError)
      return studioErrors.noWrite(
        error.message,
        error.code === "NOT_FOUND"
          ? "RECIPE_NOT_FOUND"
          : error.code === "CONFLICT"
            ? "RECIPE_CONFLICT"
            : "RECIPE_INVALID",
        {
          statusCode:
            error.code === "NOT_FOUND"
              ? 404
              : error.code === "CONFLICT"
                ? 409
                : 422,
        },
      );
    throw error;
  }
}

/** Pure deep-link metadata shared by external MCP/A2A results. */
export function studioLink(result: unknown) {
  const row =
    result && typeof result === "object"
      ? (result as Record<string, unknown>)
      : {};
  const recipe = row.recipe as { id?: string } | undefined;
  const id =
    typeof row.recipeId === "string"
      ? row.recipeId
      : (recipe?.id ?? (typeof row.id === "string" ? row.id : undefined));
  return {
    url: buildDeepLink({
      app: "web",
      view: id ? "recipe" : "recipes",
      to: id ? `/recipes/${encodeURIComponent(id)}` : "/recipes",
      params: id ? { recipeId: id } : {},
    }),
    label: "Open in Recipe Studio",
    view: id ? "recipe" : "recipes",
  };
}
