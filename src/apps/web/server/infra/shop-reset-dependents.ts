import { getTableName, inArray, isNotNull, or, sql, type SQL } from "drizzle-orm";
import type { PgTable } from "drizzle-orm/pg-core";
import type { ShopDb } from "../db/index.js";
import { demoSteps, demonstrations, recipeDrafts, recipeHandoffs, recipeRuns, recipes, recipeVersions, requestProcessing } from "../db/schema.js";
import { lockShopWrites } from "./shop-repository.js";

export type ShopResetTransaction = Parameters<Parameters<ShopDb["transaction"]>[0]>[0];
export interface ShopResetOptions {
  /** Also discard the catalog, immutable versions and unrelated recipe runs. */
  readonly all?: boolean;
}
interface ResetScope {
  readonly all: boolean;
  readonly requestRunIds: readonly string[];
}
interface ResetDependent {
  readonly table: PgTable;
  readonly allOnly?: boolean;
  readonly where?: (scope: ResetScope) => SQL | undefined;
}

/** The single registration point for shop dependents, in child-before-parent
 * DELETE order. Register new operational child tables here before their parents.
 * Missing tables are skipped for databases with only the shop migration applied.
 * No framework tables or CASCADE/TRUNCATE are included. */
export const shopResetDependents: readonly ResetDependent[] = [
  { table: demoSteps },
  { table: demonstrations },
  { table: requestProcessing },
  { table: recipeHandoffs, where: scope => scope.all ? undefined : or(
    isNotNull(recipeHandoffs.requestId), inArray(recipeHandoffs.runId, [...scope.requestRunIds]),
  ) },
  { table: recipeRuns, where: scope => scope.all ? undefined : inArray(recipeRuns.id, [...scope.requestRunIds]) },
  { table: recipes, allOnly: true },
  { table: recipeDrafts, allOnly: true },
  { table: recipeVersions, allOnly: true },
];

/** Acquire locks and clean dependents inside the caller's seed/reset transaction.
 * The caller then replaces shop rows without committing between these phases. */
export async function clearShopDependents(tx: ShopResetTransaction, options: ShopResetOptions): Promise<void> {
  const tables = await tx.select({ name: sql<string>`table_name` }).from(sql`information_schema.tables`)
    .where(sql`table_schema = current_schema()`);
  const present = new Set(tables.map(table => table.name));
  const dependents = shopResetDependents.filter(entry => present.has(getTableName(entry.table)) && (!entry.allOnly || options.all));
  if (dependents.length) {
    // Parent-first locking matches version+run creation. Engine locks precede
    // shop locks because handoff delivery writes its record before escalation.
    const lockTables = [...dependents].reverse().map(entry => sql`${entry.table}`);
    await tx.execute(sql`LOCK TABLE ${sql.join(lockTables, sql`, `)} IN SHARE ROW EXCLUSIVE MODE`);
  }
  await lockShopWrites(tx);

  const requestRunIds = new Set<string>();
  if (!options.all) {
    if (present.has(getTableName(requestProcessing))) {
      for (const row of await tx.select({ id: requestProcessing.runId }).from(requestProcessing)) requestRunIds.add(row.id);
    }
    if (present.has(getTableName(recipeHandoffs))) {
      for (const row of await tx.select({ id: recipeHandoffs.runId }).from(recipeHandoffs).where(isNotNull(recipeHandoffs.requestId))) requestRunIds.add(row.id);
    }
    if (present.has(getTableName(recipeRuns))) {
      // Also remove ad hoc runs and stale request-shaped triggers, even if an
      // intake or handoff row was never created. Generic runs remain untouched.
      const pattern = "^req_[a-z0-9]+$";
      const rows = await tx.select({ id: recipeRuns.id }).from(recipeRuns).where(or(
        sql`${recipeRuns.checkpoint}->'trigger'->>'requestId' ~ ${pattern}`,
        sql`${recipeRuns.checkpoint}->'trigger'->>'id' ~ ${pattern}`,
      ));
      for (const row of rows) requestRunIds.add(row.id);
    }
  }
  const scope: ResetScope = { all: options.all === true, requestRunIds: [...requestRunIds] };
  for (const entry of dependents) await tx.delete(entry.table).where(entry.where?.(scope));
}
