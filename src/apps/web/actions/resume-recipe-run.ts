import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { APPROVAL_CARD_RENDERER } from "../shared/recipe-runs.js";
import { getRecipeUseCases } from "../server/composition.js";
import { booleanFlagSchema, recipeErrors, recipeOperation, runIdSchema, runOutputSchema } from "../server/recipe-action-contracts.js";

export default defineAction({
  description: "Resume a saved recipe run: approve/reject its exact awaiting step, explicitly retry a safe failed step, or retry pending handoff delivery. Completed mutations are never replayed.",
  schema: z.object({
    runId: runIdSchema.describe("Saved recipe run ID"),
    approval: z.object({
      stepId: z.string().min(1).max(31).describe("Exact awaitingApprovalStepId from get-recipe-run"),
      decision: z.enum(["approve", "reject"]).describe("Approve executes the gated step; reject permanently aborts the run"),
    }).optional().describe("Omit when retrying a safe step or pending handoff"),
    retry: booleanFlagSchema.default(false).describe("Default false; true retries only safe failed reads/extraction/evaluation, never uncertain mutations"),
  }).refine((input) => !(input.approval && input.retry), "Choose approval or retry, not both"),
  outputSchema: runOutputSchema,
  chatUI: { renderer: APPROVAL_CARD_RENDERER, title: "Recipe approval" },
  errors: recipeErrors,
  run: async (input, context) => {
    const cases = getRecipeUseCases(context);
    if (!await cases.runs.get(input.runId)) return recipeErrors.noWrite("Recipe run not found.", "RUN_NOT_FOUND", { statusCode: 404 });
    return recipeOperation(() => cases.runRecipe.resume({
      runId: input.runId, retry: input.retry, ...(input.approval ? { approval: input.approval } : {}),
    }));
  },
});
