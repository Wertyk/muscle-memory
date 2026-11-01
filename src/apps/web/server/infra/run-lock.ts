import path from "node:path";
import { AsyncLocalStorage } from "node:async_hooks";
import { getRuntimeDatabaseUrl } from "@agent-native/core/db";
import postgres from "postgres";

// PGlite core exclusively process-locks the data directory. A queue shared by
// repository instances/hot reloads covers concurrent calls in that one worker.
const globals = globalThis as typeof globalThis & { muscleMemoryRunLocks?: Map<string, Promise<void>> };
const localLocks = globals.muscleMemoryRunLocks ??= new Map<string, Promise<void>>();
const lockScope = new AsyncLocalStorage<{ active: boolean }>();

/** A disconnected lock connection can outlive the callback's external await.
 * Stop that callback at its next DB boundary instead of advancing stale work. */
export function assertRunLockActive(): void {
  if (lockScope.getStore()?.active === false) throw new Error("Recipe run lock was lost.");
}

export async function withPgliteRunLock<T>(url: string, id: string, work: () => Promise<T>): Promise<T> {
  const key = JSON.stringify([path.resolve(url.slice("pglite:".length)), id]);
  const previous = localLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  localLocks.set(key, current);
  await previous;
  try { return await work(); }
  finally {
    release();
    if (localLocks.get(key) === current) localLocks.delete(key);
  }
}

export async function withPostgresRunLock<T>(url: string, id: string, work: () => Promise<T>): Promise<T> {
  // This connection is used ONLY for locking. In particular do not use core's
  // transaction API: it redirects getDb() into its rollback/retry scope.
  // A transaction lock also works through transaction-pooling Neon/PgBouncer.
  const connection = postgres(url, { max: 1, prepare: false, connect_timeout: 15 });
  const scope = { active: true };
  try {
    // postgres 4.0.0 begin invokes its callback once; no retry wrapper here.
    return await connection.begin(async (lock) => {
      await lock`SET LOCAL idle_in_transaction_session_timeout = 0`;
      await lock`SET LOCAL lock_timeout = '30s'`;
      await lock`SELECT pg_advisory_xact_lock(hashtextextended(${`muscle-memory:run:${id}`}, 0))`;
      return lockScope.run(scope, work);
    }) as T;
  } finally {
    scope.active = false;
    await connection.end({ timeout: 5 });
  }
}

export function withRunLock<T>(id: string, work: () => Promise<T>): Promise<T> {
  const url = getRuntimeDatabaseUrl("pglite:./data/pglite");
  return url.startsWith("pglite:")
    ? withPgliteRunLock(url, id, work)
    : withPostgresRunLock(url, id, work);
}
