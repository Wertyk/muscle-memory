import { describe, expect, it } from "vitest";
import { resolveArguments, resolveBinding } from "./evaluation.js";
import { inferBindings } from "./inference.js";
import type { BindingCandidate } from "./inference.js";
import type { BindingContext, JsonObject, JsonValue, Trace } from "./model.js";

const trigger: JsonObject = { id: "req_0007", orderId: "ord_1042", customer: "Mira", reason: "item_broken" };
const brokenMug: Trace = {
  id: "demo_0001",
  steps: [
    { id: "order", action: "get-order", input: { orderId: "ord_1042" }, output: { id: "ord_1042", items: [{ name: "Blue Mug", price: 50 }] } },
    { id: "refund", action: "issue-refund", input: { orderId: "ord_1042", amount: 25 }, output: { amount: 25, id: "ref_0001" } },
    { id: "reply", action: "send-reply", input: { requestId: "req_0007", body: "Hi Mira, refunded $25 for ord_1042." }, output: { sent: true } },
    { id: "tag", action: "tag-request", input: { requestId: "req_0007", tag: "damaged" }, output: { tagged: true } },
  ],
};

function one(value: JsonValue, output: JsonValue = {}): Trace {
  return { id: "demo_0002", steps: [{ id: "act", action: "perform", input: { value }, output }] };
}

describe("deterministic provenance inference", () => {
  it("infers the reference broken-mug lookup, half-price refund, reply template, and fixed tag", () => {
    const result = inferBindings(brokenMug, trigger);
    expect(result.steps.map((step) => step.action)).toEqual(["get-order", "issue-refund", "send-reply", "tag-request"]);
    expect(result.steps[0]!.args.orderId).toEqual({ mode: "path", path: "trigger.orderId" });
    expect(result.steps[1]!.args.amount).toEqual({ mode: "expr", expr: { "*": [{ var: "steps.order.output.items[0].price" }, 0.5] } });
    expect(result.steps[2]!.args.body).toEqual({ mode: "template", template: "Hi {{trigger.customer}}, refunded ${{steps.refund.output.amount}} for {{trigger.orderId}}." });
    expect(result.steps[3]!.args.tag).toEqual({ mode: "fixed", value: "damaged" });
    expect(result.ambiguities.filter((a) => a.kind === "constant-or-variable").map((a) => `${a.stepId}.${a.argumentPath}`)).toEqual(["refund.amount", "reply.body"]);
  });

  it("reproduces every demonstrated argument, using only outputs available at each step", () => {
    const result = inferBindings(brokenMug, trigger);
    const steps: Record<string, { output: JsonValue }> = {};
    for (let i = 0; i < result.steps.length; i++) {
      const original = brokenMug.steps[i]!;
      const context: BindingContext = { trigger, steps };
      expect(resolveArguments(result.steps[i]!.args, context)).toEqual(original.input);
      for (const proposal of result.proposals.filter((p) => p.stepId === original.id)) {
        for (const candidate of proposal.candidates) expect(resolveBinding(candidate.binding, context)).toEqual(original.input[proposal.argumentPath]);
      }
      steps[original.id] = { output: original.output };
    }
  });

  it("adapts the inferred amount and reply to a different request, order, customer, and price", () => {
    const result = inferBindings(brokenMug, trigger);
    const context: BindingContext = {
      trigger: { id: "req_0008", orderId: "ord_2000", customer: "Sam", reason: "item_broken" },
      steps: { order: { output: { id: "ord_2000", items: [{ name: "Plate", price: 92 }] } }, refund: { output: { amount: 46, id: "ref_0002" } } },
    };
    expect(resolveArguments(result.steps[1]!.args, context)).toEqual({ orderId: "ord_2000", amount: 46 });
    expect(resolveArguments(result.steps[2]!.args, context)).toEqual({ requestId: "req_0008", body: "Hi Sam, refunded $46 for ord_2000." });
  });

  it("keeps multiple-source ambiguity and the fixed alternative without a constant doubt for IDs", () => {
    const result = inferBindings(one("ord_1042"), { b: "ord_1042", a: "ord_1042" });
    const proposal = result.proposals[0]!;
    expect(proposal.proposed).toEqual({ mode: "path", path: "trigger.a" });
    expect(proposal.candidates.map((c) => c.binding)).toEqual([
      { mode: "path", path: "trigger.a" }, { mode: "path", path: "trigger.b" }, { mode: "fixed", value: "ord_1042" },
    ]);
    expect(result.ambiguities.map((a) => a.kind)).toEqual(["multiple-candidates"]);
  });

  it.each<JsonValue>(["ord_1042", "mira@example.test", "Mira", "damaged", 2499, 11, -11, 10.5, -10.5])("does not raise a constant doubt for high-information exact match %j", (value) => {
    const result = inferBindings(one(value), { source: value });
    expect(result.steps[0]!.args.value).toEqual({ mode: "path", path: "trigger.source" });
    expect(result.ambiguities).toEqual([]);
    expect(result.proposals[0]!.candidates.map((c) => c.reason)).toEqual(["exact-match", "constant"]);
  });

  it.each<JsonValue>([true, false, null, -10, -1, 0, 1, 10, "", "a", "abc"])("raises a constant doubt for low-information exact match %j", (value) => {
    const result = inferBindings(one(value), { source: value });
    expect(result.ambiguities).toHaveLength(1);
    expect(result.ambiguities[0]!.kind).toBe("constant-or-variable");
    expect(result.ambiguities[0]!.candidates.map((c) => c.reason)).toEqual(["exact-match", "constant"]);
  });

  it.each<[JsonValue, JsonObject, BindingCandidate["reason"]]>([
    [25, { price: 50 }, "scale"],
    [1250, { price: 2499 }, "rounded-scale"],
    [52, { total: 69, discount: 17 }, "difference"],
    ["Hi Mira!", { name: "Mira" }, "template"],
  ])("keeps a constant-or-rule doubt for derived value %j", (value, payload, reason) => {
    const result = inferBindings(one(value), payload);
    expect(result.proposals[0]!.candidates[0]!.reason).toBe(reason);
    const doubt = result.ambiguities.find((a) => a.kind === "constant-or-variable");
    expect(doubt?.candidates.at(-1)?.binding).toEqual({ mode: "fixed", value });
  });

  it.each<[number, number, string, number]>([
    [2499, 1250, "round", 5001], [2499, 1249, "floor", 5000],
    [-2499, -1250, "round", -5001], [-2499, -1249, "ceil", -5000],
  ])("infers %i scaled to %i with %s and reuses it on a new price", (price, observed, operator, changed) => {
    const result = inferBindings(one(observed), { price });
    expect(result.steps[0]!.args.value).toEqual({ mode: "expr", expr: { [operator]: [{ "*": [{ var: "trigger.price" }, 0.5] }] } });
    expect(result.proposals[0]!.candidates[0]!.reason).toBe("rounded-scale");
    for (const candidate of result.proposals[0]!.candidates) {
      expect(resolveBinding(candidate.binding, { trigger: { price }, steps: {} })).toBe(observed);
    }
    expect(resolveArguments(result.steps[0]!.args, { trigger: { price: Math.sign(price) * 10001 }, steps: {} })).toEqual({ value: changed });
  });

  it("keeps an exact 50% formula for an even-cent price without redundant rounding wrappers", () => {
    const result = inferBindings(one(1200), { price: 2400 });
    expect(result.steps[0]!.args.value).toEqual({ mode: "expr", expr: { "*": [{ var: "trigger.price" }, 0.5] } });
    expect(result.proposals[0]!.candidates.map((c) => c.reason)).toEqual(["scale", "constant"]);
  });

  it("ranks an exact scale from a later source ahead of an earlier rounded scale", () => {
    const result = inferBindings(one(1250), { a: 2499, b: 2500 });
    expect(result.steps[0]!.args.value).toEqual({ mode: "expr", expr: { "*": [{ var: "trigger.b" }, 0.5] } });
    expect(result.proposals[0]!.candidates.map((c) => c.reason)).toEqual(["scale", "rounded-scale", "rounded-scale", "constant"]);
  });

  it("ranks an exact source match ahead of formulas without a constant-or-variable question", () => {
    const result = inferBindings(one(1250), { a: 2499, b: 1250 });
    expect(result.steps[0]!.args.value).toEqual({ mode: "path", path: "trigger.b" });
    expect(result.proposals[0]!.candidates.map((c) => c.reason)).toEqual(["exact-match", "constant"]);
    expect(result.ambiguities).toEqual([]);
  });

  it("infers differences over two source numbers", () => {
    const result = inferBindings(one(52), { total: 69, discount: 17 });
    expect(result.steps[0]!.args.value).toEqual({ mode: "expr", expr: { "-": [{ var: "trigger.total" }, { var: "trigger.discount" }] } });
  });

  it("lists competing numeric formulas with their source paths", () => {
    const result = inferBindings(one(25), { a: 50, b: 100 });
    expect(result.proposals[0]!.candidates.map((c) => c.reason)).toEqual(["scale", "scale", "constant"]);
    expect(result.proposals[0]!.candidates[1]!.sourcePaths).toEqual(["trigger.b"]);
    expect(result.ambiguities.some((a) => a.kind === "multiple-candidates")).toBe(true);
  });

  it.each<JsonValue>(["unmatched", 7, false, null, [], {}])("uses a constant without inventing a source for %j", (value) => {
    const result = inferBindings(one(value), { source: "different", number: 17 });
    expect(result.steps[0]!.args.value).toEqual({ mode: "fixed", value });
    expect(result.ambiguities).toEqual([]);
  });

  it("does not fit arbitrary numeric ratios or round fractional target values", () => {
    expect(inferBindings(one(7), { price: 17 }).steps[0]!.args.value).toEqual({ mode: "fixed", value: 7 });
    expect(inferBindings(one(0.3), { price: 0.1 }).steps[0]!.args.value).toEqual({ mode: "fixed", value: 0.3 });
    expect(inferBindings(one(9), { price: 0 }).steps[0]!.args.value).toEqual({ mode: "fixed", value: 9 });
  });

  it("infers repeated and multiple text placeholders, including a numeric source", () => {
    const result = inferBindings(one("Hi Mira! Mira receives $25."), { name: "Mira", refund: 25 });
    expect(result.steps[0]!.args.value).toEqual({ mode: "template", template: "Hi {{trigger.name}}! {{trigger.name}} receives ${{trigger.refund}}." });
  });

  it("keeps competing template sources and chooses longest whole tokens", () => {
    const result = inferBindings(one("Hi Mira Lane; total 1200."), { a: "Mira Lane", b: "Mira Lane", short: "Mira", amount: 20 });
    expect(result.proposals[0]!.candidates.map((c) => c.binding)).toEqual([
      { mode: "template", template: "Hi {{trigger.a}}; total 1200." },
      { mode: "template", template: "Hi {{trigger.b}}; total 1200." },
      { mode: "fixed", value: "Hi Mira Lane; total 1200." },
    ]);
  });

  it("leaves literal placeholder syntax fixed, and never recursively interprets source text", () => {
    expect(inferBindings(one("Hi {{trigger.secret}} Mira"), { name: "Mira" }).steps[0]!.args.value).toEqual({ mode: "fixed", value: "Hi {{trigger.secret}} Mira" });
    const context: BindingContext = { trigger: { name: "{{trigger.secret}}" }, steps: {} };
    expect(resolveBinding({ mode: "template", template: "Hi {{trigger.name}}" }, context)).toBe("Hi {{trigger.secret}}");
  });

  it("uses earlier read outputs but excludes the current and all future outputs", () => {
    const trace: Trace = { id: "demo", steps: [
      { id: "first", action: "get", input: { secret: "future" }, output: { ref: "prior", current: "future" } },
      { id: "later", action: "set", input: { ref: "prior" }, output: { secret: "future" } },
    ] };
    const result = inferBindings(trace, {});
    expect(result.steps[0]!.args.secret).toEqual({ mode: "fixed", value: "future" });
    expect(result.steps[1]!.args.ref).toEqual({ mode: "path", path: "steps.first.output.ref" });
  });

  it("infers nested argument leaves while preserving arrays and object keys", () => {
    const result = inferBindings(one({ details: { id: "req_0007" }, tags: ["policy", 25] }), { id: "req_0007", price: 50 });
    expect(result.proposals.map((p) => p.argumentPath)).toEqual(["value.details.id", "value.tags[0]", "value.tags[1]"]);
    expect(resolveArguments(result.steps[0]!.args, { trigger: { id: "req_0008", price: 80 }, steps: {} })).toEqual({ value: { details: { id: "req_0008" }, tags: ["policy", 40] } });
  });

  it("matches objects and arrays structurally, independent of object key order", () => {
    const value = { a: 1, b: [2, false] };
    expect(inferBindings(one(value), { payload: { b: [2, false], a: 1 } }).steps[0]!.args.value).toEqual({ mode: "path", path: "trigger.payload" });
    expect(inferBindings(one([1, "x"]), { values: [1, "x"] }).steps[0]!.args.value).toEqual({ mode: "path", path: "trigger.values" });
  });

  it("skips unaddressable source keys while retaining literal argument keys", () => {
    expect(inferBindings(one("abc"), { "odd.key": "abc" }).steps[0]!.args.value).toEqual({ mode: "fixed", value: "abc" });
    const result = inferBindings(one({ "odd.key": "req_0007" }), { id: "req_0007" });
    expect(resolveArguments(result.steps[0]!.args, { trigger, steps: {} })).toEqual({ value: { "odd.key": "req_0007" } });
  });

  it("is stable under reordered source keys, leaves inputs mutable, and detaches its result", () => {
    expect(inferBindings(one(25), { b: 100, a: 50 })).toEqual(inferBindings(one(25), { a: 50, b: 100 }));
    const trace = one("constant");
    const before = JSON.stringify(trace);
    const result = inferBindings(trace, {});
    expect(JSON.stringify(trace)).toBe(before);
    expect(Object.isFrozen(trace)).toBe(false);
    expect(Object.isFrozen(result.proposals[0]!.candidates)).toBe(true);
    Reflect.set(trace.steps[0]!.input, "value", "changed");
    expect(result.steps[0]!.args.value).toEqual({ mode: "fixed", value: "constant" });
  });

  it("handles an empty trace and never leaks outputs between calls", () => {
    expect(inferBindings({ id: "demo", steps: [] }, {})).toEqual({ steps: [], proposals: [], ambiguities: [] });
    inferBindings(one("x", { value: "secret" }), {});
    expect(inferBindings(one("secret"), {}).steps[0]!.args.value).toEqual({ mode: "fixed", value: "secret" });
  });

  it("explicitly reports candidate truncation instead of implying complete certainty", () => {
    const many = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`key_${i}`, "same"]));
    const result = inferBindings(one("same"), many);
    expect(result.proposals[0]!.exhaustive).toBe(false);
    expect(result.proposals[0]!.candidates).toHaveLength(65); // 64 variable hypotheses + fixed
    expect(result.ambiguities.some((a) => a.kind === "candidate-limit")).toBe(true);
  });

  it("bounds numeric and combinatorial template hypotheses and reports the limit", () => {
    const prices = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`price_${i}`, 50]));
    expect(inferBindings(one(25), prices).proposals[0]!.exhaustive).toBe(false);
    const names = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`a_${i}`, "Mira"]));
    const orders = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`b_${i}`, "ord_1042"]));
    const result = inferBindings(one("Hi Mira, order ord_1042."), { ...names, ...orders });
    expect(result.proposals[0]!.exhaustive).toBe(false);
    expect(result.ambiguities.some((a) => a.kind === "candidate-limit")).toBe(true);
  });

  it("keeps multiple-candidate and limit ambiguities for bounded rounded-scale hypotheses", () => {
    const prices = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`price_${i}`, 2499]));
    const result = inferBindings(one(1250), prices);
    expect(result.proposals[0]!.exhaustive).toBe(false);
    expect(result.proposals[0]!.candidates).toHaveLength(65);
    expect(result.ambiguities.map((a) => a.kind)).toEqual(["multiple-candidates", "constant-or-variable", "candidate-limit"]);
  });

  it("rejects ambiguous step identities, non-JSON data, and prototype keys", () => {
    const step = one(1).steps[0]!;
    expect(() => inferBindings({ id: "demo", steps: [step, step] }, {})).toThrow(/unique/);
    expect(() => inferBindings({ id: "demo", steps: [{ ...step, id: "constructor" }] }, {})).toThrow(/identifiers/);
    expect(() => inferBindings(one(Infinity), {})).toThrow(/JSON/);
    expect(() => inferBindings(one(1), JSON.parse('{"__proto__":{"x":1}}'))).toThrow(/JSON/);
  });
});
