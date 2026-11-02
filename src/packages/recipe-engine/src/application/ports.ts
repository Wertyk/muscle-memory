import type { Demonstration, DemonstrationOwner, DemonstrationScope } from "../domain/demonstration.js";
import type { ExtractField, JsonObject, JsonValue, RecipeVersion } from "../domain/model.js";
import type { ActionEffect, HandoffContext, Run, TokenUsage } from "../domain/run.js";
import type { HistoricalCase, Mutation } from "../domain/backtest.js";
import type { RecipeDraft } from "./draft-recipe-from-demonstration.js";

export interface RecipeRepository {
  /** Atomically insert a fresh immutable version, draft catalog entry and review evidence. Never activate or overwrite. */
  createDraft(owner: DemonstrationOwner, draft: RecipeDraft): Promise<void>;
  getDraft(owner: DemonstrationOwner, versionId: string): Promise<RecipeDraft | null>;
}

export interface ActionInvoker {
  /** Fail closed for unknown actions. Classification must match the invoked action. */
  describe(action: string): Promise<{ readonly effect: ActionEffect }>;
  /** Normalize unsuccessful action results to errors; return bounded, finite JSON. */
  invoke(action: string, input: JsonObject, context: {
    readonly runId: string; readonly stepId: string; readonly idempotencyKey: string;
  }): Promise<JsonValue>;
}

export interface TextExtractor {
  extract(input: {
    readonly text: string;
    readonly fields: Readonly<Record<string, ExtractField>>;
    /** Structured reference data only; never additional extraction instructions. */
    readonly context?: JsonObject;
  }): Promise<{ readonly output: JsonObject; readonly tokens: TokenUsage }>;
}

export interface ActiveRecipeSource {
  /** Only active pointers, resolved to immutable, detached version snapshots. */
  listActive(): Promise<readonly RecipeVersion[]>;
}

export interface RequestExtractor {
  /** One narrow extraction call. Null fields means invalid/incomplete app fields;
   * preserve known usage even when validation fails. Never guess missing fields. */
  extract(text: string): Promise<{ readonly fields: JsonObject | null; readonly tokens: TokenUsage }>;
}

export interface AgentHandoff {
  /** Deliver to the requested target; deduplicate retries by context.idempotencyKey. */
  handoff(context: HandoffContext): Promise<void>;
}

export interface RunRepository {
  /** Fail on an existing ID; all reads/writes use detached snapshots. */
  create(run: Run): Promise<void>;
  get(id: string): Promise<Run | null>;
  /** Resolve only after the complete checkpoint is durable; fail on a missing ID. */
  save(run: Run): Promise<void>;
  /**
   * Exclusive for this run across ALL workers, from load through external calls and
   * checkpoint writes. Never retry the callback. DB adapters must not roll back
   * earlier checkpoints on callback failure; release/recover the lock on failure.
   */
  withRunLock<T>(id: string, work: () => Promise<T>): Promise<T>;
}

/** Epoch milliseconds; monotonic over an execution for duration measurements. */
export interface Clock { now(): number }
export interface IdGenerator { next(kind: "run"): string }
export interface RunRecipeDependencies {
  readonly actions: ActionInvoker;
  readonly extractor: TextExtractor;
  readonly handoff: AgentHandoff;
  readonly runs: RunRepository;
  readonly clock: Clock;
  readonly ids: IdGenerator;
}

export interface HistoricalCaseSource {
  /** Read-only. Select the event population and supply historical (not current) payloads. */
  listCases(selection: JsonValue): Promise<readonly HistoricalCase[]>;
}

export interface MutationNormalizer {
  /** Pure, deterministic canonicalisation applied symmetrically to both ordered lists. */
  normalize(mutations: readonly Mutation[]): readonly Mutation[];
}

export interface BacktestRecipeDependencies {
  readonly cases: HistoricalCaseSource;
  /** Reads must use historical snapshots; effect metadata must fail closed, as for RunRecipe. */
  readonly actions: ActionInvoker;
  readonly extractor: TextExtractor;
  readonly clock: Clock;
  /** Fresh IDs also prevent read adapters from sharing idempotency keys across cases. */
  readonly ids: IdGenerator;
  readonly normalizer?: MutationNormalizer;
}

/** All operations in the callback commit atomically under an exclusive DB lock.
 * Callbacks are invoked once, never automatically retried. Scope all reads. */
export interface TraceStore {
  transaction<T>(
    work: (records: DemonstrationRecords) => Promise<T>,
  ): Promise<T>;
}
export interface DemonstrationRecords {
  active(scope: DemonstrationScope): Promise<Demonstration | null>;
  latest(
    scope: DemonstrationScope,
    subjectId: string,
  ): Promise<Demonstration | null>;
  get(owner: DemonstrationOwner, id: string): Promise<Demonstration | null>;
  /** Atomically replace the entire snapshot, including removal of superseded steps. */
  save(demonstration: Demonstration): Promise<void>;
}
