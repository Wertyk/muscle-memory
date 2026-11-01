import { parseRecipeVersion, type Run, type RunRepository } from "@muscle-memory/recipe-engine";
import { and, eq, sql } from "drizzle-orm";
import type { ShopDb } from "../db/index.js";
import { recipeRuns } from "../db/schema.js";
import { persistRecipeVersion } from "./recipe-catalog.js";
import { assertRunLockActive, withRunLock } from "./run-lock.js";

export class DrizzleRunRepository implements RunRepository {
  constructor(private readonly db: ShopDb) {}

  async create(run: Run): Promise<void> {
    assertRunLockActive();
    const snapshot = structuredClone(run);
    const recipe = parseRecipeVersion(snapshot.recipe);
    // Version and initial intent commit together; no external callback is inside.
    await this.db.transaction(async (tx) => {
      await persistRecipeVersion(tx as unknown as ShopDb, recipe);
      await tx.insert(recipeRuns).values({ id: snapshot.id, recipeVersionId: recipe.id, checkpoint: snapshot });
    });
  }

  async get(id: string): Promise<Run | null> {
    assertRunLockActive();
    const [row] = await this.db.select({ checkpoint: recipeRuns.checkpoint }).from(recipeRuns).where(eq(recipeRuns.id, id));
    return row ? structuredClone(row.checkpoint) : null;
  }

  async save(run: Run): Promise<void> {
    assertRunLockActive();
    const snapshot = structuredClone(run);
    const rows = await this.db.update(recipeRuns).set({ checkpoint: snapshot }).where(and(
      eq(recipeRuns.id, run.id), eq(recipeRuns.recipeVersionId, run.recipe.id),
      // Resume must never replace the immutable recipe, trigger or execution mode.
      sql`${recipeRuns.checkpoint}->'recipe' = ${JSON.stringify(snapshot.recipe)}::jsonb`,
      sql`${recipeRuns.checkpoint}->'trigger' = ${JSON.stringify(snapshot.trigger)}::jsonb`,
      sql`${recipeRuns.checkpoint}->>'mode' = ${snapshot.mode}`,
    )).returning({ id: recipeRuns.id });
    if (!rows.length) throw new Error(`Cannot save missing or incompatible run ${run.id}`);
  }

  withRunLock<T>(id: string, work: () => Promise<T>): Promise<T> { return withRunLock(id, work); }
}
