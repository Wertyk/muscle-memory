import type {
  JsonObject,
  JsonValue,
  Run,
  RunStatus,
  StepRun,
} from "@muscle-memory/recipe-engine";

export const RUN_STATUSES = [
  "running",
  "awaiting_approval",
  "completed",
  "aborted",
  "handed_off",
  "failed",
] as const;
export interface RunFilters {
  status?: RunStatus | undefined;
  requestId?: string | undefined;
  recipeId?: string | undefined;
  mode?: Run["mode"] | undefined;
}
export interface RunSummary {
  id: string;
  requestId: string | null;
  requestSubject: string | null;
  recipeId: string;
  recipeVersionId: string;
  recipeName: string;
  version: number;
  status: RunStatus;
  mode: Run["mode"];
  createdAt: number;
  updatedAt: number;
  durationMs: number;
  tokens: Run["tokens"];
}
export function runRequestId(trigger: JsonValue): string | null {
  if (!trigger || typeof trigger !== "object" || Array.isArray(trigger))
    return null;
  const object = trigger as JsonObject;
  const id = object.requestId ?? object.id;
  return typeof id === "string" && /^req_[A-Za-z0-9_-]+$/.test(id) ? id : null;
}
export const runDuration = (run: Run) =>
  run.steps.reduce((total, step) => total + step.durationMs, 0);
export function summarizeRun(
  run: Run,
  requestSubject: string | null = null,
): RunSummary {
  return {
    id: run.id,
    requestId: runRequestId(run.trigger),
    requestSubject,
    recipeId: run.recipe.recipeId,
    recipeVersionId: run.recipe.id,
    recipeName: run.recipe.name,
    version: run.recipe.version,
    status: run.status,
    mode: run.mode,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    durationMs: runDuration(run),
    tokens: run.tokens,
  };
}
export function awaitingStep(run: Run): StepRun | undefined {
  return run.status === "awaiting_approval"
    ? [...run.steps]
        .reverse()
        .find(
          (step) =>
            step.stepId === run.awaitingApprovalStepId &&
            step.status === "awaiting_approval",
        )
    : undefined;
}
export const RUN_CARD_RENDERER = "muscle-memory.recipe-run";
export const APPROVAL_CARD_RENDERER = "muscle-memory.recipe-approval";
