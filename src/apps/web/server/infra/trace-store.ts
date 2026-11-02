import type {
  Demonstration,
  DemonstrationOwner,
  DemonstrationRecords,
  DemonstrationScope,
  TraceStore,
} from "@muscle-memory/recipe-engine";
import { and, asc, desc, eq, notInArray, sql } from "drizzle-orm";

import type { ShopDb } from "../db/index.js";
import { demonstrations, demoSteps } from "../db/schema.js";

type Connection = Pick<ShopDb, "select" | "insert" | "delete" | "execute">;
const ownerFilter = (owner: DemonstrationOwner) =>
  and(
    eq(demonstrations.ownerEmail, owner.userId),
    eq(demonstrations.workspaceId, owner.workspaceId),
  );
const sessionFilter = (scope: DemonstrationScope) =>
  and(ownerFilter(scope), eq(demonstrations.sessionId, scope.sessionId));
class Records implements DemonstrationRecords {
  constructor(private readonly db: Connection) {}
  private async load(
    row: typeof demonstrations.$inferSelect | undefined,
  ): Promise<Demonstration | null> {
    if (!row) return null;
    const steps = await this.db
      .select()
      .from(demoSteps)
      .where(
        and(
          eq(demoSteps.demonstrationId, row.id),
          eq(demoSteps.ownerEmail, row.ownerEmail),
          eq(demoSteps.workspaceId, row.workspaceId),
        ),
      )
      .orderBy(asc(demoSteps.sequence));
    return structuredClone({
      ...row.checkpoint,
      source: row.checkpoint.source ?? { kind: "teach" },
      steps: steps.map((s) => s.snapshot),
    });
  }
  async active(scope: DemonstrationScope) {
    const [row] = await this.db
      .select()
      .from(demonstrations)
      .where(and(sessionFilter(scope), eq(demonstrations.status, "recording")))
      .limit(1);
    return this.load(row);
  }
  async latest(scope: DemonstrationScope, subjectId: string) {
    const [row] = await this.db
      .select()
      .from(demonstrations)
      .where(and(sessionFilter(scope), eq(demonstrations.subjectId, subjectId)))
      .orderBy(desc(demonstrations.startedAt), desc(demonstrations.id))
      .limit(1);
    return this.load(row);
  }
  async get(owner: DemonstrationOwner, id: string) {
    const [row] = await this.db
      .select()
      .from(demonstrations)
      .where(and(ownerFilter(owner), eq(demonstrations.id, id)))
      .limit(1);
    return this.load(row);
  }
  async save(demo: Demonstration) {
    const { steps, ...checkpoint } = structuredClone(demo);
    const values = {
      id: demo.id,
      ownerEmail: demo.scope.userId,
      workspaceId: demo.scope.workspaceId,
      sessionId: demo.scope.sessionId,
      subjectId: demo.subjectId,
      startedAt: demo.startedAt,
      status: demo.status,
      checkpoint,
    };
    await this.db
      .insert(demonstrations)
      .values(values)
      .onConflictDoUpdate({
        target: demonstrations.id,
        set: { status: demo.status, checkpoint },
      });
    // Reconcile the full snapshot atomically: a slower first read can replace
    // a later identical read that completed first. Never leave that old row behind.
    await this.db.delete(demoSteps).where(
      and(
        eq(demoSteps.demonstrationId, demo.id),
        eq(demoSteps.ownerEmail, demo.scope.userId),
        eq(demoSteps.workspaceId, demo.scope.workspaceId),
        steps.length
          ? notInArray(
              demoSteps.sequence,
              steps.map((step) => step.sequence),
            )
          : undefined,
      ),
    );
    if (steps.length)
      await this.db
        .insert(demoSteps)
        .values(
          steps.map((snapshot) => ({
            ownerEmail: demo.scope.userId,
            workspaceId: demo.scope.workspaceId,
            demonstrationId: demo.id,
            sequence: snapshot.sequence,
            snapshot,
          })),
        )
        .onConflictDoNothing();
  }
}

export class DrizzleTraceStore implements TraceStore {
  constructor(private readonly db: ShopDb) {}
  transaction<T>(
    work: (records: DemonstrationRecords) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction(async (tx) => {
      // Short, non-retrying critical section. Supported on PGlite and PostgreSQL;
      // no shop/network operation runs here and no failed write undoes a shop effect.
      await tx.execute(
        sql`LOCK TABLE demonstrations IN SHARE ROW EXCLUSIVE MODE`,
      );
      return work(new Records(tx as unknown as ShopDb));
    });
  }
}
