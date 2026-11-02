import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { RUN_CARD_RENDERER } from "../shared/recipe-runs.js";
import { getRecipeUseCases } from "../server/composition.js";
import { recipeErrors, runIdSchema, runOutputSchema } from "../server/recipe-action-contracts.js";

export default defineAction({
  description: "Read a durable recipe run with its immutable version, step attempts, resolved inputs/results, metrics, approval gate and handoff context.",
  schema: z.object({ runId: runIdSchema.describe("Saved recipe run ID") }),
  outputSchema: runOutputSchema,
  chatUI: { renderer: RUN_CARD_RENDERER, title: "Recipe run" },
  errors: recipeErrors,
  http: { method: "GET" },
  readOnly: true,
  run: async (input) => {
    const run = await getRecipeUseCases().runs.get(input.runId);
    return run ?? recipeErrors.noWrite("Recipe run not found.", "RUN_NOT_FOUND", { statusCode: 404 });
  },
});
