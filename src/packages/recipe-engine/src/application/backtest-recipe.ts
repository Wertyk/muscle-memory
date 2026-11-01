import type {
  BacktestCaseResult, BacktestReason, BacktestResult, BacktestVersionComparison, HistoricalCase, Mutation,
} from "../domain/backtest.js";
import { evaluateCondition } from "../domain/evaluation.js";
import { diffJson } from "../domain/json-diff.js";
import { immutableSnapshot, isJsonValue } from "../domain/json.js";
import type { JsonObject, JsonValue, RecipeVersion } from "../domain/model.js";
import type { Run } from "../domain/run.js";
import type { BacktestRecipeDependencies, RunRepository } from "./ports.js";
import { parseRecipeVersion } from "./recipe-schema.js";
import { RunRecipe } from "./run-recipe.js";

export interface StartBacktest {
  readonly recipe: RecipeVersion;
  /** Opaque query understood by HistoricalCaseSource, including event selection. */
  readonly selection: JsonValue;
}
export interface CompareBacktestVersions {
  readonly baseline: RecipeVersion;
  readonly candidate: RecipeVersion;
  readonly selection: JsonValue;
}

interface EvaluatedCase {
  readonly result: BacktestCaseResult;
  readonly normalizedIntended: readonly Mutation[];
}

const message = (error: unknown): string => error instanceof Error ? error.message : "Unexpected simulation failure";
const mutationJson = (mutations: readonly Mutation[]): JsonValue => mutations.map(({ action, input }) => ({ action, input }));

function validateMutations(mutations: readonly Mutation[]): void {
  if (!isJsonValue(mutations) || !Array.isArray(mutations) || mutations.some((mutation) =>
    mutation === null || typeof mutation !== "object" || typeof mutation.action !== "string" ||
    mutation.action.trim().length === 0 || mutation.input === null || typeof mutation.input !== "object" ||
    Array.isArray(mutation.input))) throw new Error("Expected a bounded JSON mutation list with action and object input");
}

/** Pure orchestration over read-only ports; all executor checkpoints stay case-local. */
export class BacktestRecipe {
  constructor(private readonly deps: BacktestRecipeDependencies) {}

  async execute(input: StartBacktest): Promise<BacktestResult> {
    const recipe = parseRecipeVersion(input.recipe);
    const cases = await this.loadCases(input.selection);
    return this.report(recipe, await this.evaluate(recipe, cases));
  }

  async compare(input: CompareBacktestVersions): Promise<BacktestVersionComparison> {
    const baseline = parseRecipeVersion(input.baseline);
    const candidate = parseRecipeVersion(input.candidate);
    if (baseline.trigger.event !== candidate.trigger.event) throw new Error("Version comparison requires the same trigger event");
    const cases = await this.loadCases(input.selection);
    const before = await this.evaluate(baseline, cases);
    const after = await this.evaluate(candidate, cases);
    return immutableSnapshot({
      baseline: this.report(baseline, before), candidate: this.report(candidate, after),
      cases: cases.map((historical, index) => {
        const a = before[index]!;
        const b = after[index]!;
        const diff = diffJson(mutationJson(a.normalizedIntended), mutationJson(b.normalizedIntended));
        return { caseId: historical.id, baselineStatus: a.result.status, candidateStatus: b.result.status,
          changed: a.result.status !== b.result.status || diff.length > 0, diff };
      }),
    });
  }

  private async loadCases(selection: JsonValue): Promise<readonly HistoricalCase[]> {
    if (!isJsonValue(selection)) throw new Error("Selection must be bounded finite JSON");
    const cases = await this.deps.cases.listCases(immutableSnapshot(selection));
    if (!Array.isArray(cases)) throw new Error("Historical cases must be a list");
    const ids = new Set<string>();
    for (const historical of cases) {
      if (historical === null || typeof historical !== "object" || typeof historical.id !== "string" ||
        !historical.id.trim() || ids.has(historical.id)) throw new Error("Historical cases require unique nonempty IDs");
      ids.add(historical.id);
      if (!isJsonValue(historical.trigger)) throw new Error(`Invalid historical trigger: ${historical.id}`);
      validateMutations(historical.outcome);
    }
    return immutableSnapshot(cases.map(({ id, trigger, outcome }) => ({ id, trigger, outcome })));
  }

  private normalize(mutations: readonly Mutation[]): readonly Mutation[] {
    const normalized = this.deps.normalizer ? this.deps.normalizer.normalize(immutableSnapshot(mutations)) : mutations;
    validateMutations(normalized);
    return immutableSnapshot(normalized);
  }

  private async evaluate(recipe: RecipeVersion, cases: readonly HistoricalCase[]): Promise<readonly EvaluatedCase[]> {
    const results: EvaluatedCase[] = [];
    for (const historical of cases) results.push(await this.evaluateCase(recipe, historical));
    return results;
  }

  private async evaluateCase(recipe: RecipeVersion, historical: HistoricalCase): Promise<EvaluatedCase> {
    const reasons: BacktestReason[] = [];
    let run: Run | null = null;
    let matches = false;
    try { matches = evaluateCondition(recipe.trigger.match, { trigger: historical.trigger, steps: {} }); }
    catch (error) { reasons.push({ code: "trigger-error", message: message(error) }); }
    if (!matches && reasons.length === 0) reasons.push({ code: "trigger-mismatch", message: "Trigger condition did not match" });
    if (matches) {
      try { run = await this.simulate(recipe, historical.trigger); }
      catch (error) { reasons.push({ code: "execution-error", message: message(error) }); }
    }
    for (const step of run?.steps ?? []) {
      if (step.status === "failed") reasons.push({ code: "failed", stepId: step.stepId, message: step.error ?? "Step failed" });
      if (step.status === "blocked") reasons.push({ code: "blocked", stepId: step.stepId,
        message: "Depends on an unavailable dry-run output", blockedBy: step.blockedBy });
      if (step.kind === "handoff" && step.status === "planned") reasons.push({ code: "handoff", stepId: step.stepId,
        message: `Recipe requests handoff: ${JSON.stringify(step.input)}` });
    }
    const intended = (run?.steps ?? []).filter((step) => step.effect === "mutation" && step.status === "planned")
      .map((step): Mutation => ({ action: step.action!, input: step.input as JsonObject }));
    if (run?.status === "completed" && intended.length === 0 && reasons.length === 0) {
      reasons.push({ code: "no-mutations", message: "Recipe planned no mutations" });
    }
    const normalizedIntended = this.normalize(intended);
    const diff = diffJson(mutationJson(this.normalize(historical.outcome)), mutationJson(normalizedIntended));
    const status = reasons.length > 0 ? "not_handled" : diff.length > 0 ? "different" : "identical";
    if (status !== "not_handled") reasons.push({ code: status,
      message: status === "identical" ? "Intended mutations match the historical outcome" : "Intended mutations differ from the historical outcome" });
    return { normalizedIntended, result: immutableSnapshot({ caseId: historical.id, status, reasons,
      historicalMutations: historical.outcome, intendedMutations: intended, diff, run }) };
  }

  private report(recipe: RecipeVersion, results: readonly EvaluatedCase[]): BacktestResult {
    return immutableSnapshot({ recipeVersionId: recipe.id,
      summary: { total: results.length, identical: results.filter(({ result }) => result.status === "identical").length,
        different: results.filter(({ result }) => result.status === "different").length,
        notHandled: results.filter(({ result }) => result.status === "not_handled").length },
      cases: results.map(({ result }) => result) });
  }

  private simulate(recipe: RecipeVersion, trigger: JsonValue): Promise<Run> {
    // Private state for exactly one execute call; no production run repository writes.
    let checkpoint: Run | null = null;
    const runs: RunRepository = {
      create: async (run) => {
        if (checkpoint) throw new Error("Duplicate simulation run");
        checkpoint = immutableSnapshot(run);
      },
      get: async (id) => checkpoint?.id === id ? immutableSnapshot(checkpoint) : null,
      save: async (run) => {
        if (checkpoint?.id !== run.id) throw new Error("Missing simulation run");
        checkpoint = immutableSnapshot(run);
      },
      withRunLock: async (_id, work) => work(),
    };
    return new RunRecipe({ actions: this.deps.actions, extractor: this.deps.extractor, runs,
      clock: this.deps.clock, ids: this.deps.ids,
      handoff: { handoff: async () => { throw new Error("Simulation must never deliver handoff"); } },
    }).execute({ recipe, trigger, mode: "dry-run" });
  }
}
