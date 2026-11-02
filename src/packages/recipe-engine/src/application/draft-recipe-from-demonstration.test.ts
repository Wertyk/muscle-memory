import { describe, expect, it, vi } from "vitest";
import type { Demonstration, DemonstrationOwner } from "../domain/demonstration.js";
import { evaluateCondition, resolveArguments } from "../domain/evaluation.js";
import type { ActionStep, TraceStep } from "../domain/model.js";
import type { RecipeRepository, TraceStore } from "./ports.js";
import { DraftRecipeFromDemonstration, type RecipeDraft } from "./draft-recipe-from-demonstration.js";
import { parseRecipeVersion } from "./recipe-schema.js";

const owner = { userId: "operator@example.test", workspaceId: "shop" };
function fixture(price = 28000, refund = 14000): Demonstration {
  const actions: Omit<TraceStep, "id">[] = [
    { action: "get-request", input: { requestId: "req_0001" }, output: { id: "req_0001", orderId: "ord_1001" } },
    { action: "get-order", input: { orderId: "ord_1001" }, output: { id: "ord_1001", items: [{ unitPrice: { amountMinor: price, currency: "USD" } }], shippingAddress: { name: "Maya Ashcombe" } } },
    { action: "get-shipment-status", input: { orderId: "ord_1001" }, output: { tracking: "TRACK1001" } },
    { action: "get-customer", input: { customerId: "cus_0001" }, output: { name: "Maya Ashcombe" } },
    { action: "get-request-activity", input: { requestId: "req_0001" }, output: [] },
    { action: "issue-refund", input: { orderId: "ord_1001", amount: { amountMinor: refund, currency: "USD" }, reason: "Damaged item" }, output: { id: "ref_0001", amount: { amountMinor: refund, currency: "USD" } } },
    { action: "send-reply", input: { requestId: "req_0001", template: "Hi {{name}}, refunded {{amount}} minor units.", variables: { name: "Maya Ashcombe", amount: refund } }, output: { id: "rep_0001" } },
    { action: "tag-request", input: { requestId: "req_0001", tag: "damaged" }, output: { tags: ["damaged"] } },
  ];
  return { id: "demo_0001", scope: { ...owner, sessionId: "tab_a" }, subjectId: "req_0001", references: {},
    trigger: { type: "damaged_item", orderId: "ord_1001", requestId: "req_0001", customerId: "cus_0001", subject: "A broken platter" },
    status: "completed", startedAt: 1, stoppedAt: 20, incompleteReason: null, nextSequence: 9, pending: [],
    steps: actions.map((step, index) => ({ ...step, id: `step_${index + 1}`, sequence: index + 1, navigation: null, caller: "frontend", startedAt: index + 1, durationMs: 1 })) };
}
function setup(demo = fixture()) {
  let saved: RecipeDraft | null = null;
  const store: TraceStore = { transaction: async work => work({
    active: async () => null, latest: async () => null, save: async () => {},
    get: async (actor, id) => id === demo.id && actor.userId === owner.userId && actor.workspaceId === owner.workspaceId ? demo : null,
  }) };
  const createDraft = vi.fn<RecipeRepository["createDraft"]>(async (_owner, value) => { saved = JSON.parse(JSON.stringify(value)) as RecipeDraft; });
  const getDraft = vi.fn(async (_owner: DemonstrationOwner, _id: string) => saved);
  const describeAction = vi.fn(async (action: string) => ({ effect: action.startsWith("get-") ? "read" as const : "mutation" as const }));
  const useCase = new DraftRecipeFromDemonstration({ traces: store, recipes: { createDraft, getDraft }, actions: { describe: describeAction },
    nextId: kind => kind === "recipe" ? "recipe_test" : "ver_test" });
  return { useCase, createDraft, describeAction, input: { demonstrationId: demo.id, owner } };
}
const action = (draft: RecipeDraft, name: string) => draft.draft.steps.find(step => step.kind === "action" && step.action === name) as ActionStep;

describe("DraftRecipeFromDemonstration", () => {
  it("infers price/name/id bindings, prunes unused reads and saves a valid inactive draft plus doubts", async () => {
    const { useCase, input, createDraft } = setup();
    const result = await useCase.execute(input);
    expect(parseRecipeVersion(result.draft)).toEqual(result.draft);
    expect(result.recipe).toEqual({ id: "recipe_test", name: "Draft: damaged_item", status: "draft", activeVersionId: null });
    expect(result.draft.steps.map(step => step.id)).toEqual(["step_2", "step_6", "step_7", "step_8"]);
    expect(action(result, "get-order").args.orderId).toEqual({ mode: "path", path: "trigger.orderId" });
    expect(action(result, "issue-refund").args.amount).toMatchObject({ amountMinor: { mode: "expr", expr: { "*": [{ var: "steps.step_2.output.items[0].unitPrice.amountMinor" }, 0.5] } } });
    expect(action(result, "send-reply").args.variables).toMatchObject({ name: { mode: "path", path: "steps.step_2.output.shippingAddress.name" }, amount: { mode: "expr" } });
    expect(action(result, "tag-request").args.tag).toEqual({ mode: "fixed", value: "damaged" });
    expect(result.ambiguities).toEqual(expect.arrayContaining([expect.objectContaining({ stepId: "step_6", argumentPath: "amount.amountMinor", kind: "constant-or-variable" })]));
    expect(result.ambiguities).toEqual(expect.arrayContaining([expect.objectContaining({ stepId: "step_7", argumentPath: "variables.amount", kind: "constant-or-variable" })]));
    expect(result.ambiguities.some(item => ["step_1", "step_3", "step_4", "step_5"].includes(item.stepId))).toBe(false);
    expect(createDraft).toHaveBeenCalledExactlyOnceWith(owner, result);
    expect(await useCase.get(owner, result.draft.id)).toEqual(result);
    expect(evaluateCondition(result.draft.trigger.match, { trigger: { ...fixture().trigger, requestId: "req_other", orderId: "ord_other", subject: "Different" }, steps: {} })).toBe(true);
    expect(evaluateCondition(result.draft.trigger.match, { trigger: { type: "return" }, steps: {} })).toBe(false);
    expect(Object.isFrozen(result.draft.steps)).toBe(true);
  });

  it("keeps a read chain needed by a mutation and drops an unused read chain", async () => {
    const demo = fixture();
    const trace: Omit<TraceStep, "id">[] = [
      { action: "get-key", input: { requestId: "req_0001" }, output: { key: "key_kept" } },
      { action: "get-value", input: { key: "key_kept" }, output: { code: "code_kept" } },
      { action: "get-unused-key", input: { requestId: "req_0001" }, output: { key: "key_unused" } },
      { action: "get-unused-value", input: { key: "key_unused" }, output: { code: "code_unused" } },
      { action: "tag-request", input: { requestId: "req_0001", tag: "code_kept" }, output: null },
    ];
    const steps = trace.map((step, index) => ({ ...demo.steps[0]!, ...step, id: `step_${index + 1}`, sequence: index + 1 }));
    const { useCase, input } = setup({ ...demo, steps });
    const result = await useCase.execute(input);
    expect(result.draft.steps.map(step => step.id)).toEqual(["step_1", "step_2", "step_5"]);
  });

  it("reuses rounded inference and makes a literal reply evaluable without mutation outputs", async () => {
    const demo = fixture(2499, 1250);
    const steps = demo.steps.map(step => step.action === "send-reply" ? { ...step, input: { requestId: "req_0001", template: "Hi Maya Ashcombe, refunded 1250 minor units.", variables: {} } } : step);
    const { useCase, input } = setup({ ...demo, steps });
    const result = await useCase.execute(input);
    expect(action(result, "issue-refund").args.amount).toMatchObject({ amountMinor: { mode: "expr", expr: { round: [{ "*": [{ var: "steps.step_2.output.items[0].unitPrice.amountMinor" }, 0.5] }] } } });
    expect(resolveArguments(action(result, "send-reply").args, {
      trigger: { requestId: "req_other" }, steps: { step_2: { output: { items: [{ unitPrice: { amountMinor: 3699, currency: "USD" } }], shippingAddress: { name: "Other Customer" } } } },
    })).toEqual({ requestId: "req_other", template: "Hi Other Customer, refunded 1850 minor units.", variables: {} });
  });

  it.each(["recording", "incomplete", "cancelled"] as const)("rejects %s traces without writes", async status => {
    const { useCase, input, createDraft } = setup({ ...fixture(), status });
    await expect(useCase.execute(input)).rejects.toMatchObject({ code: "INVALID_DEMONSTRATION" });
    expect(createDraft).not.toHaveBeenCalled();
  });
  it.each([
    { pending: [9] }, { trigger: { requestId: "req_0001" } }, { steps: [] }, { stoppedAt: null },
    { steps: [...fixture().steps].reverse() }, { incompleteReason: "capture failed" },
  ])("rejects invalid/empty/unordered traces (%j)", async change => {
    const { useCase, input, createDraft } = setup({ ...fixture(), ...change });
    await expect(useCase.execute(input)).rejects.toMatchObject({ code: "INVALID_DEMONSTRATION" });
    expect(createDraft).not.toHaveBeenCalled();
  });
  it("denies foreign or missing demonstrations and fails closed on unknown action metadata", async () => {
    const { useCase, input, createDraft, describeAction } = setup();
    await expect(useCase.execute({ ...input, owner: { ...owner, userId: "other" } })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(useCase.execute({ ...input, demonstrationId: "demo_missing" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    describeAction.mockRejectedValue(new Error("Unknown action"));
    await expect(useCase.execute(input)).rejects.toThrow("Unknown action");
    expect(createDraft).not.toHaveBeenCalled();
  });
  it("does not replace genuinely generated mutation result IDs with invented dry-run output", async () => {
    const demo = fixture();
    const result = setup({ ...demo, steps: demo.steps.map(step => step.action === "tag-request" ? { ...step, input: { requestId: "req_0001", tag: "ref_0001" } } : step) });
    const draft = await result.useCase.execute(result.input);
    expect(action(draft, "tag-request").args.tag).toEqual({ mode: "path", path: "steps.step_6.output.id" });
  });
});
