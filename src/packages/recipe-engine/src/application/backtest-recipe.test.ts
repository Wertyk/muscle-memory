/* oxlint-disable unicorn/no-thenable -- Recipe branches have a non-callable `then` step array. */
import { describe, expect, it } from "vitest";
import {
  BacktestRecipe, parseRecipeVersion, type Binding, type HistoricalCase, type JsonValue,
  type Mutation, type MutationNormalizer, type RecipeVersion, type Step,
} from "../index.js";
import { clone, InMemoryHistoricalCases, setup } from "../../test/fakes.js";
import { brokenMugCases, brokenMugRecipe } from "../../test/backtest-fixture.js";

const selection = { event: "request.created", category: "damaged", handled: true };
const fixed = (value: JsonValue): Binding => ({ mode: "fixed", value });
const reply: Step = { id: "reply", kind: "action", action: "send-reply", args: { body: fixed("Handled") } };
const outcome: readonly Mutation[] = [{ action: "send-reply", input: { body: "Handled" } }];
const historical = (id = "case_1", trigger: JsonValue = {}, mutations = outcome): HistoricalCase => ({ id, trigger, outcome: [...mutations] });
const recipe = (steps: readonly Step[], match: JsonValue = true): RecipeVersion => parseRecipeVersion({
  id: "ver_1", recipeId: "recipe_1", version: 1, name: "Handle request",
  trigger: { event: "request.created", match }, steps,
});

function arrange(cases: readonly HistoricalCase[] = [historical()], normalizer?: MutationNormalizer) {
  const deps = { ...setup(), cases: new InMemoryHistoricalCases(cases), ...(normalizer ? { normalizer } : {}) };
  return { deps, engine: new BacktestRecipe(deps) };
}

describe("BacktestRecipe historical comparison", () => {
  it("reports seven identical cases and all three deliberate deviations, with exact field diffs (AC 1/2)", async () => {
    const cases = brokenMugCases();
    const { deps, engine } = arrange(cases);
    deps.actions.define("get-order", "read", (input) => {
      const item = cases.find((c) => (c.trigger as Record<string, JsonValue>).orderId === input.orderId)!;
      return { price: (item.trigger as Record<string, JsonValue>).price! };
    });
    const result = await engine.execute({ recipe: brokenMugRecipe, selection });
    expect(result.summary).toEqual({ total: 10, identical: 7, different: 3, notHandled: 0 });
    expect(result.recipeVersionId).toBe("ver_mug_1");
    expect(result.cases.slice(0, 7).every((c) => c.status === "identical" && c.diff.length === 0)).toBe(true);
    expect(result.cases[7]).toMatchObject({ status: "different", reasons: [{ code: "different" }],
      diff: expect.arrayContaining([{ kind: "changed", path: "/0/action", historical: "create-order", intended: "issue-refund" }]) });
    expect(result.cases[8]!.diff).toEqual([{ kind: "changed", path: "/0/input/amount/amountMinor", historical: 38_000, intended: 19_000 }]);
    expect(result.cases[9]!.diff).toEqual([{ kind: "changed", path: "/1/input/body",
      historical: "Thank you for the photo. Partial refund arranged for ord_1040; we will review packaging.",
      intended: "Refunded half of one piece for ord_1040" }]);
    expect(result.cases[8]!.run!.steps[1]).toMatchObject({ status: "planned", approvalRequired: true });
    expect(deps.cases.selections).toEqual([selection]);
    expect(deps.extractor.calls).toEqual([]);
  });

  it("never invokes mutations or handoff, and never writes production runs (AC 4)", async () => {
    const { deps, engine } = arrange();
    let mutationCalls = 0;
    for (const name of ["issue-refund", "send-reply", "create-order"]) {
      deps.actions.define(name, "mutation", () => { mutationCalls++; throw new Error("MUTATION INVOKED"); });
    }
    const result = await engine.execute({ recipe: recipe([
      { id: "order", kind: "action", action: "get-order", args: {} },
      { id: "extract", kind: "extract", text: fixed("Mug broke"), fields: { reason: { type: "string", required: true } } },
      { id: "refund", kind: "action", action: "issue-refund", args: {}, approval: true }, reply,
      { id: "replacement", kind: "action", action: "create-order", args: {} },
      { id: "help", kind: "handoff", to: "human", note: fixed("Review") },
    ]), selection });
    expect(mutationCalls).toBe(0);
    expect(deps.actions.calls.map((call) => call.action)).toEqual(["get-order"]);
    expect(deps.extractor.calls).toHaveLength(1);
    expect(deps.handoff.attempts).toEqual([]);
    expect(deps.runs.history).toEqual([]);
    expect(result.cases[0]).toMatchObject({ status: "not_handled", reasons: [{ code: "handoff", stepId: "help" }],
      run: { mode: "dry-run", tokens: { input: 11, output: 3 } } });
    expect(result.cases[0]!.intendedMutations.map((m) => m.action)).toEqual(["issue-refund", "send-reply", "create-order"]);
  });

  it("filters trigger mismatches and reports evaluation errors without invoking any actions", async () => {
    const { deps, engine } = arrange([historical("mismatch", { amount: 0 }), historical("invalid", { amount: "a lot" })]);
    const result = await engine.execute({ recipe: recipe([reply], { ">": [{ var: "trigger.amount" }, 5] }), selection });
    expect(result.summary).toEqual({ total: 2, identical: 0, different: 0, notHandled: 2 });
    expect(result.cases.map((c) => c.reasons[0]!.code)).toEqual(["trigger-mismatch", "trigger-error"]);
    expect(result.cases.every((c) => c.run === null)).toBe(true);
    expect(deps.actions.calls).toEqual([]);
  });

  it("keeps failed cases isolated and includes failure reasons and partial diffs", async () => {
    const { deps, engine } = arrange([historical("bad", { fail: true }), historical("good", { fail: false })]);
    deps.actions.define("check", "read", (input) => { if (input.fail) throw new Error("Historical snapshot unavailable"); return {}; });
    const result = await engine.execute({ recipe: recipe([
      { id: "check", kind: "action", action: "check", args: { fail: { mode: "path", path: "trigger.fail" } } }, reply,
    ]), selection });
    expect(result.summary).toEqual({ total: 2, identical: 1, different: 0, notHandled: 1 });
    expect(result.cases[0]).toMatchObject({ status: "not_handled", reasons: [{ code: "failed", stepId: "check", message: "Historical snapshot unavailable" }],
      diff: [{ kind: "removed", path: "/0", historical: outcome[0] }] });
    expect(deps.handoff.attempts).toEqual([]);
  });

  it.each<Step>([
    { id: "blocked", kind: "action", action: "get-order", args: { id: { mode: "path", path: "steps.reply.output.id" } } },
    { id: "blocked", kind: "branch", condition: { var: ["steps.reply.output.id", true] }, then: [], else: [] },
  ])("never counts matching partial mutations as handled when a step is blocked", async (blocked) => {
    const { engine } = arrange();
    const result = await engine.execute({ recipe: recipe([reply, blocked]), selection });
    expect(result.cases[0]).toMatchObject({ status: "not_handled", diff: [],
      reasons: [{ code: "blocked", stepId: "blocked", blockedBy: ["steps.reply.output.id"] }] });
  });

  it.each<Step>([
    { id: "stop", kind: "action", action: "unknown-action", args: {} },
    { id: "stop", kind: "handoff", to: "agent", note: fixed("Needs review") },
  ])("does not call a partial match identical when a later step fails or hands off", async (stop) => {
    const { engine } = arrange();
    const result = await engine.execute({ recipe: recipe([reply, stop]), selection });
    expect(result.cases[0]).toMatchObject({ status: "not_handled", diff: [],
      reasons: [{ code: stop.kind === "handoff" ? "handoff" : "failed", stepId: "stop" }] });
  });

  it("records executor setup failures per case and propagates source/normaliser failures", async () => {
    const { deps, engine } = arrange();
    deps.ids.next = () => "invalid";
    const result = await engine.execute({ recipe: recipe([reply]), selection });
    expect(result.cases[0]).toMatchObject({ status: "not_handled", run: null, reasons: [{ code: "execution-error" }] });
    deps.cases.listCases = async () => { throw new Error("History offline"); };
    await expect(engine.execute({ recipe: recipe([reply]), selection })).rejects.toThrow("History offline");
    const invalid = arrange(undefined, { normalize: () => { throw new Error("Invalid normalisation policy"); } });
    await expect(invalid.engine.execute({ recipe: recipe([reply]), selection })).rejects.toThrow("Invalid normalisation policy");
  });

  it("does not treat a successful read-only or empty branch path as handling", async () => {
    const { engine } = arrange([historical("empty", {}, [])]);
    const result = await engine.execute({ recipe: recipe([
      { id: "branch", kind: "branch", condition: false, then: [reply], else: [] },
    ]), selection });
    expect(result.cases[0]).toMatchObject({ status: "not_handled", diff: [], reasons: [{ code: "no-mutations" }] });
  });

  it("uses exact ordered mutation comparison by default, with optional symmetric normalisation", async () => {
    const records = [historical("reply", {}, [{ action: "send-reply", input: { body: " Handled " } }])];
    const strict = await arrange(records).engine.execute({ recipe: recipe([reply]), selection });
    expect(strict.summary.different).toBe(1);
    const seen: (readonly Mutation[])[] = [];
    const normalized = arrange(records, { normalize: (mutations) => {
      seen.push(mutations);
      return mutations.map((m) => ({ ...m, input: { ...m.input, body: String(m.input.body).trim() } }));
    } });
    const result = await normalized.engine.execute({ recipe: recipe([reply]), selection });
    expect(result.summary.identical).toBe(1);
    expect(result.cases[0]!.historicalMutations[0]!.input.body).toBe(" Handled ");
    expect(seen).toHaveLength(2);
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(records[0]!.outcome[0]!.input.body).toBe(" Handled ");
    const reordered = await arrange([historical("reverse", {}, [...outcome, { action: "create-order", input: {} }])]).engine.execute({
      recipe: recipe([{ id: "first", kind: "action", action: "create-order", args: {} }, reply]), selection,
    });
    expect(reordered.summary.different).toBe(1);
  });

  it("loads one immutable historical set for two versions and reports changed outcomes (AC 3 engine portion)", async () => {
    const records = [historical("one", { eligible: true }), historical("two", { eligible: false })];
    const { deps, engine } = arrange(records);
    let loaded = 0;
    deps.cases.listCases = async () => { loaded++; return records; };
    deps.actions.define("snapshot", "read", () => { (records as HistoricalCase[]).length = 0; return {}; });
    const baseline = recipe([{ id: "snapshot", kind: "action", action: "snapshot", args: {} }, reply]);
    const candidate = parseRecipeVersion({ ...recipe([
      { ...reply, args: { body: fixed("New handling") } },
    ], { var: "trigger.eligible" }), id: "ver_2", version: 2 });
    const comparison = await engine.compare({ baseline, candidate, selection });
    expect(loaded).toBe(1);
    expect(comparison.baseline.summary).toEqual({ total: 2, identical: 2, different: 0, notHandled: 0 });
    expect(comparison.candidate.summary).toEqual({ total: 2, identical: 0, different: 1, notHandled: 1 });
    expect(comparison.cases[0]).toEqual({ caseId: "one", baselineStatus: "identical", candidateStatus: "different", changed: true,
      diff: [{ kind: "changed", path: "/0/input/body", historical: "Handled", intended: "New handling" }] });
    expect(comparison.cases[1]).toMatchObject({ caseId: "two", baselineStatus: "identical", candidateStatus: "not_handled", changed: true });
    expect(comparison.baseline.cases.map((c) => c.run!.id)).toEqual(["run_0001", "run_0002"]);
    expect(comparison.candidate.cases[0]!.run!.id).toBe("run_0003");
    expect(deps.actions.calls.map((call) => call.context.idempotencyKey)).toEqual(["run_0001:snapshot", "run_0002:snapshot"]);
    expect(deps.runs.history).toEqual([]);
    expect(Object.isFrozen(comparison.cases[0])).toBe(true);
  });

  it("reports unchanged versions, empty selections, and detached reports", async () => {
    const original = historical();
    const { engine } = arrange([original]);
    const version = recipe([reply]);
    const result = await engine.compare({ baseline: version, candidate: version, selection });
    expect(result.cases[0]).toMatchObject({ changed: false, diff: [] });
    (original.outcome as Mutation[]).push({ action: "extra", input: {} });
    expect(result.baseline.cases[0]!.historicalMutations).toHaveLength(1);
    const empty = await arrange([]).engine.execute({ recipe: version, selection });
    expect(empty).toMatchObject({ summary: { total: 0, identical: 0, different: 0, notHandled: 0 }, cases: [] });
  });

  it("rejects invalid input, duplicate case IDs, and malformed normalisation instead of reporting a match", async () => {
    const { deps, engine } = arrange();
    await expect(engine.execute({ recipe: recipe([reply]), selection: Infinity })).rejects.toThrow(/Selection/);
    expect(deps.cases.selections).toEqual([]);
    await expect(engine.execute({ recipe: { ...recipe([reply]), steps: [{ kind: "invalid" }] } as unknown as RecipeVersion, selection })).rejects.toThrow();
    for (const records of [[historical(), historical()], [historical("bad", Infinity)], [historical("bad", {}, [{ action: "bad", input: null } as unknown as Mutation])]]) {
      const invalid = arrange(records);
      // Bypass the JSON-cloning fake so malformed numbers reach the use-case unchanged.
      invalid.deps.cases.listCases = async () => records;
      await expect(invalid.engine.execute({ recipe: recipe([reply]), selection })).rejects.toThrow();
    }
    await expect(arrange(undefined, { normalize: () => null as unknown as Mutation[] }).engine.execute({ recipe: recipe([reply]), selection })).rejects.toThrow(/mutation list/);
    await expect(engine.compare({ baseline: recipe([reply]), candidate: parseRecipeVersion({ ...recipe([reply]), trigger: { event: "other", match: true } }), selection })).rejects.toThrow(/same trigger event/);
  });

  it("validates the entire source snapshot before any simulation begins", async () => {
    const { deps, engine } = arrange([historical("good"), historical("bad", { invalid: Infinity })]);
    deps.cases.listCases = async () => deps.cases.cases;
    let descriptions = 0;
    deps.actions.describe = async () => { descriptions++; return { effect: "mutation" }; };
    await expect(engine.execute({ recipe: recipe([reply]), selection: clone(selection) })).rejects.toThrow(/historical trigger/);
    expect(descriptions).toBe(0);
  });
});
