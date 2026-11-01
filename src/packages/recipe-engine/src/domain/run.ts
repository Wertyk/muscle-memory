import type { BindingContext, JsonValue, RecipeVersion, Step } from "./model.js";

export type ActionEffect = "read" | "mutation";
export interface TokenUsage { readonly input: number; readonly output: number }
export type RunStatus = "running" | "awaiting_approval" | "completed" | "aborted" | "handed_off" | "failed";
export type StepRunStatus = "running" | "awaiting_approval" | "completed" | "rejected" | "failed" | "planned" | "blocked";

/** One attempt; gate waits reuse their attempt, explicit retries append a new one. */
export interface StepRun {
  readonly stepId: string;
  readonly kind: Step["kind"];
  readonly action: string | null;
  readonly effect: ActionEffect | null;
  readonly attempt: number;
  readonly status: StepRunStatus;
  readonly approvalRequired: boolean;
  readonly input: JsonValue;
  readonly output: JsonValue;
  readonly startedAt: number;
  readonly finishedAt: number | null;
  /** Active execution time only; approval waiting time is excluded. */
  readonly durationMs: number;
  readonly tokens: TokenUsage;
  readonly error: string | null;
  readonly blockedBy: readonly string[];
}

export interface HandoffContext {
  readonly idempotencyKey: string;
  readonly runId: string;
  readonly recipeVersionId: string;
  readonly trigger: JsonValue;
  readonly stepId: string;
  readonly to: "agent" | "human";
  readonly reason: "step" | "failure" | "interrupted";
  readonly note: JsonValue;
  readonly steps: readonly StepRun[];
  readonly outputs: BindingContext["steps"];
}

export interface Run {
  readonly id: string;
  readonly recipe: RecipeVersion;
  readonly trigger: JsonValue;
  readonly mode: "execute" | "dry-run";
  readonly status: RunStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly steps: readonly StepRun[];
  readonly pendingStepIds: readonly string[];
  readonly approvedStepIds: readonly string[];
  readonly awaitingApprovalStepId: string | null;
  readonly tokens: TokenUsage;
  readonly failure: { readonly stepId: string; readonly message: string; readonly retryable: boolean } | null;
  readonly handoff: {
    readonly context: HandoffContext;
    readonly status: "pending" | "delivered";
    readonly error: string | null;
  } | null;
}
