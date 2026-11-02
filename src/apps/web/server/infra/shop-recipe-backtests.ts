import {
  parseRecipeVersion, type BacktestRecipe, type BacktestResult, type BacktestVersionComparison,
  type JsonDifference, type RecipeVersion, type TokenUsage,
} from "@muscle-memory/recipe-engine";
import type { RequestType } from "@muscle-memory/shop-domain";
import { eq } from "drizzle-orm";
import type { ShopDb } from "../db/index.js";
import { recipeVersions } from "../db/schema.js";
import type { ShopHistoricalCaseSource } from "./shop-historical-cases.js";

export type RecipeReference = string | RecipeVersion;
export class BacktestInputError extends Error {
  constructor(readonly code: "VERSION_NOT_FOUND" | "INVALID_BACKTEST", message: string) { super(message); }
}
const zero = (): TokenUsage => ({ input: 0, output: 0 });
const add = (...values: readonly TokenUsage[]): TokenUsage => values.reduce(
  (sum, value) => ({ input: sum.input + value.input, output: sum.output + value.output }), zero(),
);
const total = (tokens: TokenUsage) => tokens.input + tokens.output;
const readData = "current" as const;
const limitations = [
  "Dry-run reads use current shop data, not historical snapshots; acceptable for the seeded history.",
  "Extraction uses the real configured extractor and spends tokens. Provider failures may have unreported usage.",
  "Stored outcomes reconstruct action inputs; they do not prove original click order or mutation policy success.",
];

export type ShopBacktestResult = BacktestResult & {
  readonly summary: BacktestResult["summary"] & {
    readonly tokens: TokenUsage;
    readonly totalTokens: number;
    readonly requestExtractionTokens: TokenUsage;
    readonly recipeExtractionTokens: TokenUsage;
  };
  readonly readData: typeof readData;
  readonly limitations: readonly string[];
};
export type ShopBacktestComparison = Omit<BacktestVersionComparison, "baseline" | "candidate"> & {
  readonly baseline: ShopBacktestResult;
  readonly candidate: ShopBacktestResult;
  readonly summary: { readonly tokens: TokenUsage; readonly totalTokens: number; readonly sharedRequestExtractionTokens: TokenUsage };
};

function differenceReason(diff: JsonDifference): string {
  const show = (value: unknown) => JSON.stringify(value).slice(0, 240);
  switch (diff.kind) {
    case "added": return `${diff.path}: recipe adds ${show(diff.intended)}.`;
    case "removed": return `${diff.path}: historical ${show(diff.historical)} is absent from the recipe outcome.`;
    case "changed": return `${diff.path}: historical ${show(diff.historical)}; recipe ${show(diff.intended)}.`;
  }
}

function report(result: BacktestResult, requestTokens: TokenUsage): ShopBacktestResult {
  const recipeTokens = add(...result.cases.flatMap((c) => c.run ? [c.run.tokens] : []));
  const tokens = add(requestTokens, recipeTokens);
  return {
    ...result, readData, limitations: [...limitations],
    summary: { ...result.summary, tokens, totalTokens: total(tokens),
      requestExtractionTokens: { ...requestTokens }, recipeExtractionTokens: recipeTokens },
    cases: result.cases.map((c) => ({ ...c, reasons: [
      ...c.reasons,
      ...c.diff.map((diff) => ({ code: "different" as const, message: differenceReason(diff) })),
    ] })),
  };
}

/** App orchestration only. Each invocation has a private source and engine so
 * concurrent reports cannot share extraction usage or simulation state. */
export class ShopRecipeBacktests {
  constructor(private readonly db: ShopDb, private readonly create: () => {
    cases: ShopHistoricalCaseSource; backtester: BacktestRecipe;
  }) {}

  private async version(reference: RecipeReference): Promise<RecipeVersion> {
    let value: RecipeVersion;
    if (typeof reference === "string") {
      const [row] = await this.db.select({ snapshot: recipeVersions.snapshot }).from(recipeVersions).where(eq(recipeVersions.id, reference));
      if (!row) throw new BacktestInputError("VERSION_NOT_FOUND", "Recipe version not found.");
      value = parseRecipeVersion(row.snapshot);
    } else value = parseRecipeVersion(reference);
    if (value.trigger.event !== "request.created") throw new BacktestInputError("INVALID_BACKTEST", "Shop backtests require the request.created trigger event.");
    return value;
  }

  async execute(input: { recipe: RecipeReference; requestType: RequestType }): Promise<ShopBacktestResult> {
    const recipe = await this.version(input.recipe);
    const { cases, backtester } = this.create();
    const result = await backtester.execute({ recipe, selection: { event: recipe.trigger.event, requestType: input.requestType } });
    return report(result, cases.tokens);
  }

  async compare(input: { baseline: RecipeReference; candidate: RecipeReference; requestType: RequestType }): Promise<ShopBacktestComparison> {
    const baseline = await this.version(input.baseline);
    const candidate = await this.version(input.candidate);
    const { cases, backtester } = this.create();
    const result = await backtester.compare({ baseline, candidate, selection: { event: baseline.trigger.event, requestType: input.requestType } });
    const before = report(result.baseline, cases.tokens);
    const after = report(result.candidate, cases.tokens);
    // The shared case set was extracted once, not once per version.
    const tokens = add(cases.tokens, before.summary.recipeExtractionTokens, after.summary.recipeExtractionTokens);
    return { ...result, baseline: before, candidate: after,
      summary: { tokens, totalTokens: total(tokens), sharedRequestExtractionTokens: cases.tokens } };
  }
}
