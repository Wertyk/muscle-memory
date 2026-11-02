import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { RUN_CARD_RENDERER } from "../shared/recipe-runs.js";
import { getRecipeUseCases } from "../server/composition.js";
import { booleanFlagSchema, recipeErrors, recipeJsonInputSchema, recipeVersionInputSchema, recipeOperation, runOutputSchema } from "../server/recipe-action-contracts.js";

export default defineAction({
  description: "Start an immutable recipe version with a trigger. dryRun simulates reads/extraction and reports planned mutations; recipe gates control execution approval.",
  schema: z.object({
    recipe: recipeVersionInputSchema.describe("Complete validated recipe version snapshot; existing version identities cannot be edited"),
    trigger: recipeJsonInputSchema.describe("Trigger payload including requestId for request handoffs"),
    dryRun: booleanFlagSchema.default(false).describe("Default false; true persists a simulation without shop mutations or handoff delivery"),
  }),
  outputSchema: runOutputSchema,
  chatUI: { renderer: RUN_CARD_RENDERER, title: "Recipe run" },
  errors: recipeErrors,
  run: (input, context) => recipeOperation(() => getRecipeUseCases(context).runRecipe.execute({
    recipe: input.recipe, trigger: input.trigger, mode: input.dryRun ? "dry-run" : "execute",
  })),
});
