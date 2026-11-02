import type { Correction, CorrectionRun, CorrectionStore } from "@muscle-memory/shop-domain";
import { and, desc, eq, sql } from "drizzle-orm";
import type { ShopDb } from "../db/index.js";
import { recipeCorrections, recipeRuns, requests, requestProcessing } from "../db/schema.js";

export class DrizzleCorrectionStore implements CorrectionStore {
  constructor(private readonly db: ShopDb) {}
  async latestRun(requestId: string): Promise<CorrectionRun | null> {
    const [row] = await this.db.select({ run: recipeRuns.checkpoint, orderId: requests.orderId, tags: requests.tags, intakeRunId: requestProcessing.runId })
      .from(recipeRuns).innerJoin(requests, eq(requests.id, sql`coalesce(${recipeRuns.checkpoint}->'trigger'->>'requestId', ${recipeRuns.checkpoint}->'trigger'->>'id')`))
      .leftJoin(requestProcessing, eq(requestProcessing.requestId, requests.id))
      .where(eq(requests.id, requestId as `req_${string}`))
      .orderBy(desc(sql`(${recipeRuns.checkpoint}->>'createdAt')::double precision`), desc(recipeRuns.id)).limit(1);
    return row ? structuredClone({
      id: row.run.id, requestId, orderId: row.orderId, currentTags: row.tags, recipe: { id: row.run.recipe.id, recipeId: row.run.recipe.recipeId, version: row.run.recipe.version },
      status: row.run.status, mode: row.run.mode, automatic: row.intakeRunId === row.run.id, completedAt: row.run.updatedAt,
      approvedStepIds: row.run.approvedStepIds, steps: row.run.steps,
    }) : null;
  }
  async list(filter: { requestId?: string; runId?: string; recipeId?: string; versionId?: string }) {
    const rows = await this.db.select({ snapshot: recipeCorrections.snapshot }).from(recipeCorrections).where(and(
      filter.requestId ? eq(recipeCorrections.requestId, filter.requestId as `req_${string}`) : undefined,
      filter.runId ? eq(recipeCorrections.runId, filter.runId) : undefined,
      filter.recipeId ? sql`${recipeCorrections.snapshot}->'recipe'->>'recipeId' = ${filter.recipeId}` : undefined,
      filter.versionId ? eq(recipeCorrections.proposalVersionId, filter.versionId) : undefined,
    )).orderBy(desc(recipeCorrections.createdAt), desc(recipeCorrections.id));
    return structuredClone(rows.map(row => row.snapshot));
  }
  async get(id: string) {
    const [row] = await this.db.select().from(recipeCorrections).where(eq(recipeCorrections.id, id));
    return row ? structuredClone(row.snapshot) : null;
  }
  async save(correction: Correction) {
    const values = { ownerEmail: correction.owner.userId, workspaceId: correction.owner.workspaceId, id: correction.id, requestId: correction.requestId as `req_${string}`, runId: correction.runId, recipeVersionId: correction.recipe.id,
      proposalVersionId: correction.proposal?.version.id ?? null, createdAt: correction.createdAt, snapshot: structuredClone(correction) };
    await this.db.insert(recipeCorrections).values(values).onConflictDoUpdate({ target: recipeCorrections.id, set: { proposalVersionId: values.proposalVersionId, snapshot: values.snapshot } });
  }
  transaction<T>(work: (records: DrizzleCorrectionStore) => Promise<T>): Promise<T> {
    return this.db.transaction(async tx => {
      // Same parent-first order as reset and Studio; the callback is DB-only.
      await tx.execute(sql`LOCK TABLE recipe_versions, recipes, recipe_drafts, recipe_runs, recipe_corrections IN SHARE ROW EXCLUSIVE MODE`);
      return work(new DrizzleCorrectionStore(tx as unknown as ShopDb));
    });
  }
}
