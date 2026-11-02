import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { getRecipeBacktests } from "../server/composition.js";
import { backtestErrors, backtestOperation, backtestOutputSchema, backtestRequestTypeSchema, recipeReferenceSchema } from "../server/backtest-action-contracts.js";

export default defineAction({
  description: "Backtest a saved recipe version ID or snapshot on resolved requests of requestType. Read-only simulation uses current shop data; free-text/extract steps spend tokens reported in summary.",
  schema: z.object({
    recipe: recipeReferenceSchema.describe("Saved recipe version ID or complete immutable recipe version snapshot; snapshots are not persisted"),
    requestType: backtestRequestTypeSchema,
  }),
  outputSchema: backtestOutputSchema,
  errors: backtestErrors,
  http: { method: "GET" },
  readOnly: true,
  run: (input, context) => backtestOperation(() => getRecipeBacktests(context).execute(input)),
});
