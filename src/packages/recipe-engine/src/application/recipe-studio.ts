import type { JsonDifference } from "../domain/backtest.js";
import { diffJson } from "../domain/json-diff.js";
import { immutableSnapshot, isJsonValue } from "../domain/json.js";
import type {
  Recipe,
  RecipeVersion,
  JsonObject,
  JsonValue,
} from "../domain/model.js";
import type { SkillRegistry, SkillPublication } from "./ports.js";
import { recipeSkill, recipeSkillName } from "./recipe-skill.js";
import { recipeVersionSchema } from "./recipe-schema.js";

export interface StudioDraft {
  readonly recipeId: string;
  readonly revision: number;
  readonly baseVersionId: string | null;
  readonly content: JsonObject;
  readonly ambiguities: readonly JsonValue[];
}
export interface StudioRecord {
  readonly recipe: Recipe;
  readonly versions: readonly RecipeVersion[];
  readonly draft: StudioDraft | null;
  readonly runs: readonly {
    readonly status: string;
    readonly startedAt: number;
    readonly id: string;
  }[];
}
export interface StudioWrites {
  get(): Promise<StudioRecord | null>;
  saveDraft(draft: StudioDraft): Promise<void>;
  saveVersion(version: RecipeVersion): Promise<void>;
  saveRecipe(recipe: Recipe): Promise<void>;
}
/** Real persistence boundary. Transactions serialize version numbers and draft revisions;
 * callbacks run once and commit all writes together. No external effects in callbacks. */
export interface RecipeStudioStore {
  list(): Promise<readonly StudioRecord[]>;
  get(recipeId: string): Promise<StudioRecord | null>;
  transaction<T>(
    recipeId: string,
    work: (records: StudioWrites) => Promise<T>,
  ): Promise<T>;
}
export interface StudioIssue {
  readonly path: string;
  readonly message: string;
}
export class RecipeStudioError extends Error {
  constructor(
    readonly code: "NOT_FOUND" | "CONFLICT" | "INVALID",
    message: string,
  ) {
    super(message);
  }
}

export function recipeContent(version: RecipeVersion): JsonObject {
  return {
    name: version.name,
    trigger: version.trigger,
    steps: version.steps as unknown as JsonValue,
  };
}
export function validateStudioContent(recipeId: string, content: JsonObject) {
  const result = recipeVersionSchema.safeParse({
    ...content,
    id: "ver_preview",
    recipeId,
    version: 1,
  });
  return result.success
    ? { issues: [] as StudioIssue[], version: result.data }
    : {
        issues: result.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.code === "invalid_union" && issue.path.includes("args")
            ? "Invalid binding: use fixed, path, template, or an allowlisted JSONLogic expr."
            : issue.message,
        })),
        version: null,
      };
}
function required(record: StudioRecord | null): StudioRecord {
  if (!record) throw new RecipeStudioError("NOT_FOUND", "Recipe not found.");
  return record;
}
function draftOf(record: StudioRecord): StudioDraft {
  const latest = [...record.versions].sort((a, b) => b.version - a.version)[0];
  return (
    record.draft ?? {
      recipeId: record.recipe.id,
      revision: 0,
      baseVersionId: latest?.id ?? null,
      content: latest
        ? recipeContent(latest)
        : {
            name: record.recipe.name,
            trigger: { event: "request.created", match: false },
            steps: [],
          },
      ambiguities: [],
    }
  );
}
function checkRevision(draft: StudioDraft, revision: number) {
  if (draft.revision !== revision)
    throw new RecipeStudioError(
      "CONFLICT",
      "This draft changed. Refresh it before editing or saving again.",
    );
}

/** The Studio never executes a recipe or calls a model. Saved versions are immutable;
 * activation changes only the catalog pointer, preserving pinned historical runs. */
export class RecipeStudio {
  constructor(
    private readonly store: RecipeStudioStore,
    private readonly nextVersionId: () => string,
    private readonly skills?: SkillRegistry,
  ) {}
  async list(status?: Recipe["status"]) {
    return immutableSnapshot(
      await Promise.all((await this.store.list()).filter(record => !status || record.recipe.status === status).map(async (record) => {
        const latest = [...record.versions].sort(
          (a, b) => b.version - a.version,
        )[0];
        const last = [...record.runs].sort(
          (a, b) => b.startedAt - a.startedAt || b.id.localeCompare(a.id),
        )[0];
        return {
          ...record.recipe,
          version: latest?.version ?? 0,
          activeVersion: record.versions.find(version => version.id === record.recipe.activeVersionId) ?? null,
          skillPublication: await this.skills?.publication(record.recipe.id) ?? null,
          runs: record.runs.length,
          lastResult: last?.status ?? null,
        };
      })),
    );
  }
  async get(recipeId: string) {
    const record = required(await this.store.get(recipeId));
    const versions = [...record.versions].sort((a, b) => a.version - b.version);
    const history = versions.map((version, index) => ({
      version,
      diff:
        index === 0
          ? []
          : (diffJson(
              recipeContent(versions[index - 1]!),
              recipeContent(version),
            ) as readonly JsonDifference[]),
    }));
    return immutableSnapshot({ recipe: record.recipe, history, skillPublication: await this.skills?.publication(recipeId) ?? null });
  }
  async getDraft(recipeId: string) {
    const draft = draftOf(required(await this.store.get(recipeId)));
    return immutableSnapshot({
      ...draft,
      issues: validateStudioContent(recipeId, draft.content).issues,
    });
  }
  async update(input: {
    recipeId: string;
    expectedRevision: number;
    content: JsonObject;
  }) {
    if (!isJsonValue(input.content))
      throw new RecipeStudioError("INVALID", "Expected bounded finite JSON.");
    return this.store.transaction(input.recipeId, async (records) => {
      const draft = draftOf(required(await records.get()));
      checkRevision(draft, input.expectedRevision);
      const next = immutableSnapshot({
        ...draft,
        content: input.content,
        revision: draft.revision + 1,
      });
      await records.saveDraft(next);
      return immutableSnapshot({
        ...next,
        issues: validateStudioContent(input.recipeId, next.content).issues,
      });
    });
  }
  async save(input: { recipeId: string; expectedRevision: number }) {
    return this.store.transaction(input.recipeId, async (records) => {
      const record = required(await records.get());
      const draft = draftOf(record);
      checkRevision(draft, input.expectedRevision);
      const validation = validateStudioContent(input.recipeId, draft.content);
      if (!validation.version)
        throw new RecipeStudioError(
          "INVALID",
          `Fix the draft validation errors before saving a version: ${validation.issues.slice(0, 5).map(issue => `${issue.path || "recipe"}: ${issue.message}`).join("; ")}`,
        );
      const version = recipeVersionSchema.parse({
        ...validation.version,
        id: this.nextVersionId(),
        version: Math.max(0, ...record.versions.map((v) => v.version)) + 1,
      });
      await records.saveVersion(version);
      await records.saveRecipe({ ...record.recipe, name: version.name });
      await records.saveDraft({
        ...draft,
        revision: draft.revision + 1,
        baseVersionId: version.id,
      });
      return version;
    });
  }
  async activate(input: { recipeId: string; versionId: string }) {
    const recipe = await this.store.transaction(input.recipeId, async (records) => {
      const record = required(await records.get());
      const version = record.versions.find((v) => v.id === input.versionId);
      if (!version)
        throw new RecipeStudioError(
          "NOT_FOUND",
          "Saved version not found for this recipe.",
        );
      if (!recipeVersionSchema.safeParse(version).success)
        throw new RecipeStudioError(
          "INVALID",
          "Saved version is invalid and cannot be activated.",
        );
      const recipe: Recipe = {
        ...record.recipe,
        name: version.name,
        status: "active",
        activeVersionId: version.id,
      };
      await records.saveRecipe(recipe);
      return recipe;
    });
    return { ...recipe, skillPublication: await this.syncSkill(input.recipeId) };
  }
  async deactivate(recipeId: string) {
    const recipe = await this.store.transaction(recipeId, async (records) => {
      const record = required(await records.get());
      const recipe: Recipe = {
        ...record.recipe,
        status: "draft",
        activeVersionId: null,
      };
      await records.saveRecipe(recipe);
      return recipe;
    });
    return { ...recipe, skillPublication: await this.syncSkill(recipeId) };
  }
  /** Retry always reconciles the CURRENT pointer, never a stale failed version. */
  async syncSkill(recipeId: string): Promise<SkillPublication | null> {
    if (!this.skills) return null;
    // Missing recipes are action errors; resource outages must not undo activation.
    required(await this.store.get(recipeId));
    let versionId: string | null = null;
    const failed = (): SkillPublication => ({
      status: "failed", versionId, retryable: true,
      message: "Recipe state saved; runtime skill sync failed. Retry with retry-recipe-skill.",
    });
    try {
      return await this.skills.withLock(recipeId, async () => {
        const record = required(await this.store.get(recipeId));
        versionId = record.recipe.activeVersionId;
        await this.skills!.record(recipeId, { status: "pending", versionId, retryable: true, message: "Runtime skill sync pending; retry if interrupted." });
        try {
          if (record.recipe.status === "active" && versionId) {
            const version = record.versions.find(version => version.id === versionId);
            if (!version) throw new Error("Active version missing.");
            const skill = recipeSkill(version);
            await this.skills!.put(skill.name, skill.description, skill.instructions);
          } else {
            await this.skills!.remove(recipeSkillName(recipeId));
          }
          const result: SkillPublication = { status: versionId ? "published" : "removed", versionId, retryable: false, message: null };
          await this.skills!.record(recipeId, result);
          return result;
        } catch {
          const result = failed();
          await this.skills!.record(recipeId, result);
          return result;
        }
      });
    } catch {
      // If the receipt store itself is unavailable, return safe retry guidance.
      return failed();
    }
  }
}
