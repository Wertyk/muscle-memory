import type { Binding, BindingTree, JsonObject, JsonValue, Run, Step, StepRun } from "@muscle-memory/recipe-engine";

import { argumentLabel, atPath, bindingLabel, isObject, presentationContext, stepLabel, valueSummary } from "./recipe-presentation";

export type ReplayTarget = "order-actions" | "order-operation" | "order-preview" | "reply-composer" | "add-tag" | "tag-input" | "request-status";
export interface ReplayPhase { target: ReplayTarget | null; view: "workspace" | "order-menu" | "order-preview" | "reply" | "tag" | "status" }
export interface ReplayValue { path: string; label: string; value: string; source: string | undefined }
export interface ReplayStep {
  saved: StepRun;
  name: string;
  caption: string;
  values: readonly ReplayValue[];
  phases: readonly ReplayPhase[];
}
type Translate = (key: string, values?: Record<string, string | number>) => string;
const orderActions = new Set(["issue-refund", "create-replacement-order", "update-shipping-address", "generate-return-label"]);

export function replayPhases(step: StepRun): readonly ReplayPhase[] {
  if (step.effect === "mutation" && orderActions.has(step.action ?? "")) return [
    { target: "order-actions", view: "workspace" },
    { target: "order-operation", view: "order-menu" },
    { target: "order-preview", view: "order-preview" },
  ];
  if (step.effect === "mutation" && step.action === "send-reply") return [{ target: "reply-composer", view: "reply" }];
  if (step.effect === "mutation" && step.action === "tag-request") return [{ target: "add-tag", view: "workspace" }, { target: "tag-input", view: "tag" }];
  if (step.effect === "mutation" && (step.action === "set-request-status" || step.action === "escalate")) return [{ target: "request-status", view: "status" }];
  return [{ target: null, view: "workspace" }];
}

export function canReplay(run: Run) {
  return run.status === "completed" && run.mode === "execute" && run.steps.some((step) => step.status === "completed");
}

/** Only saved attempts are replayed, in checkpoint order, never the unexecuted branch. */
export function replaySteps(run: Run, t: Translate): readonly ReplayStep[] {
  if (!canReplay(run)) return [];
  const definitions = new Map<string, Step>();
  const visit = (steps: readonly Step[]) => steps.forEach((step) => {
    definitions.set(step.id, step);
    if (step.kind === "branch") { visit(step.then); visit(step.else); }
  });
  visit(run.recipe.steps);
  const context = presentationContext(run);
  const labels = Object.fromEntries([...definitions].map(([id, step]) => [id, stepLabel({ kind: step.kind, action: step.kind === "action" ? step.action : null }, t)]));
  return run.steps.filter((step) => step.status === "completed").map((saved) => {
    const definition = definitions.get(saved.stepId);
    const values: ReplayValue[] = [];
    const walk = (value: JsonValue, binding: BindingTree | undefined, path: string, depth = 0) => {
      const leaf = isObject(binding) && ["fixed", "path", "expr", "template"].includes(String(binding.mode));
      const money = isObject(value) && typeof value.amountMinor === "number" && typeof value.currency === "string";
      if (!leaf && !money && isObject(value) && depth < 6 && Object.keys(value).length) {
        Object.entries(value).forEach(([key, child]) => walk(child, isObject(binding) ? (binding as Readonly<Record<string, BindingTree>>)[key] : undefined, path ? `${path}.${key}` : key, depth + 1));
        return;
      }
      const source = money && !leaf && isObject(binding) ? (binding as Readonly<Record<string, BindingTree>>).amountMinor : binding;
      values.push({ path, label: argumentLabel(path, saved.action ?? ""), value: valueSummary(value, context), source: isObject(source) && typeof source.mode === "string" ? bindingLabel(source as unknown as Binding, labels) : undefined });
    };
    if (isObject(saved.input)) Object.entries(saved.input).forEach(([key, value]) => walk(value, definition?.kind === "action" ? definition.args[key] : undefined, key));
    else if (saved.input !== null) walk(saved.input, undefined, "input");
    const name = stepLabel(saved, t);
    const id = isObject(saved.input) ? saved.input.orderId ?? saved.input.requestId ?? saved.input.customerId : null;
    const lookupKey = ({ "get-order": "order", "get-request": "request", "get-customer": "customer", "get-shipment-status": "shipment" } as Record<string, string>)[saved.action ?? ""];
    const caption = saved.effect === "read" && lookupKey && typeof id === "string"
      ? t(`runs.replay.lookups.${lookupKey}`, { id })
      : t("runs.replay.recorded", { name });
    return { saved, name, caption, values, phases: replayPhases(saved) };
  });
}

/** Historical read snapshots only. Missing panels stay missing; no live data fallback. */
export function replayWorkspace(run: Run, through: StepRun) {
  const steps = run.steps.slice(0, run.steps.indexOf(through) + 1);
  const snapshot = (action: string): JsonObject | undefined => {
    const step = [...steps].reverse().find((step) => step.status === "completed" && step.action === action);
    return isObject(step?.output) ? step.output : undefined;
  };
  return { request: snapshot("get-request"), order: snapshot("get-order"), customer: snapshot("get-customer"), shipment: snapshot("get-shipment-status") };
}

export const savedText = (value: JsonValue | undefined) => typeof value === "string" ? value : "";
export function savedReply(step: StepRun) {
  return savedText(atPath(step.output, ["body"])) || savedText(atPath(step.input, ["template"]));
}

export interface ReplayState { status: "playing" | "paused" | "ended" | "closed"; index: number; phase: number }
export type ReplayEvent = "play" | "pause" | "next" | "previous" | "tick" | "exit";
export const initialReplayState: ReplayState = { status: "playing", index: 0, phase: 0 };
export function transitionReplay(state: ReplayState, event: ReplayEvent, steps: readonly ReplayStep[], reducedMotion = false): ReplayState {
  if (event === "exit") return { ...state, status: "closed" };
  if (state.status === "closed") return state;
  if (!steps.length) return { ...state, status: "ended", index: 0, phase: 0 };
  if (event === "pause") return state.status === "playing" ? { ...state, status: "paused" } : state;
  if (event === "play") return state.status === "ended" ? { ...initialReplayState } : { ...state, status: "playing" };
  if (event === "previous") {
    const index = Math.max(0, state.index - 1);
    return { status: "paused", index, phase: (steps[index]?.phases.length ?? 1) - 1 };
  }
  if (event === "tick" && state.status !== "playing") return state;
  if (event === "tick" && !reducedMotion && state.phase + 1 < (steps[state.index]?.phases.length ?? 1)) return { ...state, phase: state.phase + 1 };
  if (state.index + 1 >= steps.length) return { ...state, status: "ended" };
  const index = state.index + 1;
  return { status: event === "next" ? "paused" : "playing", index, phase: event === "next" ? (steps[index]?.phases.length ?? 1) - 1 : 0 };
}
