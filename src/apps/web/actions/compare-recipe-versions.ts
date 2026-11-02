import { defineAction } from "@agent-native/core/action";
import { z } from "zod";
import { getRecipeBacktests } from "../server/composition.js";
import { backtestErrors, backtestOperation, backtestRequestTypeSchema, compareBacktestOutputSchema, recipeReferenceSchema } from "../server/backtest-action-contracts.js";

export default defineAction({
  description: "Compare two recipe version IDs or snapshots on one shared set of resolved requests of requestType, without writes. Outcome changes exclude wording and internal tags, whose diffs remain visible. Unreconstructable requests stay not_handled in both versions; unknown usage makes totalTokens null. Summary counts shared free-text extraction once; recipe extract steps still spend tokens.",
  schema: z.object({
    baseline: recipeReferenceSchema.describe("Baseline saved recipe version ID or complete immutable snapshot; never persisted by this action"),
    candidate: recipeReferenceSchema.describe("Candidate saved recipe version ID or complete immutable snapshot; never persisted by this action"),
    requestType: backtestRequestTypeSchema,
  }),
  outputSchema: compareBacktestOutputSchema,
  errors: backtestErrors,
  http: { method: "GET" },
  readOnly: true,
  run: (input, context) => backtestOperation(() => getRecipeBacktests(context).compare(input), compareBacktestOutputSchema),
});
