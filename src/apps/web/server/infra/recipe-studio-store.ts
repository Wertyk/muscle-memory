import type {
  DemonstrationOwner,
  JsonValue,
  OriginalStudioDraft,
  RecipeStudioStore,
  StudioRecord,
  StudioWrites,
} from "@muscle-memory/recipe-engine";
import { asc, eq, sql } from "drizzle-orm";

import type { ShopDb } from "../db/index.js";
import {
  recipes,
  recipeVersions,
  recipeStudioDrafts,
  recipeRuns,
} from "../db/schema.js";
import { persistRecipeVersion } from "./recipe-catalog.js";

export class DrizzleRecipeStudioStore implements RecipeStudioStore {
  constructor(
    private readonly db: ShopDb,
    private readonly owner: DemonstrationOwner | null = null,
  ) {}
  /** Optional TASK-11 table: keep this worktree independent of its migration/schema.
   * SQL is static and values are bound. Identity comes only from authenticated context. */
  private async evidence(recipeId: string, versionId?: string) {
    if (!this.owner) return null;
    const exists = await this.db.execute(
      sql`SELECT to_regclass('recipe_drafts') AS name`,
    );
    if (
      !(exists as unknown as { rows: { name: string | null }[] }).rows[0]?.name
    )
      return null;
    const result = await this.db
      .execute(sql`SELECT d.evidence, v.id AS version_id
      FROM recipe_drafts d JOIN recipe_versions v ON v.id = d.version_id
      WHERE v.recipe_id = ${recipeId} AND d.owner_email = ${this.owner.userId}
      AND d.workspace_id = ${this.owner.workspaceId}
      ${versionId ? sql`AND v.id = ${versionId}` : sql``}
      ORDER BY v.version ASC LIMIT 1`);
    return (
      (
        result as unknown as {
          rows: {
            evidence: {
              demonstrationId: string;
              ambiguities: readonly JsonValue[];
            };
            version_id: string;
          }[];
        }
      ).rows[0] ?? null
    );
  }
  async getOriginalDraft(
    versionId: string,
  ): Promise<OriginalStudioDraft | null> {
    const [row] = await this.db
      .select()
      .from(recipeVersions)
      .where(eq(recipeVersions.id, versionId));
    if (!row) return null;
    const evidence = await this.evidence(row.recipeId, versionId);
    if (!evidence) return null;
    const [recipe] = await this.db
      .select()
      .from(recipes)
      .where(eq(recipes.id, row.recipeId));
    return recipe
      ? structuredClone({ ...evidence.evidence, recipe, draft: row.snapshot })
      : null;
  }
  async list(): Promise<readonly StudioRecord[]> {
    const entries = await this.db
      .select({ id: recipes.id })
      .from(recipes)
      .orderBy(asc(recipes.name), asc(recipes.id));
    const records = await Promise.all(
      entries.map((entry) => this.get(entry.id)),
    );
    return records.filter((record): record is StudioRecord => record !== null);
  }
  async get(recipeId: string): Promise<StudioRecord | null> {
    const [recipe] = await this.db
      .select()
      .from(recipes)
      .where(eq(recipes.id, recipeId));
    if (!recipe) return null;
    const versions = await this.db
      .select({ snapshot: recipeVersions.snapshot })
      .from(recipeVersions)
      .where(eq(recipeVersions.recipeId, recipeId))
      .orderBy(asc(recipeVersions.version));
    const [draft] = await this.db
      .select()
      .from(recipeStudioDrafts)
      .where(eq(recipeStudioDrafts.recipeId, recipeId));
    const evidence = await this.evidence(recipeId);
    const runs = await this.db
      .select({
        id: recipeRuns.id,
        status: sql<string>`${recipeRuns.checkpoint}->>'status'`,
        startedAt: sql<number>`(${recipeRuns.checkpoint}->>'createdAt')::double precision`,
      })
      .from(recipeRuns)
      .innerJoin(
        recipeVersions,
        eq(recipeVersions.id, recipeRuns.recipeVersionId),
      )
      .where(eq(recipeVersions.recipeId, recipeId));
    // Evidence is always re-read under owner/workspace scope, never copied into
    // the shared editable draft. Thus an edit cannot disclose private trace evidence.
    const editable =
      draft ??
      (evidence && versions.length
        ? {
            recipeId,
            revision: 0,
            baseVersionId: versions[versions.length - 1]!.snapshot.id,
            content: {
              name: versions[versions.length - 1]!.snapshot.name,
              trigger: versions[versions.length - 1]!.snapshot.trigger,
              steps: versions[versions.length - 1]!.snapshot
                .steps as unknown as JsonValue,
            },
            ambiguities: [],
          }
        : null);
    return structuredClone({
      recipe,
      versions: versions.map((row) => row.snapshot),
      draft: editable
        ? { ...editable, ambiguities: evidence?.evidence.ambiguities ?? [] }
        : null,
      runs,
    });
  }
  transaction<T>(
    recipeId: string,
    work: (records: StudioWrites) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      // Same parent-first order as rehearsal reset. Short DB-only critical section;
      // supported by PGlite and Postgres without process-local sequencing.
      await tx.execute(
        sql`LOCK TABLE recipe_versions, recipes, recipe_studio_drafts IN SHARE ROW EXCLUSIVE MODE`,
      );
      return work({
        get: () =>
          new DrizzleRecipeStudioStore(tx as unknown as ShopDb, this.owner).get(
            recipeId,
          ),
        saveDraft: async (draft) => {
          const values = { ...draft, ambiguities: [] };
          await tx
            .insert(recipeStudioDrafts)
            .values(values)
            .onConflictDoUpdate({
              target: recipeStudioDrafts.recipeId,
              set: values,
            });
        },
        saveVersion: (version) =>
          persistRecipeVersion(tx as unknown as ShopDb, version),
        saveRecipe: async (recipe) => {
          await tx.update(recipes).set(recipe).where(eq(recipes.id, recipeId));
        },
      });
    });
  }
}
