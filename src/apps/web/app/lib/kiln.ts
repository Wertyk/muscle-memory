import type { StepRun } from "@muscle-memory/recipe-engine";
import type { RequestProcessing } from "@shared/request-processing";

export interface RecipeOutcome {
  status: string | null;
  mode: string | null;
  recipeName: string;
  version: number;
  tokens: number | null;
}
export const isRecipeOutcome = (outcome: RecipeOutcome) =>
  outcome.status === "completed" && outcome.mode === "execute";

export function inboxOutcome(row: RequestProcessing) {
  if (row.runStatus === "completed" && row.mode === "execute" && row.recipe)
    return "recipe";
  if (row.state === "awaiting_approval") return "approval";
  if (row.state === "with_agent" || row.runStatus === "handed_off") return "agent";
  return "other";
}

/** Only IDs returned by this intake, absent before it started, may enter. */
export function newArrivalIds(previous: readonly string[], arrived: readonly string[], revealed: readonly string[] = []) {
  const known = new Set([...previous, ...revealed]);
  return [...new Set(arrived)].filter(id => !known.has(id));
}

export function intakeSummary(ids: readonly string[], rows: readonly RequestProcessing[]) {
  const requested = [...new Set(ids)];
  const byId = new Map<string, RequestProcessing>(rows.map(row => [row.requestId, row]));
  const counts = { recipe: 0, approval: 0, agent: 0, other: 0 };
  for (const id of requested) {
    const row = byId.get(id);
    counts[row ? inboxOutcome(row) : "other"]++;
  }
  return [
    `${requested.length} arrived`,
    counts.recipe && `${counts.recipe} handled by recipes`,
    counts.approval && `${counts.approval} awaiting approval`,
    counts.agent && `${counts.agent} with agent`,
    counts.other && `${counts.other} still processing`,
  ].filter(Boolean).join(" · ");
}

/** CSS supplies the 2px minimum independently of the responsive track width. */
export function waterfallPercent(ms: number, totalMs: number) {
  if (!Number.isFinite(ms) || !Number.isFinite(totalMs) || totalMs <= 0) return 0;
  return Math.min(100, Math.max(0, ms / totalMs * 100));
}
export function waterfallKind(step: Pick<StepRun, "kind" | "effect" | "approvalRequired">) {
  if (step.approvalRequired) return "approval";
  if (step.kind === "handoff") return "handoff";
  if (step.kind === "action" && step.effect === "read") return "lookup";
  return step.kind;
}
