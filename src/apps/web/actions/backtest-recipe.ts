import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { getRecipeBacktests } from "../server/composition.js";
import { backtestErrors, backtestOperation, backtestOutputSchema, backtestRequestTypeSchema, recipeReferenceSchema, recipeReferenceToolSchema } from "../server/backtest-action-contracts.js";

export default defineAction({
  description: "Backtest a saved recipe version ID or snapshot on resolved requests of requestType. Counts compare customer outcomes; wording and internal tag differences remain visible. Unreconstructable messages stay not_handled; unknown usage makes totalTokens null with unknownUsageCases and measured token subtotals. DB/configuration errors still fail the report. Read-only simulation uses current shop data; free-text/extract steps spend tokens.",
  schema: z.object({
    recipe: recipeReferenceSchema("recipe").describe("Saved recipe version ID or complete immutable recipe version snapshot; snapshots are not persisted"),
    requestType: backtestRequestTypeSchema,
  }),
  agentInputSchema: z.object({
    recipe: recipeReferenceToolSchema.describe("Saved recipe version ID or complete immutable recipe version snapshot; snapshots are not persisted"),
    requestType: backtestRequestTypeSchema,
  }),
  outputSchema: backtestOutputSchema,
  errors: backtestErrors,
  http: { method: "GET" },
  readOnly: true,
  run: (input, context) => backtestOperation(() => getRecipeBacktests(context).execute(input), backtestOutputSchema),
});
