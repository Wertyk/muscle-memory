/* oxlint-disable unicorn/no-thenable -- Fixtures model the recipe DSL's non-callable `then` arrays. */
import { describe, expect, it } from "vitest";
import type { RecipeVersion, Step } from "../domain/model.js";
import { inferBindings } from "../domain/inference.js";
import { bindingSchema, parseRecipeVersion, recipeVersionSchema } from "./recipe-schema.js";

function fixture(): RecipeVersion {
  return {
    id: "ver_0001", recipeId: "recipe_refund", version: 1, name: "Partial refund",
    trigger: { event: "request.created", match: { "===": [{ var: "trigger.reason" }, "damaged"] } },
    steps: [
      { id: "order", kind: "action", action: "get-order", args: { id: { mode: "path", path: "trigger.orderId" } } },
      { id: "extract", kind: "extract", text: { mode: "path", path: "trigger.body" }, fields: { category: { type: "string", required: true } }, approval: false },
      { id: "route", kind: "branch", condition: { "===": [{ var: "steps.extract.output.category" }, "damaged"] }, then: [
        { id: "refund", kind: "action", action: "refund", args: { amount: { mode: "expr", expr: { "*": [0.5, { var: "steps.order.output.price" }] } } }, approval: { ">": [{ var: "steps.order.output.price" }, 100] } },
        { id: "reply", kind: "action", action: "send-reply", args: { text: { mode: "template", template: "Refunded {{steps.refund.output.amount}}" }, tags: [{ mode: "fixed", value: "damaged" }] } },
      ], else: [{ id: "handoff", kind: "handoff", to: "agent", note: { mode: "fixed", value: "Review damage" }, approval: true }] },
    ],
  };
}

describe("recipe version schema", () => {
  it("accepts a trigger condition, all four step/binding modes, and per-step approvals", () => {
    expect(parseRecipeVersion(fixture())).toEqual(fixture());
  });

  it("accepts inferred steps directly as a validated draft version", () => {
    const inferred = inferBindings({ id: "demo", steps: [
      { id: "order", action: "get-order", input: { id: "ord_1042" }, output: { price: 50 } },
      { id: "refund", action: "refund", input: { amount: 25 }, output: { amount: 25 } },
    ] }, { orderId: "ord_1042" });
    const version = parseRecipeVersion({ ...fixture(), steps: inferred.steps });
    expect(version.steps).toEqual(inferred.steps);
    expect(Object.isFrozen(version.steps)).toBe(true);
  });

  it.each(["round", "floor", "ceil"])("accepts inferred integer %s expressions as a validated draft version", (operator) => {
    const observed = operator === "floor" ? 1249 : 1250;
    const inferred = inferBindings({ id: "demo", steps: [
      { id: "order", action: "get-order", input: { id: "ord_1042" }, output: { price: 2499 } },
      { id: "refund", action: "refund", input: { amount: observed }, output: { amount: observed } },
    ] }, { orderId: "ord_1042" });
    const candidate = inferred.proposals.find((p) => p.stepId === "refund")!.candidates.find((c) => c.binding.mode === "expr" && Object.hasOwn(c.binding.expr as object, operator));
    expect(candidate).toBeDefined();
    const steps = inferred.steps.map((step) => step.id === "refund" ? { ...step, args: { ...step.args, amount: candidate!.binding } } : step);
    const version = parseRecipeVersion({ ...fixture(), steps });
    expect(version.steps).toEqual(steps);
  });

  it("detaches and deep-freezes every part of a validated immutable version", () => {
    const input = fixture();
    const version = parseRecipeVersion(input);
    expect(version).not.toBe(input);
    expect(version.steps).not.toBe(input.steps);
    expect(Object.isFrozen(version)).toBe(true);
    expect(Object.isFrozen(version.trigger.match)).toBe(true);
    expect(Reflect.set(version, "version", 2)).toBe(false);
    expect(Reflect.set(version.steps[0]!, "action", "other")).toBe(false);
    const order = version.steps[0]!;
    if (order.kind !== "action") throw new Error("fixture");
    expect(Reflect.set(order.args.id!, "path", "trigger.changed")).toBe(false);
    Reflect.set(input.trigger, "event", "changed");
    expect(version.trigger.event).toBe("request.created");
    const v2 = parseRecipeVersion({ ...input, id: "ver_0002", version: 2 });
    expect(v2.version).toBe(2);
    expect(version.version).toBe(1);
  });

  it.each([
    { version: 0 }, { version: 1.2 }, { version: Number.MAX_SAFE_INTEGER + 1 },
    { id: "a".repeat(32) }, { id: "constructor" }, { name: "" }, { steps: [] },
    { trigger: { event: "request.created" } }, { extra: true },
    { steps: [{ id: "x", kind: "unknown" }] },
    { steps: [{ id: "x", kind: "extract", text: { mode: "fixed", value: "body" }, fields: {} }] },
    { steps: [{ id: "x", kind: "handoff", to: "model", note: { mode: "fixed", value: "note" } }] },
  ])("rejects invalid DSL fields %j", (change) => {
    expect(recipeVersionSchema.safeParse({ ...fixture(), ...change }).success).toBe(false);
  });

  it.each([
    { mode: "expr", expr: { eval: "doBadThings()" } },
    { mode: "path", path: "trigger.constructor.secret" },
    { mode: "template", template: "{{trigger.id}" },
    { mode: "fixed", value: Infinity },
    { mode: "path", path: "trigger.id", extra: true },
    { mode: "unknown", value: 5 },
  ])("rejects invalid bindings without throwing out of safeParse: %j", (binding) => {
    expect(bindingSchema.safeParse(binding).success).toBe(false);
    expect(recipeVersionSchema.safeParse({ ...fixture(), steps: [{ id: "x", kind: "action", action: "run", args: { x: binding } }] }).success).toBe(false);
  });

  it.each<Step>([
    { id: "x", kind: "action", action: "a", args: { id: { mode: "path", path: "steps.x.output.id" } } },
    { id: "x", kind: "action", action: "a", args: { id: { mode: "template", template: "{{steps.future.output.id}}" } } },
    { id: "x", kind: "action", action: "a", args: {}, approval: { var: "steps.x.output.amount" } },
    { id: "x", kind: "branch", condition: { var: "steps.missing.output.ok" }, then: [], else: [] },
  ])("rejects missing, self, and forward references in %j", (step) => {
    expect(recipeVersionSchema.safeParse({ ...fixture(), steps: [step] }).success).toBe(false);
  });

  it("disallows step-output dependencies in a trigger match", () => {
    expect(recipeVersionSchema.safeParse({ ...fixture(), trigger: { event: "x", match: { var: "steps.order.output.id" } } }).success).toBe(false);
  });

  it("rejects duplicate step IDs including duplicates across mutually exclusive branches", () => {
    const step: Step = { id: "x", kind: "action", action: "lookup", args: {} };
    expect(recipeVersionSchema.safeParse({ ...fixture(), steps: [step, step] }).success).toBe(false);
    expect(recipeVersionSchema.safeParse({ ...fixture(), steps: [{ id: "b", kind: "branch", condition: true, then: [step], else: [step] }] }).success).toBe(false);
  });

  it("does not expose conditional outputs to sibling branches or following steps", () => {
    const recipe = fixture();
    const after: Step = { id: "after", kind: "action", action: "use-refund", args: { id: { mode: "path", path: "steps.refund.output.id" } } };
    expect(recipeVersionSchema.safeParse({ ...recipe, steps: [...recipe.steps, after] }).success).toBe(false);
    const branch = recipe.steps[2]!;
    if (branch.kind !== "branch") throw new Error("fixture");
    expect(recipeVersionSchema.safeParse({ ...recipe, steps: [...recipe.steps.slice(0, 2), { ...branch, else: [after] }] }).success).toBe(false);
  });

  it("rejects cycles, overly deep trees, and unsafe keys before recursive schema parsing", () => {
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(recipeVersionSchema.safeParse(cycle).success).toBe(false);
    let deep: unknown = 1;
    for (let i = 0; i < 80; i++) deep = { nested: deep };
    expect(recipeVersionSchema.safeParse({ ...fixture(), steps: deep }).success).toBe(false);
    const unsafe = JSON.parse('{"__proto__":{"polluted":true}}');
    expect(recipeVersionSchema.safeParse({ ...fixture(), steps: [{ id: "x", kind: "action", action: "a", args: unsafe }] }).success).toBe(false);
  });
});
