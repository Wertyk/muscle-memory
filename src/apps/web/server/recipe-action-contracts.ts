import { defineActionErrors } from "@agent-native/core/action";
import { recipeVersionSchema, type JsonValue, type Run } from "@muscle-memory/recipe-engine";
import { z } from "zod";
import { isRecipeJson } from "./infra/recipe-json.js";
import { RUN_STATUSES, type RunSummary } from "../shared/recipe-runs.js";

export const runFiltersSchema = z.object({
  status: z.enum(RUN_STATUSES).optional(),
  requestId: z.string().max(31).regex(/^req_[A-Za-z0-9_-]+$/).optional(),
  recipeId: z.string().min(1).max(31).optional(),
  mode: z.enum(["execute", "dry-run"]).optional(),
});

export const recipeErrors = defineActionErrors("RUN_NOT_FOUND", "RECIPE_EXECUTION_FAILED");
export const runIdSchema = z.string().max(31).regex(/^run_[A-Za-z0-9_-]+$/);
export const recipeJsonSchema = z.custom<JsonValue>(isRecipeJson, "Expected bounded finite JSON");
/** The installed tool converter reads the transform's input side. Keep JSON Schema
 * representable metadata at the transport boundary and retain the exact DSL /
 * bounded-JSON validators on the output side before any execution. */
function boundedJsonInput(input: unknown, context: z.RefinementCtx): unknown {
  if (!isRecipeJson(input)) {
    context.addIssue({ code: "custom", message: "Expected bounded finite JSON with safe keys" });
    return z.NEVER;
  }
  return input;
}
export const recipeVersionInputSchema = z.preprocess(boundedJsonInput, z.strictObject({
  id: z.string(), recipeId: z.string(), version: z.number().int().positive(), name: z.string(),
  trigger: z.strictObject({ event: z.string(), match: z.json() }),
  steps: z.array(z.json()),
})).transform((input, context) => {
  const result = recipeVersionSchema.safeParse(input);
  if (!result.success) {
    for (const issue of result.error.issues) context.addIssue({ code: "custom", path: issue.path, message: issue.message });
    return z.NEVER;
  }
  return result.data;
});
export const recipeJsonInputSchema = z.preprocess(boundedJsonInput, z.json()).transform((input, context) => {
  const result = recipeJsonSchema.safeParse(input);
  if (!result.success) {
    for (const issue of result.error.issues) context.addIssue({ code: "custom", path: issue.path, message: issue.message });
    return z.NEVER;
  }
  return result.data;
});
export const booleanFlagSchema = z.preprocess((value) => value === "true" ? true : value === "false" ? false : value, z.boolean());
const tokens = z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() });
export const runSummariesSchema: z.ZodType<readonly RunSummary[]> = z.array(z.object({
  id: runIdSchema, requestId: z.string().nullable(), requestSubject: z.string().nullable(),
  recipeId: z.string(), recipeVersionId: z.string(), recipeName: z.string(), version: z.number().int().positive(),
  status: z.enum(RUN_STATUSES), mode: z.enum(["execute", "dry-run"]),
  createdAt: z.number(), updatedAt: z.number(), durationMs: z.number().nonnegative(), tokens,
}));
const step = z.object({
  stepId: z.string(), kind: z.enum(["action", "extract", "branch", "handoff"]),
  action: z.string().nullable(), effect: z.enum(["read", "mutation"]).nullable(), attempt: z.number().int().positive(),
  status: z.enum(["running", "awaiting_approval", "completed", "rejected", "failed", "planned", "blocked"]),
  approvalRequired: z.boolean(), input: recipeJsonSchema, output: recipeJsonSchema,
  startedAt: z.number(), finishedAt: z.number().nullable(), durationMs: z.number().nonnegative(),
  tokens, error: z.string().nullable(), blockedBy: z.array(z.string()),
});
export const runOutputSchema: z.ZodType<Run> = z.object({
  id: runIdSchema, recipe: recipeVersionSchema, trigger: recipeJsonSchema,
  mode: z.enum(["execute", "dry-run"]),
  status: z.enum(["running", "awaiting_approval", "completed", "aborted", "handed_off", "failed"]),
  createdAt: z.number(), updatedAt: z.number(), steps: z.array(step),
  pendingStepIds: z.array(z.string()), approvedStepIds: z.array(z.string()), awaitingApprovalStepId: z.string().nullable(),
  tokens,
  failure: z.object({ stepId: z.string(), message: z.string(), retryable: z.boolean() }).nullable(),
  handoff: z.object({
    context: z.object({
      idempotencyKey: z.string(), runId: runIdSchema, recipeVersionId: z.string(), trigger: recipeJsonSchema,
      stepId: z.string(), to: z.enum(["agent", "human"]), reason: z.enum(["step", "failure", "interrupted"]),
      note: recipeJsonSchema, steps: z.array(step), outputs: z.record(z.string(), z.object({ output: recipeJsonSchema })),
    }),
    status: z.enum(["pending", "delivered"]), error: z.string().nullable(),
  }).nullable(),
});

/** Do not expose DB/provider errors or unvalidated customer content. The run's
 * last durable checkpoint remains available after a failed action response. */
export async function recipeOperation(work: () => Promise<Run>): Promise<Run> {
  try { return await work(); }
  catch { return recipeErrors.fail("Recipe execution could not finish. Read its durable checkpoint before retrying.", "RECIPE_EXECUTION_FAILED", { statusCode: 409 }); }
}
