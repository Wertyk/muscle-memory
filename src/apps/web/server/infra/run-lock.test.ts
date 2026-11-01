import { describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import { assertRunLockActive, withPgliteRunLock, withPostgresRunLock } from "./run-lock.js";

vi.mock("postgres", () => ({ default: vi.fn() }));

describe("run lock protocol", () => {
  it("holds a dedicated PostgreSQL transaction advisory lock across work and closes on failure without retry", async () => {
    const queries: Array<{ text: string; values: unknown[] }> = [];
    let inTransaction = false;
    const lock = vi.fn(async (parts: TemplateStringsArray, ...values: unknown[]) => { queries.push({ text: parts.join("?"), values }); });
    const end = vi.fn(async () => {});
    const begin = vi.fn(async (work) => {
      inTransaction = true;
      try { return await work(lock); }
      finally { inTransaction = false; }
    });
    vi.mocked(postgres).mockReturnValue({ begin, end } as unknown as ReturnType<typeof postgres>);
    const work = vi.fn(async () => {
      expect(inTransaction).toBe(true);
      expect(queries[2]).toEqual({ text: "SELECT pg_advisory_xact_lock(hashtextextended(?, 0))", values: ["muscle-memory:run:run_1"] });
      throw new Error("checkpoint failed");
    });
    await expect(withPostgresRunLock("postgres://synthetic", "run_1", work)).rejects.toThrow("checkpoint failed");
    expect(work).toHaveBeenCalledOnce();
    expect(begin).toHaveBeenCalledOnce();
    expect(end).toHaveBeenCalledOnce();
  });

  it("never enters work when acquiring the SQL lock fails", async () => {
    const end = vi.fn(async () => {});
    vi.mocked(postgres).mockReturnValue({ begin: async () => { throw new Error("lock unavailable"); }, end } as unknown as ReturnType<typeof postgres>);
    const work = vi.fn();
    await expect(withPostgresRunLock("postgres://synthetic", "run_2", work)).rejects.toThrow("lock unavailable");
    expect(work).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledOnce();
  });

  it("stops a stale callback at its next repository boundary after losing the lock connection", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    let pending: Promise<void>;
    const end = vi.fn(async () => {});
    vi.mocked(postgres).mockReturnValue({ begin: async (work: (lock: () => Promise<void>) => Promise<void>) => {
      pending = work(async () => {});
      pending.catch(() => {});
      await started;
      // postgres-js races its transaction callback against the connection closing.
      throw new Error("connection closed");
    }, end } as unknown as ReturnType<typeof postgres>);
    const work = vi.fn(async () => { entered(); await gate; assertRunLockActive(); });
    await expect(withPostgresRunLock("postgres://synthetic", "run_3", work)).rejects.toThrow("connection closed");
    release();
    await expect(pending!).rejects.toThrow("lock was lost");
    expect(work).toHaveBeenCalledOnce();
  });

  it("serializes local PGlite callers across instances, frees on failure, and allows different runs", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered: string[] = [];
    const first = withPgliteRunLock("pglite:/tmp/test-lock", "run_1", async () => { entered.push("first"); await gate; throw new Error("failure"); });
    const rejected = expect(first).rejects.toThrow("failure");
    const second = withPgliteRunLock("pglite:/tmp/test-lock", "run_1", async () => { entered.push("second"); });
    await withPgliteRunLock("pglite:/tmp/test-lock", "run_2", async () => { expect(entered).toEqual(["first"]); });
    release();
    await rejected;
    await second;
    expect(entered).toEqual(["first", "second"]);
  });
});
