import type { JsonObject, JsonValue } from "./model.js";
import type { Run } from "./run.js";

export interface Mutation {
  readonly action: string;
  readonly input: JsonObject;
}

export interface HistoricalCase {
  readonly id: string;
  readonly trigger: JsonValue;
  readonly outcome: readonly Mutation[];
  /** Safe source diagnostic; this case must never be matched or simulated. */
  readonly reconstructionFailure?: string;
}

/** JSON Pointer paths. Added/removed mean present only in intended/historical respectively. */
export type JsonDifference =
  | { readonly kind: "added"; readonly path: string; readonly intended: JsonValue }
  | { readonly kind: "removed"; readonly path: string; readonly historical: JsonValue }
  | { readonly kind: "changed"; readonly path: string; readonly historical: JsonValue; readonly intended: JsonValue };

export type DifferenceClassification = "outcome" | "wording" | "bookkeeping";
export type ClassifiedDifference = JsonDifference & { readonly classification: DifferenceClassification };

/** Legacy wire values: identical/different refer to outcomes, not literal equality. */
export type BacktestStatus = "identical" | "different" | "not_handled";
export interface BacktestReason {
  readonly code: "identical" | "different" | "wording" | "bookkeeping" | "reconstruction-failed" | "trigger-mismatch" | "trigger-error" |
    "execution-error" | "failed" | "blocked" | "handoff" | "no-mutations";
  readonly message: string;
  readonly stepId?: string;
  readonly blockedBy?: readonly string[];
}

export interface BacktestCaseResult {
  readonly caseId: string;
  readonly status: BacktestStatus;
  readonly reasons: readonly BacktestReason[];
  /** Original evidence; the optional normaliser affects diff, not these lists. */
  readonly historicalMutations: readonly Mutation[];
  readonly intendedMutations: readonly Mutation[];
  readonly diff: readonly ClassifiedDifference[];
  /** Case-local dry-run evidence, never a persisted production run. */
  readonly run: Run | null;
}

export interface BacktestResult {
  readonly recipeVersionId: string;
  readonly summary: {
    readonly total: number;
    readonly sameOutcome: number;
    readonly differentOutcome: number;
    readonly notHandled: number;
    /** Subset of sameOutcome with wording and/or bookkeeping differences. */
    readonly nonOutcomeOnly: number;
  };
  readonly cases: readonly BacktestCaseResult[];
}

export interface BacktestVersionComparison {
  readonly baseline: BacktestResult;
  readonly candidate: BacktestResult;
  readonly cases: readonly {
    readonly caseId: string;
    readonly baselineStatus: BacktestStatus;
    readonly candidateStatus: BacktestStatus;
    /** Status or outcome-classified intended mutations changed. */
    readonly changed: boolean;
    readonly nonOutcomeOnly: boolean;
    /** historical = baseline intended mutations; intended = candidate intended mutations. */
    readonly diff: readonly ClassifiedDifference[];
  }[];
}
