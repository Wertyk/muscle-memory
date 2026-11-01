import {
  evaluateCondition, expressionPaths, isBinding, pathSegments, resolveArguments,
  resolveBinding, templatePaths,
} from "../domain/evaluation.js";
import { hasOwn, immutableSnapshot, isIdentifier, isJsonValue } from "../domain/json.js";
import type { BindingContext, BindingTree, ExtractStep, JsonObject, JsonValue, RecipeVersion, Step } from "../domain/model.js";
import type { HandoffContext, Run, StepRun, StepRunStatus, TokenUsage } from "../domain/run.js";
import type { RunRecipeDependencies } from "./ports.js";
import { parseRecipeVersion } from "./recipe-schema.js";

export interface StartRun {
  readonly recipe: RecipeVersion;
  readonly trigger: JsonValue;
  readonly mode?: Run["mode"];
}
export interface ResumeRun {
  readonly runId: string;
  readonly approval?: { readonly stepId: string; readonly decision: "approve" | "reject" };
  /** Explicitly retry a safe failed step after handoff; never replay an uncertain mutation. */
  readonly retry?: boolean;
}

const zeroTokens = (): TokenUsage => ({ input: 0, output: 0 });
const message = (error: unknown): string => error instanceof Error ? error.message : "Unexpected execution failure";

function outputs(run: Run): BindingContext["steps"] {
  return Object.fromEntries(run.steps.filter((log) => log.status === "completed" &&
    (log.kind === "action" || log.kind === "extract")).map((log) => [log.stepId, { output: log.output }]));
}

function bindingPaths(tree: BindingTree): readonly string[] {
  if (!isBinding(tree)) return Object.values(tree).flatMap(bindingPaths);
  switch (tree.mode) {
    case "fixed": return [];
    case "path": return [tree.path];
    case "expr": return expressionPaths(tree.expr);
    case "template": return templatePaths(tree.template);
  }
}

/** Missing dry-run outputs must not silently select a branch via a var default. */
function blockedPaths(run: Run, step: Step): readonly string[] {
  const unavailable = new Set(run.steps.filter((log) =>
    (log.status === "planned" || log.status === "blocked") &&
    (log.kind === "action" || log.kind === "extract")).map((log) => log.stepId));
  const paths = step.approval === undefined ? [] : [...expressionPaths(step.approval)];
  switch (step.kind) {
    case "action": paths.push(...Object.values(step.args).flatMap(bindingPaths)); break;
    case "extract": paths.push(...bindingPaths(step.text)); break;
    case "branch": paths.push(...expressionPaths(step.condition)); break;
    case "handoff": paths.push(...bindingPaths(step.note)); break;
  }
  return [...new Set(paths.filter((path) => {
    const parts = pathSegments(path);
    return parts[0] === "steps" && unavailable.has(parts[1]!);
  }))];
}

function indexSteps(steps: readonly Step[], index = new Map<string, Step>()): Map<string, Step> {
  for (const step of steps) {
    index.set(step.id, step);
    if (step.kind === "branch") { indexSteps(step.then, index); indexSteps(step.else, index); }
  }
  return index;
}

function putLog(run: Run, log: StepRun): Run {
  const index = run.steps.findIndex((entry) => entry.stepId === log.stepId && entry.attempt === log.attempt);
  const steps = [...run.steps];
  if (index < 0) steps.push(log); else steps[index] = log;
  const tokens = steps.reduce((sum, entry) => ({ input: sum.input + entry.tokens.input, output: sum.output + entry.tokens.output }), zeroTokens());
  return { ...run, steps, tokens };
}

function lastAttempt(run: Run, stepId: string): StepRun | undefined {
  const logs = run.steps.filter((entry) => entry.stepId === stepId);
  // The web consumer typechecks workspace sources with an ES2020 library target.
  return logs[logs.length - 1];
}

function validTokens(tokens: TokenUsage): boolean {
  return tokens != null && Number.isSafeInteger(tokens.input) && tokens.input >= 0 &&
    Number.isSafeInteger(tokens.output) && tokens.output >= 0;
}

function validateExtraction(output: JsonObject, step: ExtractStep): void {
  if (!isJsonValue(output) || output === null || Array.isArray(output) || typeof output !== "object") {
    throw new Error("Extractor must return a finite JSON object");
  }
  for (const key of Object.keys(output)) {
    if (!hasOwn(step.fields, key)) throw new Error(`Unexpected extracted field: ${key}`);
  }
  for (const [key, field] of Object.entries(step.fields)) {
    if (!hasOwn(output, key)) {
      if (field.required) throw new Error(`Missing extracted field: ${key}`);
    } else if (typeof output[key] !== field.type) throw new Error(`Invalid extracted field: ${key}`);
  }
}

/** Pure orchestration; all outside-world operations are supplied by ports. */
export class RunRecipe {
  constructor(private readonly deps: RunRecipeDependencies) {}

  async execute(input: StartRun): Promise<Run> {
    const recipe = parseRecipeVersion(input.recipe);
    if (!isJsonValue(input.trigger)) throw new Error("Trigger must be bounded finite JSON");
    if (input.mode !== undefined && input.mode !== "execute" && input.mode !== "dry-run") throw new Error("Unknown run mode");
    const id = this.deps.ids.next("run");
    if (!isIdentifier(id) || id.length > 31 || !id.startsWith("run_")) throw new Error("Expected a short run identifier");
    const timestamp = this.now();
    const run: Run = immutableSnapshot({
      id, recipe, trigger: input.trigger, mode: input.mode ?? "execute", status: "running",
      createdAt: timestamp, updatedAt: timestamp, steps: [], pendingStepIds: recipe.steps.map((step) => step.id),
      approvedStepIds: [], awaitingApprovalStepId: null, tokens: zeroTokens(), failure: null, handoff: null,
    });
    return this.deps.runs.withRunLock(id, async () => {
      await this.deps.runs.create(run);
      return this.advance(run);
    });
  }

  resume(input: ResumeRun): Promise<Run> {
    return this.deps.runs.withRunLock(input.runId, async () => {
      let run = await this.deps.runs.get(input.runId);
      if (!run) throw new Error(`Run not found: ${input.runId}`);
      // Delivery retries never re-enter the action that caused the handoff.
      if (run.handoff?.status === "pending") return this.deliverHandoff(run);
      if (run.status === "awaiting_approval") {
        if (!input.approval) return run;
        if (input.approval.stepId !== run.awaitingApprovalStepId) {
          if (run.approvedStepIds.includes(input.approval.stepId)) return run;
          throw new Error("Approval does not match the pending step");
        }
        if (input.approval.decision !== "approve" && input.approval.decision !== "reject") throw new Error("Unknown approval decision");
        if (input.approval.decision === "reject") {
          const log = run.steps.find((entry) => entry.stepId === run!.awaitingApprovalStepId && entry.status === "awaiting_approval")!;
          return this.save({ ...putLog(run, { ...log, status: "rejected", finishedAt: this.now() }), status: "aborted", awaitingApprovalStepId: null });
        }
        run = await this.save({ ...run, status: "running", awaitingApprovalStepId: null,
          approvedStepIds: [...run.approvedStepIds, input.approval.stepId] });
      } else if ((run.status === "handed_off" || run.status === "failed") && input.retry && run.failure?.retryable) {
        run = await this.save({ ...run, status: "running", failure: null, handoff: null });
      } else if (run.status !== "running") return run;
      return this.advance(run);
    });
  }

  private now(): number {
    const timestamp = this.deps.clock.now();
    if (!Number.isFinite(timestamp)) throw new Error("Clock must return finite epoch milliseconds");
    return timestamp;
  }

  private async save(run: Run): Promise<Run> {
    const snapshot = immutableSnapshot({ ...run, updatedAt: this.now() });
    await this.deps.runs.save(snapshot);
    return snapshot;
  }

  private finish(log: StepRun, status: StepRunStatus, output: JsonValue = log.output): StepRun {
    const timestamp = this.now();
    return { ...log, status, output, finishedAt: timestamp, durationMs: log.durationMs + Math.max(0, timestamp - log.startedAt) };
  }

  private async advance(initial: Run): Promise<Run> {
    let run = initial;
    const index = indexSteps(run.recipe.steps);
    while (run.status === "running" && run.pendingStepIds.length > 0) {
      const step = index.get(run.pendingStepIds[0]!)!;
      const previous = lastAttempt(run, step.id);
      if (previous?.status === "running") {
        return this.fail(run, previous, "Execution interrupted; external outcome may be unknown", "interrupted");
      }
      // Checkpoint implementations may restore a cursor lagging a completed step.
      if (previous?.status === "completed" || previous?.status === "planned" || previous?.status === "blocked") {
        const children = step.kind === "branch" && previous.status === "completed"
          ? ((previous.output as JsonObject).branch === "then" ? step.then : step.else).map((child) => child.id) : [];
        run = await this.save({ ...run, pendingStepIds: [...children, ...run.pendingStepIds.slice(1)] });
        continue;
      }
      run = await this.runStep(run, step, previous);
    }
    return run.status === "running" ? this.save({ ...run, status: "completed" }) : run;
  }

  private async prepare(run: Run, step: Step, initial: StepRun): Promise<StepRun> {
    let log = initial;
    if (step.kind === "action") {
      const { effect } = await this.deps.actions.describe(step.action);
      if (effect !== "read" && effect !== "mutation") throw new Error(`Unknown action effect: ${step.action}`);
      log = { ...log, effect };
    }
    const blockedBy = blockedPaths(run, step);
    if (blockedBy.length) return { ...log, blockedBy, error: "Depends on an unexecuted dry-run output" };
    const context = { trigger: run.trigger, steps: outputs(run) };
    const approvalRequired = step.approval !== undefined && evaluateCondition(step.approval, context);
    let input: JsonValue;
    switch (step.kind) {
      case "action": input = resolveArguments(step.args, context); break;
      case "extract": {
        const text = resolveBinding(step.text, context);
        if (typeof text !== "string") throw new Error("Extract text must resolve to a string");
        const fields = Object.fromEntries(Object.entries(step.fields).map(([key, field]) => [key, {
          type: field.type, required: field.required, ...(field.description === undefined ? {} : { description: field.description }),
        }]));
        input = { text, fields }; break;
      }
      case "branch": input = { condition: step.condition }; break;
      case "handoff": input = { to: step.to, note: resolveBinding(step.note, context) }; break;
    }
    return { ...log, input, approvalRequired };
  }

  private async runStep(run: Run, step: Step, previous: StepRun | undefined): Promise<Run> {
    let log: StepRun = {
      stepId: step.id, kind: step.kind, action: step.kind === "action" ? step.action : null, effect: null,
      attempt: previous?.status === "awaiting_approval" ? previous.attempt : (previous?.attempt ?? 0) + 1,
      status: "running", approvalRequired: false, input: null, output: null, startedAt: this.now(), finishedAt: null,
      durationMs: previous?.status === "awaiting_approval" ? previous.durationMs : 0,
      tokens: zeroTokens(), error: null, blockedBy: [],
    };
    try { log = await this.prepare(run, step, log); }
    catch (error) { return this.fail(run, log, message(error)); }
    if (log.blockedBy.length) {
      return this.save({ ...putLog(run, this.finish(log, "blocked")), pendingStepIds: run.pendingStepIds.slice(1) });
    }
    if (log.approvalRequired && run.mode === "execute" && !run.approvedStepIds.includes(step.id)) {
      log = { ...this.finish(log, "awaiting_approval"), finishedAt: null };
      return this.save({ ...putLog(run, log), status: "awaiting_approval", awaitingApprovalStepId: step.id });
    }
    // Durable intent BEFORE invoking an external port. Persistence errors propagate,
    // leaving this checkpoint for safe recovery instead of pretending an action failed.
    log = immutableSnapshot(log);
    run = await this.save(putLog(run, log));
    let output: JsonValue = null;
    let children: readonly string[] = [];
    try {
      switch (step.kind) {
        case "action":
          if (run.mode === "dry-run" && log.effect === "mutation") {
            return this.save({ ...putLog(run, this.finish(log, "planned")), pendingStepIds: run.pendingStepIds.slice(1) });
          }
          output = await this.deps.actions.invoke(step.action, log.input as JsonObject, {
            runId: run.id, stepId: step.id, idempotencyKey: `${run.id}:${step.id}`,
          });
          if (!isJsonValue(output)) throw new Error("Action output must be bounded finite JSON");
          break;
        case "extract": {
          const result = await this.deps.extractor.extract({ text: (log.input as JsonObject).text as string, fields: step.fields });
          if (!validTokens(result.tokens)) throw new Error("Extractor returned invalid token usage");
          log = { ...log, tokens: { input: result.tokens.input, output: result.tokens.output } };
          validateExtraction(result.output, step);
          output = result.output;
          break;
        }
        case "branch": {
          const choice = evaluateCondition(step.condition, { trigger: run.trigger, steps: outputs(run) }) ? "then" : "else";
          output = { branch: choice };
          children = step[choice].map((child) => child.id);
          break;
        }
        case "handoff":
          if (run.mode === "execute") return this.queueHandoff(run, log, "step", step.to, (log.input as JsonObject).note!);
          return this.save({ ...putLog(run, this.finish(log, "planned", log.input)), status: "completed", pendingStepIds: [] });
      }
    } catch (error) { return this.fail(run, log, message(error)); }
    return this.save({ ...putLog(run, this.finish(log, "completed", output)), pendingStepIds: [...children, ...run.pendingStepIds.slice(1)] });
  }

  private fail(run: Run, log: StepRun, error: string, reason: "failure" | "interrupted" = "failure"): Promise<Run> {
    const failed = this.finish({ ...log, error }, "failed");
    run = { ...putLog(run, failed), status: "failed", failure: { stepId: log.stepId, message: error,
      retryable: log.effect !== "mutation" && log.kind !== "handoff" } };
    if (run.mode === "dry-run") return this.save(run);
    return this.queueHandoff(run, failed, reason, "agent", error);
  }

  private async queueHandoff(run: Run, log: StepRun, reason: HandoffContext["reason"], to: HandoffContext["to"], note: JsonValue): Promise<Run> {
    const context: HandoffContext = {
      idempotencyKey: `${run.id}:handoff:${log.stepId}:${log.attempt}`, runId: run.id, recipeVersionId: run.recipe.id,
      trigger: run.trigger, stepId: log.stepId, to, reason, note, steps: run.steps, outputs: outputs(run),
    };
    run = await this.save({ ...run, handoff: { context, status: "pending", error: null } });
    return this.deliverHandoff(run);
  }

  private async deliverHandoff(run: Run): Promise<Run> {
    const handoff = run.handoff!;
    const startedAt = this.now();
    let error: string | null = null;
    try { await this.deps.handoff.handoff(handoff.context); }
    catch (cause) { error = message(cause); }
    if (handoff.context.reason === "step") {
      const log = lastAttempt(run, handoff.context.stepId)!;
      run = putLog(run, this.finish({ ...log, startedAt, error }, error === null ? "completed" : "failed", {
        to: handoff.context.to, note: handoff.context.note,
      }));
    }
    return this.save({ ...run, status: error === null ? "handed_off" : "failed",
      handoff: { ...handoff, status: error === null ? "delivered" : "pending", error } });
  }
}
