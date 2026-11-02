import { defineActionErrors } from "@agent-native/core/action";
import { recipeVersionSchema, type JsonObject } from "@muscle-memory/recipe-engine";
import { REQUEST_TYPES } from "@muscle-memory/shop-domain";
import { z } from "zod";
import { BacktestInputError, type ShopBacktestResult, type ShopBacktestComparison } from "./infra/shop-recipe-backtests.js";
import { recipeJsonSchema, runOutputSchema } from "./recipe-action-contracts.js";
import { HistoricalReconstructionError } from "./infra/shop-historical-cases.js";

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

function validationContext(value: unknown, path: readonly PropertyKey[]) {
  const ids: { requestId?: string; stepId?: string } = {};
  for (const key of [...path, ""]) {
    if (!value || typeof value !== "object") break;
    const row = value as Record<PropertyKey, unknown>;
    if (typeof row.caseId === "string" && /^req_[A-Za-z0-9_-]{1,27}$/.test(row.caseId)) ids.requestId = row.caseId;
    if (typeof row.stepId === "string" && /^[A-Za-z_][A-Za-z0-9_-]{0,30}$/.test(row.stepId)) ids.stepId = row.stepId;
    value = Object.prototype.hasOwnProperty.call(row, key) ? row[key] : undefined;
  }
  return ids;
}

export async function backtestOperation<T>(work: () => Promise<T>, output?: z.ZodType<T>): Promise<T> {
  let result: T | undefined;
  try { result = await work(); return output ? output.parse(result) : result; }
  catch (error) {
    // Raw errors can contain SQL parameters, provider credentials and customer text.
    // Retain safe class diagnostics and identifiers, never serialize the error object.
    const known = error instanceof BacktestInputError || error instanceof HistoricalReconstructionError;
    console.error("[recipe-backtest]", {
      name: known ? error.name : error instanceof z.ZodError ? "ZodError"
        : error instanceof Error && ["TypeError", "RangeError", "SyntaxError"].includes(error.name) ? error.name : "Error",
      message: known ? error.message : error instanceof z.ZodError ? "Backtest data failed schema validation." : "Unexpected backtest failure (private details withheld).",
      ...(error instanceof HistoricalReconstructionError ? { requestId: error.requestId,
        ...(error.extractionError ? { causeName: error.extractionError.name, causeMessage: error.extractionError.message } : {}),
      } : {}),
      ...(error instanceof z.ZodError ? validationContext(result, error.issues[0]?.path ?? []) : {}),
    });
    if (error instanceof BacktestInputError) return backtestErrors.noWrite(error.message, error.code, { statusCode: error.code === "VERSION_NOT_FOUND" ? 404 : 400 });
    const message = error instanceof HistoricalReconstructionError && !error.unexpectedFailure ? error.message
      : error instanceof z.ZodError ? "Backtest data could not be validated. Review the saved recipe and try again."
        : "Backtest could not finish. Check the historical request fields and recipe, then retry.";
    return backtestErrors.noWrite(message, "BACKTEST_FAILED", { statusCode: 409 });
  }
}
