import { describe, expect, it } from "vitest";
import { evaluateCondition, evaluateExpression, EvaluationError, expressionPaths, readPath, resolveArguments, resolveBinding } from "./evaluation.js";
import type { BindingContext, Expression } from "./model.js";

const context: BindingContext = {
  trigger: { id: "req_0007", empty: null, reason: "damaged" },
  steps: { order: { output: { price: 50, items: [{ name: "Mug" }] } } },
};

describe("safe JSONLogic subset", () => {
  it.each<[Expression, unknown]>([
    [{ "*": [{ var: "steps.order.output.price" }, 0.5] }, 25],
    [{ "-": [50, 13] }, 37], [{ "-": [13] }, -13],
    [{ "+": [1, 2, 3] }, 6], [{ "/": [50, 2] }, 25], [{ "%": [13, 5] }, 3],
    [{ min: [2, 1] }, 1], [{ max: [2, 1] }, 2],
    [{ "===": [{ var: "trigger.reason" }, "damaged"] }, true],
    [{ "==": ["25", 25] }, true], [{ "==": [false, 0] }, true],
    [{ "!=": [25, "25"] }, false], [{ "!==": [25, "25"] }, true],
    [{ ">": [50, 10] }, true], [{ ">=": [50, 50] }, true],
    [{ "<": [1, 2, 3] }, true], [{ "<=": [1, 1, 2] }, true],
    [{ "!": [[]] }, true], [{ "!!": ["yes"] }, true],
    [{ and: [1, "last"] }, "last"], [{ or: [[], false, "found"] }, "found"],
    [{ cat: ["Hi ", { var: "trigger.id" }] }, "Hi req_0007"],
    [{ in: ["damaged", ["damaged", "lost"]] }, true], [{ in: ["Mug", "Blue Mug"] }, true],
    [{ var: ["trigger.absent", "fallback"] }, "fallback"],
    [{ var: ["trigger.empty", "fallback"] }, null],
    [{ var: "trigger.absent" }, null],
    [{ if: [false, "a", true, "b", "c"] }, "b"],
  ])("evaluates %j", (expression, expected) => {
    expect(evaluateExpression(expression, context)).toEqual(expected);
  });

  it.each<[Expression, number]>([
    [{ round: [{ "*": [2499, 0.5] }] }, 1250],
    [{ round: [-1249.5] }, -1250], [{ round: [0.5] }, 1], [{ round: [-0.5] }, -1],
    [{ round: [1249.49] }, 1249], [{ round: [-1249.49] }, -1249],
    [{ round: [1200] }, 1200], [{ round: [-0.1] }, 0], [{ round: [0] }, 0],
    [{ floor: [1249.5] }, 1249], [{ floor: [-1249.5] }, -1250],
    [{ ceil: [1249.5] }, 1250], [{ ceil: [-1249.5] }, -1249],
    [{ floor: [1200] }, 1200], [{ ceil: [1200] }, 1200], [{ ceil: [-0.1] }, 0],
  ])("rounds finite numeric expression %j to %j", (expression, expected) => {
    expect(evaluateExpression(expression, context)).toBe(expected);
  });

  it.each(["round", "floor", "ceil"])("rejects non-numeric arguments and invalid arity for %s", (operator) => {
    for (const value of ["2.5", true, null, [], { var: "trigger.id" }]) {
      expect(() => evaluateExpression({ [operator]: [value] }, context)).toThrow(/finite numbers/);
    }
    for (const value of [Infinity, -Infinity, NaN]) {
      expect(() => evaluateExpression({ [operator]: [value] }, context)).toThrow(EvaluationError);
    }
    expect(() => evaluateExpression({ [operator]: [] }, context)).toThrow(/arity/);
    expect(() => evaluateExpression({ [operator]: [1, 2] }, context)).toThrow(/arity/);
  });

  it("short circuits conditionals, and, and or without evaluating the unused arithmetic", () => {
    const fail: Expression = { "/": [1, 0] };
    expect(evaluateExpression({ if: [true, 1, fail] }, context)).toBe(1);
    expect(evaluateExpression({ and: [false, fail] }, context)).toBe(false);
    expect(evaluateExpression({ or: ["ok", fail] }, context)).toBe("ok");
    expect(evaluateCondition([], context)).toBe(false);
    expect(evaluateCondition({ ">": [{ var: "steps.order.output.price" }, 20] }, context)).toBe(true);
  });

  it.each<Expression>([
    { eval: "globalThis.secret" }, { Function: "return 1" }, { log: "secret" },
    { var: "trigger.__proto__.polluted" }, { var: "trigger.constructor" }, { var: "other.price" },
    { "+": [] }, { "-": [1, 2, 3] }, { if: [true, 1] }, { "+": [1], "-": [1] },
    { "/": [1, 0] }, { "%": [1, 0] }, { "*": [Number.MAX_VALUE, 2] },
    { "+": ["1", 2] }, { ">": [true, 1] }, { var: [1] },
  ])("rejects unsafe or malformed expression %j", (expression) => {
    expect(() => evaluateExpression(expression, context)).toThrow(EvaluationError);
  });

  it("limits expression depth and rejects cycles and non-finite literals", () => {
    let deep: Expression = true;
    for (let i = 0; i < 40; i++) deep = { "!": deep };
    expect(() => evaluateExpression(deep, context)).toThrow(/complexity/);
    const cycle: Record<string, unknown> = {};
    cycle.and = [cycle];
    expect(() => expressionPaths(cycle)).toThrow(/JSON/);
    expect(() => evaluateExpression(Infinity, context)).toThrow(/JSON/);
  });

  it("lists dependencies even in conditional/default expressions", () => {
    expect(expressionPaths({ if: [{ var: "trigger.id" }, { var: ["trigger.other", { var: "steps.order.output.price" }] }, 0] })).toEqual([
      "trigger.id", "trigger.other", "steps.order.output.price",
    ]);
  });
});

describe("binding resolution", () => {
  it("resolves fixed, path, template, and expression bindings", () => {
    expect(resolveBinding({ mode: "fixed", value: { percent: 50 } }, context)).toEqual({ percent: 50 });
    expect(resolveBinding({ mode: "path", path: "steps.order.output.items[0].name" }, context)).toBe("Mug");
    expect(resolveBinding({ mode: "template", template: "{{trigger.id}}: {{ steps.order.output.items.0.name }} ${{steps.order.output.price}}" }, context)).toBe("req_0007: Mug $50");
    expect(resolveBinding({ mode: "expr", expr: { "*": [0.5, { var: "steps.order.output.price" }] } }, context)).toBe(25);
  });

  it("resolves nested objects and arrays while retaining their shape", () => {
    expect(resolveArguments({ payload: { id: { mode: "path", path: "trigger.id" }, tags: [{ mode: "fixed", value: "damaged" }] } }, context)).toEqual({ payload: { id: "req_0007", tags: ["damaged"] } });
  });

  it("does not read inherited properties or expose array/string methods", () => {
    const inherited: BindingContext = { trigger: Object.create({ hidden: 5 }), steps: {} };
    expect(readPath(inherited, "trigger.hidden")).toBeUndefined();
    expect(readPath(context, "steps.order.output.items.map")).toBeUndefined();
    expect(readPath(context, "trigger.id.length")).toBeUndefined();
  });

  it.each(["trigger.missing", "steps.order.output.missing"]) ("fails explicitly on missing binding %s", (path) => {
    expect(() => resolveBinding({ mode: "path", path }, context)).toThrow(/Missing binding/);
    expect(() => resolveBinding({ mode: "template", template: `Hi {{${path}}}` }, context)).toThrow(/Missing template/);
  });

  it("rejects malformed placeholders, object interpolation, and path traversal", () => {
    expect(() => resolveBinding({ mode: "template", template: "{{trigger.id}" }, context)).toThrow(/Malformed/);
    expect(() => resolveBinding({ mode: "template", template: "{{trigger}}" }, context)).toThrow(/scalar/);
    expect(() => resolveBinding({ mode: "path", path: "trigger[__proto__]" }, context)).toThrow(/Invalid/);
    expect(() => resolveBinding({ mode: "path", path: "trigger.prototype" }, context)).toThrow(/Unsafe/);
  });
});
