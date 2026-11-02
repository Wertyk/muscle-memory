import { RecipeStudioError } from "@muscle-memory/recipe-engine";
import type {
  DemonstrationOwner,
  RecipeStudioStore,
  StudioRecord,
  StudioWrites,
} from "@muscle-memory/recipe-engine";
import { asc, eq, sql } from "drizzle-orm";

import type { ShopDb } from "../db/index.js";
import { recipes, recipeVersions, recipeRuns } from "../db/schema.js";
import {
  DrizzleRecipeCatalog,
  persistRecipeVersion,
} from "./recipe-catalog.js";

export class DrizzleRecipeStudioStore implements RecipeStudioStore {
  constructor(
    private readonly db: ShopDb,
    private readonly owner: DemonstrationOwner | null = null,
  ) {}
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
    const draft = this.owner
      ? await new DrizzleRecipeCatalog(this.db).getStudioDraft(
          this.owner,
          recipeId,
        )
      : null;
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
    return structuredClone({
      recipe,
      versions: versions.map((row) => row.snapshot),
      draft,
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
        sql`LOCK TABLE recipe_versions, recipes, recipe_drafts IN SHARE ROW EXCLUSIVE MODE`,
      );
      return work({
        get: () =>
          new DrizzleRecipeStudioStore(tx as unknown as ShopDb, this.owner).get(
            recipeId,
          ),
        saveDraft: async (draft) => {
          if (!this.owner)
            throw new RecipeStudioError(
              "INVALID",
              "Sign in to edit a recipe draft.",
            );
          await new DrizzleRecipeCatalog(
            tx as unknown as ShopDb,
          ).saveStudioDraft(this.owner, draft);
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
