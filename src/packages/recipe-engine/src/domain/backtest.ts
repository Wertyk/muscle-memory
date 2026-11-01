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
}

/** JSON Pointer paths. Added/removed mean present only in intended/historical respectively. */
export type JsonDifference =
  | { readonly kind: "added"; readonly path: string; readonly intended: JsonValue }
  | { readonly kind: "removed"; readonly path: string; readonly historical: JsonValue }
  | { readonly kind: "changed"; readonly path: string; readonly historical: JsonValue; readonly intended: JsonValue };

export type BacktestStatus = "identical" | "different" | "not_handled";
export interface BacktestReason {
  readonly code: "identical" | "different" | "trigger-mismatch" | "trigger-error" |
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
  readonly diff: readonly JsonDifference[];
  /** Case-local dry-run evidence, never a persisted production run. */
  readonly run: Run | null;
}

export interface BacktestResult {
  readonly recipeVersionId: string;
  readonly summary: {
    readonly total: number;
    readonly identical: number;
    readonly different: number;
    readonly notHandled: number;
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
    /** Status or normalised intended mutations changed; see each report for reasons. */
    readonly changed: boolean;
    /** historical = baseline intended mutations; intended = candidate intended mutations. */
    readonly diff: readonly JsonDifference[];
  }[];
}
