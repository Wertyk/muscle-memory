import { defineAction } from "@agent-native/core/action";
import { recipeVersionSchema } from "@muscle-memory/recipe-engine";
import { z } from "zod";
import { getRecipeUseCases } from "../server/composition.js";
import { booleanFlagSchema, recipeErrors, recipeJsonSchema, recipeOperation, runOutputSchema } from "../server/recipe-action-contracts.js";

export default defineAction({
  description: "Start an immutable recipe version with a trigger. dryRun simulates reads/extraction and reports planned mutations; recipe gates control execution approval.",
  schema: z.object({
    recipe: recipeVersionSchema.describe("Complete validated recipe version snapshot; existing version identities cannot be edited"),
    trigger: recipeJsonSchema.describe("Trigger payload including requestId for request handoffs"),
    dryRun: booleanFlagSchema.default(false).describe("Default false; true persists a simulation without shop mutations or handoff delivery"),
  }),
  outputSchema: runOutputSchema,
  errors: recipeErrors,
  run: (input, context) => recipeOperation(() => getRecipeUseCases(context).runRecipe.execute({
    recipe: input.recipe, trigger: input.trigger, mode: input.dryRun ? "dry-run" : "execute",
  })),
});
