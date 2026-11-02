import { defineActionErrors } from "@agent-native/core/action";
import { recipeVersionSchema, type JsonObject } from "@muscle-memory/recipe-engine";
import { REQUEST_TYPES } from "@muscle-memory/shop-domain";
import { z } from "zod";
import { BacktestInputError, type ShopBacktestResult, type ShopBacktestComparison } from "./infra/shop-recipe-backtests.js";
import { recipeJsonSchema, runOutputSchema } from "./recipe-action-contracts.js";

export const backtestErrors = defineActionErrors("VERSION_NOT_FOUND", "INVALID_BACKTEST", "BACKTEST_FAILED");
export const recipeReferenceSchema = z.union([
  z.string().max(31).regex(/^[A-Za-z_][A-Za-z0-9_-]*$/), recipeVersionSchema,
]);
export const backtestRequestTypeSchema = z.enum(REQUEST_TYPES).describe("Historical request type for the recipe trigger: damaged_item, where_is_my_order, return, address_change, wholesale_inquiry. Only resolved requests of this type are selected; other trigger conditions are evaluated per case.");
const count = z.number().int().nonnegative();
const tokens = z.object({ input: count, output: count });
const mutation = z.object({ action: z.string(), input: z.custom<JsonObject>((v) => recipeJsonSchema.safeParse(v).success && v !== null && typeof v === "object" && !Array.isArray(v)) });
const diff = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("added"), path: z.string(), intended: recipeJsonSchema }),
  z.object({ kind: z.literal("removed"), path: z.string(), historical: recipeJsonSchema }),
  z.object({ kind: z.literal("changed"), path: z.string(), historical: recipeJsonSchema, intended: recipeJsonSchema }),
]);
const status = z.enum(["identical", "different", "not_handled"]);
export const backtestOutputSchema: z.ZodType<ShopBacktestResult> = z.object({
  recipeVersionId: z.string(), readData: z.literal("current"), limitations: z.array(z.string()),
  summary: z.object({ total: count, identical: count, different: count, notHandled: count,
    tokens, totalTokens: count, requestExtractionTokens: tokens, recipeExtractionTokens: tokens }),
  cases: z.array(z.object({
    caseId: z.string(), status,
    reasons: z.array(z.object({
      code: z.enum(["identical", "different", "trigger-mismatch", "trigger-error", "execution-error", "failed", "blocked", "handoff", "no-mutations"]),
      message: z.string(), stepId: z.string().optional(), blockedBy: z.array(z.string()).readonly().optional(),
    }).transform(({ stepId, blockedBy, ...reason }) => ({
      ...reason, ...(stepId === undefined ? {} : { stepId }), ...(blockedBy === undefined ? {} : { blockedBy }),
    }))),
    historicalMutations: z.array(mutation), intendedMutations: z.array(mutation), diff: z.array(diff), run: runOutputSchema.nullable(),
  })),
});
export const compareBacktestOutputSchema: z.ZodType<ShopBacktestComparison> = z.object({
  baseline: backtestOutputSchema, candidate: backtestOutputSchema,
  summary: z.object({ tokens, totalTokens: count, sharedRequestExtractionTokens: tokens }),
  cases: z.array(z.object({ caseId: z.string(), baselineStatus: status, candidateStatus: status, changed: z.boolean(), diff: z.array(diff) })),
});

export async function backtestOperation<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); }
  catch (error) {
    if (error instanceof BacktestInputError) return backtestErrors.noWrite(error.message, error.code, { statusCode: error.code === "VERSION_NOT_FOUND" ? 404 : 400 });
    return backtestErrors.noWrite("Backtest could not finish. Check the historical request fields and recipe, then retry. Extraction may have spent tokens.", "BACKTEST_FAILED", { statusCode: 409 });
  }
}
