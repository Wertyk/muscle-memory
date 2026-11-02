import type { BacktestResult, BacktestVersionComparison, TokenUsage } from "@muscle-memory/recipe-engine";
import { REQUEST_TYPES } from "@muscle-memory/shop-domain";
import { z } from "zod";

export type ShopBacktestResult = BacktestResult & {
  readonly summary: BacktestResult["summary"] & {
    readonly tokens: TokenUsage;
    readonly totalTokens: number;
    readonly requestExtractionTokens: TokenUsage;
    readonly recipeExtractionTokens: TokenUsage;
  };
  readonly readData: "current";
  readonly limitations: readonly string[];
};
export type ShopBacktestComparison = Omit<BacktestVersionComparison, "baseline" | "candidate"> & {
  readonly baseline: ShopBacktestResult;
  readonly candidate: ShopBacktestResult;
  readonly summary: { readonly tokens: TokenUsage; readonly totalTokens: number; readonly sharedRequestExtractionTokens: TokenUsage };
};

export const RECIPE_BACKTEST_STATE = "recipe-backtest";
const count = z.number().int().nonnegative();
/** Only the small summary actually shown in this tab, never a persisted report. */
export const shownBacktestSchema = z.object({
  recipeId: z.string(),
  source: z.enum(["backtest", "comparison"]),
  requestType: z.enum(REQUEST_TYPES),
  reports: z.array(z.object({
    recipeVersionId: z.string(),
    version: count,
    summary: z.object({ total: count, identical: count, different: count, notHandled: count, totalTokens: count }),
  })).min(1).max(2),
  totalTokens: count,
});
export type ShownBacktest = z.infer<typeof shownBacktestSchema>;
