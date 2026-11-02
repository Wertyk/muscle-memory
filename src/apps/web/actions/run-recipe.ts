import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { RUN_CARD_RENDERER } from "../shared/recipe-runs.js";
import { getRecipeUseCases } from "../server/composition.js";
import { jsonContainerInput } from "../server/action-input.js";
import { booleanFlagSchema, recipeErrors, recipeJsonInputSchema, recipeVersionInputSchema, recipeOperation, runOutputSchema } from "../server/recipe-action-contracts.js";

export default defineAction({
  description: "Start an immutable recipe version with a trigger. dryRun simulates reads/extraction and reports planned mutations; recipe gates control execution approval. Automatically displays a run/approval card. Keep the entire text reply to one or two sentences total for all runs: status and next step; no tables, step details or raw IDs.",
  schema: z.object({
    recipe: jsonContainerInput(recipeVersionInputSchema, "recipe").describe("Complete validated recipe version snapshot; existing version identities cannot be edited"),
    trigger: jsonContainerInput(recipeJsonInputSchema, "trigger", "object-or-array").describe("Trigger payload including requestId for request handoffs"),
    dryRun: booleanFlagSchema.default(false).describe("Default false; true persists a simulation without shop mutations or handoff delivery"),
  }),
  outputSchema: runOutputSchema,
  mcpApp: { structuredContent: true },
  chatUI: { renderer: RUN_CARD_RENDERER, title: "Recipe run" },
  errors: recipeErrors,
  run: (input, context) => recipeOperation(() => getRecipeUseCases(context).runRecipe.execute({
    recipe: input.recipe, trigger: input.trigger, mode: input.dryRun ? "dry-run" : "execute",
  })),
});
