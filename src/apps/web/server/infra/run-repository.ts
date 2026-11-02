import { parseRecipeVersion, type Run, type RunRepository } from "@muscle-memory/recipe-engine";
import { and, desc, eq, sql } from "drizzle-orm";
import { summarizeRun, type RunFilters, type RunSummary } from "../../shared/recipe-runs.js";
import type { ShopDb } from "../db/index.js";
import { recipeRuns, requests } from "../db/schema.js";
import { persistRecipeVersion } from "./recipe-catalog.js";
import { assertRunLockActive, withRunLock } from "./run-lock.js";

export class DrizzleRunRepository implements RunRepository {
  constructor(private readonly db: ShopDb) {}

  /** App read projection; execution's generic RunRepository port stays unchanged. */
  async list(filters: RunFilters = {}): Promise<readonly RunSummary[]> {
    const checkpoint = recipeRuns.checkpoint;
    const requestId = sql<string>`coalesce(${checkpoint}->'trigger'->>'requestId', ${checkpoint}->'trigger'->>'id')`;
    const rows = await this.db.select({ checkpoint, subject: requests.subject }).from(recipeRuns)
      .leftJoin(requests, eq(requests.id, requestId))
      .where(and(
        filters.status ? sql`${checkpoint}->>'status' = ${filters.status}` : undefined,
        filters.requestId ? eq(requestId, filters.requestId) : undefined,
        filters.recipeId ? sql`${checkpoint}->'recipe'->>'recipeId' = ${filters.recipeId}` : undefined,
        filters.mode ? sql`${checkpoint}->>'mode' = ${filters.mode}` : undefined,
      ))
      .orderBy(desc(sql`(${checkpoint}->>'createdAt')::double precision`), desc(recipeRuns.id));
    return rows.map(row => summarizeRun(row.checkpoint, row.subject));
  }

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
