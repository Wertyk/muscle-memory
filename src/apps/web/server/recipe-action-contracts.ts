import { defineActionErrors } from "@agent-native/core/action";
import { recipeVersionSchema, type JsonValue, type Run } from "@muscle-memory/recipe-engine";
import { z } from "zod";
import { isRecipeJson } from "./infra/recipe-json.js";

export const recipeErrors = defineActionErrors("RUN_NOT_FOUND", "RECIPE_EXECUTION_FAILED");
export const runIdSchema = z.string().max(31).regex(/^run_[A-Za-z0-9_-]+$/);
export const recipeJsonSchema = z.custom<JsonValue>(isRecipeJson, "Expected bounded finite JSON");
export const booleanFlagSchema = z.preprocess((value) => value === "true" ? true : value === "false" ? false : value, z.boolean());
const tokens = z.object({ input: z.number().int().nonnegative(), output: z.number().int().nonnegative() });
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
