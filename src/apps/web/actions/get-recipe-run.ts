import { defineAction } from "@agent-native/core/action";
import type { Run } from "@muscle-memory/recipe-engine";
import type { CorrectionEvidence } from "../shared/corrections.js";
import { z } from "zod";
import { RUN_CARD_RENDERER } from "../shared/recipe-runs.js";
import { getRecipeUseCases, readCorrections } from "../server/composition.js";
import { recipeErrors, runIdSchema, runOutputSchema } from "../server/recipe-action-contracts.js";

export default defineAction({
  description: "Read a durable recipe run with its immutable version, step attempts, resolved inputs/results, metrics, approval gate, handoff context and scoped human corrections (original/new effects, proposal and decision). Automatically displays a run/approval card. Keep the entire text reply to one or two sentences total for all runs: status and next step; no tables, step details or raw IDs.",
  schema: z.object({ runId: runIdSchema.describe("Saved recipe run ID") }),
  outputSchema: runOutputSchema.and(z.object({ corrections: z.array(z.unknown()).optional() })) as z.ZodType<Run & CorrectionEvidence>,
  chatUI: { renderer: RUN_CARD_RENDERER, title: "Recipe run" },
  errors: recipeErrors,
  http: { method: "GET" },
  readOnly: true,
  run: async (input, context) => {
    const run = await getRecipeUseCases().runs.get(input.runId);
    if (run) {
      const corrections = await readCorrections(context, input);
      return corrections.length ? { ...run, corrections } : run;
    }
    return recipeErrors.noWrite("Recipe run not found.", "RUN_NOT_FOUND", { statusCode: 404 });
  },
});
