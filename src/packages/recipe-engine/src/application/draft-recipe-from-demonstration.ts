import { pathSegments } from "../domain/evaluation.js";
import { inferBindings, type BindingAmbiguity } from "../domain/inference.js";
import { immutableSnapshot } from "../domain/json.js";
import type { DemonstrationOwner } from "../domain/demonstration.js";
import type { ActionStep, BindingTree, Recipe, RecipeVersion } from "../domain/model.js";
import type { ActionInvoker, RecipeRepository, TraceStore } from "./ports.js";
import { parseRecipeVersion } from "./recipe-schema.js";
import { bindingPaths, rebaseMutationInputs } from "./draft-bindings.js";

export interface RecipeDraft {
  readonly demonstrationId: string;
  readonly recipe: Recipe;
  readonly draft: RecipeVersion;
  readonly ambiguities: readonly BindingAmbiguity[];
}
export class DraftRecipeError extends Error {
  constructor(readonly code: "NOT_FOUND" | "INVALID_DEMONSTRATION", message: string) { super(message); }
}

/** No action invocation or extraction: inference and storage only. */
export class DraftRecipeFromDemonstration {
  constructor(private readonly deps: {
    readonly traces: TraceStore;
    readonly recipes: RecipeRepository;
    readonly actions: Pick<ActionInvoker, "describe">;
    readonly nextId: (kind: "recipe" | "version") => string;
  }) {}

  async execute(input: { readonly demonstrationId: string; readonly owner: DemonstrationOwner }): Promise<RecipeDraft> {
    const demonstration = await this.deps.traces.transaction(records => records.get(input.owner, input.demonstrationId));
    if (!demonstration) throw new DraftRecipeError("NOT_FOUND", "Demonstration not found.");
    if (demonstration.status !== "completed" || demonstration.pending.length || demonstration.stoppedAt === null ||
      demonstration.incompleteReason !== null || !demonstration.steps.length ||
      typeof demonstration.trigger.type !== "string" || !demonstration.trigger.type.trim() ||
      demonstration.steps.some((step, index, steps) => step.sequence <= (steps[index - 1]?.sequence ?? 0))) {
      throw new DraftRecipeError("INVALID_DEMONSTRATION", "Drafting requires a completed, nonempty, ordered demonstration with a recorded request type.");
    }
    const inference = inferBindings({ id: demonstration.id, steps: demonstration.steps.map(({ id, action, input, output }) =>
      ({ id, action, input, output })) }, demonstration.trigger);
    const effects = new Map<string, "read" | "mutation">();
    for (const step of inference.steps) {
      const { effect } = await this.deps.actions.describe(step.action);
      if (effect !== "read" && effect !== "mutation") throw new Error("Unknown action effect.");
      effects.set(step.id, effect);
    }
    const rebased = rebaseMutationInputs(inference, demonstration, effects);
    // Walk backwards: every mutation survives, and each surviving step retains
    // its transitive read dependencies. Unused lookup chains disappear together.
    const needed = new Set<string>();
    const steps: ActionStep[] = [];
    for (const step of [...rebased.steps].reverse()) {
      if (effects.get(step.id) === "read" && !needed.has(step.id)) continue;
      steps.unshift(step);
      for (const path of Object.values(step.args).flatMap(bindingPaths)) {
        const parts = pathSegments(path);
        if (parts[0] === "steps") needed.add(parts[1]!);
      }
    }
    if (!steps.length) throw new DraftRecipeError("INVALID_DEMONSTRATION", "The demonstration contains no reusable handling steps.");
    const kept = new Set(steps.map(step => step.id));
    const available = (tree: BindingTree) => bindingPaths(tree).every(path => {
      const parts = pathSegments(path);
      return parts[0] !== "steps" || kept.has(parts[1]!);
    });
    const ambiguities = rebased.ambiguities.filter(item => kept.has(item.stepId)).map(item => ({
      ...item, candidates: item.candidates.filter(candidate => available(candidate.binding)),
    })).filter(item => item.kind !== "multiple-candidates" || item.candidates.filter(candidate => candidate.reason !== "constant").length > 1);
    const name = `Draft: ${demonstration.trigger.type}`;
    const draft = parseRecipeVersion({
      id: this.deps.nextId("version"), recipeId: this.deps.nextId("recipe"), version: 1, name,
      trigger: { event: "request.created", match: { "===": [{ var: "trigger.type" }, demonstration.trigger.type] } }, steps,
    });
    const result = immutableSnapshot({ demonstrationId: demonstration.id,
      recipe: { id: draft.recipeId, name, status: "draft" as const, activeVersionId: null }, draft, ambiguities });
    await this.deps.recipes.createDraft(input.owner, result);
    return result;
  }

  get(owner: DemonstrationOwner, versionId: string): Promise<RecipeDraft | null> {
    return this.deps.recipes.getDraft(owner, versionId);
  }
}
