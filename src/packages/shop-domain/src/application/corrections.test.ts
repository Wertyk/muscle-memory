import { describe, expect, it, vi } from "vitest";
import type { Correction } from "../domain/correction.js";
import { Corrections, CORRECTION_WINDOW_MS, type CorrectionRun, type CorrectionCall, type CorrectionStore } from "./corrections.js";

const owner = { userId: "operator@example.test", workspaceId: "personal" };
const version = { id: "ver_1", recipeId: "recipe_damage", version: 1 };
const candidate = { ...version, id: "ver_2", version: 2 };
const step = (action: string, stepId: string, input: unknown, output: unknown = {}) => ({ action, stepId, input, output, status: "completed" });
function setup() {
  let now = 1000;
  let sequence = 0;
  const rows = new Map<string, Correction>();
  const run: CorrectionRun = { id: "run_1", requestId: "req_1", orderId: "ord_1", currentTags: ["damaged"], recipe: version, status: "completed", mode: "execute", automatic: true, completedAt: 1000, approvedStepIds: [], steps: [
    step("send-reply", "reply_old", { requestId: "req_1", template: "Older" }, { body: "Older" }),
    step("send-reply", "reply", { requestId: "req_1", template: "Half price" }, { body: "Half price" }),
    step("issue-refund", "refund", { orderId: "ord_1", amount: { amountMinor: 2000, currency: "USD" } }),
    step("tag-request", "tag", { requestId: "req_1", tag: "damaged" }, { tags: ["damaged"] }),
  ] };
  const store: CorrectionStore = {
    latestRun: vi.fn(async () => run),
    list: async filter => [...rows.values()].filter(c => !filter.versionId || c.proposal?.version.id === filter.versionId),
    get: async id => rows.get(id) ?? null,
    save: async c => { rows.set(c.id, c); },
    transaction: async work => {
      const saved = new Map(rows);
      try { return await work(store); }
      catch (error) { rows.clear(); for (const [id, c] of saved) rows.set(id, c); throw error; }
    },
  };
  const useCase = new Corrections(store, () => now, () => `cor_${++sequence}`);
  const call: CorrectionCall = { caller: "frontend", owner, requestId: "req_1", action: "send-reply", input: { requestId: "req_1", template: "Half price. Keep the piece." } };
  return { rows, run, store, useCase, call, setNow: (value: number) => { now = value; } };
}
describe("typed correction capture", () => {
  it("pins the last matching completed step and inputs at entry, even when navigation/run changes", async () => {
    const f = setup();
    const complete = await f.useCase.begin(f.call);
    (f.call.input as any).template = "Later edit";
    (f.run.steps[1] as any).input.template = "Later run mutation";
    await complete?.({ body: "Half price. Keep the piece." });
    expect([...f.rows.values()]).toEqual([expect.objectContaining({
      requestId: "req_1", runId: "run_1", recipe: version, stepId: "reply", status: "recorded",
      originalInput: { requestId: "req_1", template: "Half price" },
      input: { requestId: "req_1", template: "Half price. Keep the piece." },
    })]);
  });
  it.each(["tool", "automation", "mcp", "cli", "http", undefined])("excludes %s callers before touching persistence", async caller => {
    const f = setup();
    expect(await f.useCase.begin({ ...f.call, caller })).toBeNull();
    expect(f.store.latestRun).not.toHaveBeenCalled();
  });
  it.each([{ runId: "run_recipe" }, { toolCallId: "tool_agent" }, { threadId: "thread_agent" }, { owner: null }, { requestId: null }, { action: "get-request" }])("excludes non-operator or read calls: %s", async extra => {
    const f = setup(); expect(await f.useCase.begin({ ...f.call, ...extra })).toBeNull();
  });
  it.each([-1, 0, CORRECTION_WINDOW_MS, CORRECTION_WINDOW_MS + 1])("enforces the completion-time window at offset %i", async offset => {
    const f = setup(); f.setNow(1000 + offset);
    expect(Boolean(await f.useCase.begin(f.call))).toBe(offset >= 0 && offset <= CORRECTION_WINDOW_MS);
  });
  it.each([{ status: "running" }, { status: "failed" }, { status: "handed_off" }, { status: "awaiting_approval" }, { mode: "dry-run" }, { automatic: false }, { approvedStepIds: ["refund"] }])("excludes non-auto-completed runs %s", async extra => {
    const f = setup(); Object.assign(f.run, extra); expect(await f.useCase.begin(f.call)).toBeNull();
  });
  it.each([
    ["send-reply", { requestId: "req_other" }], ["issue-refund", { orderId: "ord_other" }], ["tag-request", { requestId: "req_other", tag: "x" }],
  ])("rejects unrelated %s targets", async (action, input) => {
    const f = setup(); expect(await f.useCase.begin({ ...f.call, action, input })).toBeNull();
  });
  it.each([
    ["send-reply", "reply", { requestId: "req_1", template: "New reply" }, { body: "New reply" }],
    ["issue-refund", "refund", { orderId: "ord_1", amount: { amountMinor: 1000, currency: "USD" } }, { amount: { amountMinor: 1000, currency: "USD" } }],
    ["tag-request", "tag", { requestId: "req_1", tag: "replacement-policy" }, { tags: ["damaged", "replacement-policy"] }],
  ])("maps %s to %s without parsing text", async (action, stepId, input, output) => {
    const f = setup(); await (await f.useCase.begin({ ...f.call, action, input }))?.(output);
    expect([...f.rows.values()][0]).toMatchObject({ stepId, action, input, output });
  });
  it("ignores identical reply, redundant tag, absent run and absent matching effect", async () => {
    const f = setup(); await (await f.useCase.begin(f.call))?.({ body: "Half price" });
    await (await f.useCase.begin({ ...f.call, action: "tag-request", input: { requestId: "req_1", tag: "damaged" } }))?.({ tags: ["damaged"] });
    expect(f.rows.size).toBe(0);
    (f.run.steps[1] as any).status = "failed"; (f.run.steps[0] as any).status = "failed";
    expect(await f.useCase.begin(f.call)).toBeNull();
    vi.mocked(f.store.latestRun).mockResolvedValue(null); expect(await f.useCase.begin(f.call)).toBeNull();
  });
});
describe("correction proposal decisions", () => {
  async function recorded() { const f = setup(); await (await f.useCase.begin(f.call))?.({ body: "Keep the piece" }); return f; }
  it("saves a proposal, accepts only via activation and preserves an idempotent acceptance", async () => {
    const f = await recorded(); const activate = vi.fn(async () => "active");
    expect(await f.useCase.propose(owner, "cor_1", { description: "Keep the piece" }, async () => candidate)).toEqual(candidate);
    expect(f.rows.get("cor_1")?.status).toBe("proposed");
    await f.useCase.activate(owner, version.recipeId, candidate.id, activate);
    expect(f.rows.get("cor_1")).toMatchObject({ status: "accepted", proposal: { version: candidate }, decision: { by: owner, reason: null } });
    await f.useCase.activate(owner, version.recipeId, candidate.id, activate);
    await expect(f.useCase.reject(owner, "cor_1", "No")).rejects.toThrow(/pending/);
    await expect(f.useCase.propose(owner, "cor_1", null, async () => candidate)).rejects.toThrow(/already/);
  });
  it("records rejection reason, allows identical retries and blocks activation or changed terminal decisions", async () => {
    const f = await recorded();
    await f.useCase.propose(owner, "cor_1", null, async () => candidate);
    await expect(f.useCase.reject(owner, "cor_1", "  ")).rejects.toThrow(/reason/);
    const rejected = await f.useCase.reject(owner, "cor_1", "Do not change policy");
    expect(await f.useCase.reject(owner, "cor_1", "Do not change policy")).toEqual(rejected);
    const activate = vi.fn(); await expect(f.useCase.activate(owner, version.recipeId, candidate.id, activate)).rejects.toThrow(/rejected/);
    expect(activate).not.toHaveBeenCalled();
    await expect(f.useCase.reject(owner, "cor_1", "Another reason")).rejects.toThrow(/pending/);
  });
  it("enforces owner/workspace/version linkage and rolls back failed ports", async () => {
    const f = await recorded(); const save = vi.fn(async () => candidate);
    for (const foreign of [{ ...owner, userId: "other" }, { ...owner, workspaceId: "other" }]) {
      expect(await f.useCase.list(foreign, {})).toEqual([]);
      await expect(f.useCase.propose(foreign, "cor_1", null, save)).rejects.toThrow(/not found/);
    }
    expect(save).not.toHaveBeenCalled();
    await expect(f.useCase.reject(owner, "cor_1", "No")).rejects.toThrow(/pending/);
    for (const invalid of [version, { ...candidate, recipeId: "other" }])
      await expect(f.useCase.propose(owner, "cor_1", null, async () => invalid)).rejects.toThrow(/new version/);
    await expect(f.useCase.propose(owner, "cor_1", null, async () => { throw new Error("save failed"); })).rejects.toThrow(/failed/);
    expect(f.rows.get("cor_1")?.status).toBe("recorded");
    await f.useCase.propose(owner, "cor_1", null, save);
    await expect(f.useCase.activate(owner, version.recipeId, candidate.id, async () => { throw new Error("activation failed"); })).rejects.toThrow(/failed/);
    expect(f.rows.get("cor_1")?.status).toBe("proposed");
  });
});
