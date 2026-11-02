import { describe, expect, it } from "vitest";
import { expressionPaths, resolveArguments, resolveBinding } from "./evaluation.js";
import { inferBindings } from "./inference.js";
import type { Binding, BindingContext, JsonObject, Trace } from "./model.js";

const trigger: JsonObject = { requestId: "req_0001", orderId: "ord_1001", productId: "prd_platter" };
const reply = "Hi Maya, I am so sorry your Ember serving platter arrived chipped. We have refunded $140.00, half of its price. Warmly, Kiln & Co.";
function trace(price = 28000, refunded = 14000): Trace {
  return { id: "demo_keyed", steps: [
    { id: "order", action: "get-order", input: { orderId: "ord_1001" }, output: { items: [
      { productId: "prd_platter", name: "Ember Large Serving Platter", unitPrice: { amountMinor: price, currency: "USD" } },
      { productId: "prd_decoy", name: "Sand Bowl", unitPrice: { amountMinor: refunded, currency: "USD" } },
    ], shippingAddress: { name: "Maya Ashcombe" } } },
    { id: "refund", action: "issue-refund", input: { orderId: "ord_1001", amount: { amountMinor: refunded, currency: "USD" } }, output: { amount: { amountMinor: refunded, currency: "USD" } } },
    { id: "reply", action: "send-reply", input: { requestId: "req_0001", template: reply, variables: {} }, output: null },
  ] };
}
const keyedPrice = { find: [{ var: "steps.order.output.items" }, "productId", { var: "trigger.productId" }, "unitPrice.amountMinor"] };
const keyedCurrency = { find: [{ var: "steps.order.output.items" }, "productId", { var: "trigger.productId" }, "unitPrice.currency"] };
const observation = (input: Trace): BindingContext => ({ trigger, steps: Object.fromEntries(input.steps.map(step => [step.id, { output: step.output }])) });

describe("keyed and derived-text provenance", () => {
  it("ranks keyed half-price above a positional exact match, and keeps money leaves coherent", () => {
    const result = inferBindings(trace(), trigger);
    expect(result.steps[1]!.args.amount).toEqual({ amountMinor: { mode: "expr", expr: { "*": [keyedPrice, 0.5] } }, currency: { mode: "expr", expr: keyedCurrency } });
    const currency = result.proposals.find(item => item.stepId === "refund" && item.argumentPath === "amount.currency")!;
    expect(currency.candidates.filter(candidate => candidate.reason !== "constant")).toHaveLength(1);
    expect(result.ambiguities.some(item => item.stepId === "refund" && item.argumentPath === "amount.currency" && item.kind === "multiple-candidates")).toBe(false);
    expect(result.ambiguities.some(item => item.stepId === "refund" && item.kind === "positional-array")).toBe(false);
    const args = resolveArguments(result.steps[1]!.args, { trigger: { ...trigger, productId: "prd_bowl", orderId: "ord_other" }, steps: { order: { output: { items: [
      { productId: "prd_decoy", unitPrice: { amountMinor: 90000, currency: "EUR" } },
      { productId: "prd_bowl", unitPrice: { amountMinor: 4400, currency: "GBP" } },
    ] } } } });
    expect(args).toEqual({ orderId: "ord_other", amount: { amountMinor: 2200, currency: "GBP" } });
  });
  it("infers first name and formatted money from the earlier refund output, keeping partial product text literal and flagged", () => {
    const result = inferBindings(trace(), trigger);
    const template = result.steps[2]!.args.template as Binding;
    expect(template.mode).toBe("expr");
    expect(JSON.stringify(template)).toContain('"firstWord"');
    expect(JSON.stringify(template)).toContain('"money"');
    expect(expressionPaths(template.mode === "expr" ? template.expr : null)).toContain("steps.refund.output.amount.amountMinor");
    expect(result.ambiguities).toEqual(expect.arrayContaining([expect.objectContaining({ stepId: "reply", argumentPath: "template", kind: "request-specific-text", message: "Text may contain request-specific details.", fragments: expect.arrayContaining(["Ember serving platter"]) })]));
    expect(resolveArguments(result.steps[2]!.args, { trigger: { ...trigger, requestId: "req_other" }, steps: {
      order: { output: { shippingAddress: { name: "Elias Navarro" } } }, refund: { output: { amount: { amountMinor: 2200, currency: "USD" } } },
    } })).toEqual({ requestId: "req_other", variables: {}, template: reply.replace("Maya", "Elias").replace("$140.00", "$22.00") });
  });
  it("re-verifies EVERY proposed candidate against observed nested inputs", () => {
    const input = trace(); const result = inferBindings(input, trigger); const context = observation(input);
    for (const proposal of result.proposals) {
      const original = input.steps.find(step => step.id === proposal.stepId)!.input;
      const observed = proposal.argumentPath === "amount.amountMinor" ? 14000 : proposal.argumentPath === "amount.currency" ? "USD" : original[proposal.argumentPath];
      for (const candidate of proposal.candidates) expect(resolveBinding(candidate.binding, context)).toEqual(observed);
    }
  });
  it("raises positional ambiguity when there is no usable unique trigger key", () => {
    const input = trace();
    const noKey = inferBindings(input, { requestId: "req_0001", orderId: "ord_1001" });
    expect(noKey.ambiguities.some(item => item.stepId === "refund" && item.kind === "positional-array")).toBe(true);
    const order = input.steps[0]!;
    const duplicate = { ...input, steps: [{ ...order, output: { items: [
      { productId: "prd_platter", unitPrice: { amountMinor: 28000, currency: "USD" } },
      { productId: "prd_platter", unitPrice: { amountMinor: 10000, currency: "USD" } },
    ] } }, input.steps[1]!] };
    expect(inferBindings(duplicate, trigger).ambiguities.some(item => item.kind === "positional-array")).toBe(true);
  });
  it("combines keyed selection and integer rounding without fitting arbitrary ratios", () => {
    const result = inferBindings(trace(2499, 1250), trigger);
    expect(result.steps[1]!.args.amount).toMatchObject({ amountMinor: { mode: "expr", expr: { round: [{ "*": [keyedPrice, 0.5] }] } } });
  });
  it("supports nested keyed arrays and preserves positional warnings for unkeyed inner arrays", () => {
    const input: Trace = { id: "demo_nested", steps: [
      { id: "load", action: "read", input: {}, output: { groups: [{ groupId: "grp_a", items: [{ productId: "prd_b", price: 28000 }] }] } },
      { id: "set", action: "mutate", input: { value: 14000 }, output: null },
    ] };
    const fields = { groupId: "grp_a", productId: "prd_b" };
    const result = inferBindings(input, fields);
    expect(resolveArguments(result.steps[1]!.args, { trigger: fields, steps: { load: { output: { groups: [
      { groupId: "other", items: [] }, { groupId: "grp_a", items: [{ productId: "decoy", price: 1 }, { productId: "prd_b", price: 4400 }] },
    ] } } } })).toEqual({ value: 2200 });
    expect(result.ambiguities.some(item => item.stepId === "set" && item.kind === "positional-array")).toBe(false);
    expect(inferBindings(input, { groupId: "grp_a" }).ambiguities.some(item => item.stepId === "set" && item.kind === "positional-array")).toBe(true);
  });
  it("derives decimal-only money, negative amounts and repeated placeholders", () => {
    const input: Trace = { id: "demo_decimal", steps: [
      { id: "load", action: "get-customer", input: {}, output: { name: "Zoë Smith", amount: { amountMinor: -1250, currency: "USD" } } },
      { id: "set", action: "mutate", input: { text: "Hi Zoë: -12.50 and -$12.50 for Zoë." }, output: null },
    ] };
    const result = inferBindings(input, {});
    expect(resolveArguments(result.steps[1]!.args, { trigger: {}, steps: { load: { output: { name: "Maya Ashcombe", amount: { amountMinor: 2200, currency: "USD" } } } } })).toEqual({ text: "Hi Maya: 22.00 and $22.00 for Maya." });
  });
  it("warns about an unknown proper detail without fabricating a replacement", () => {
    const result = inferBindings({ id: "demo_unknown", steps: [{ id: "reply", action: "reply", input: { text: "We are sorry your Ruby bowl arrived chipped." }, output: null }] }, {});
    expect(result.steps[0]!.args.text).toEqual({ mode: "fixed", value: "We are sorry your Ruby bowl arrived chipped." });
    expect(result.ambiguities.some(item => item.kind === "request-specific-text")).toBe(true);
  });
  it("does not treat a product name as a person's first name", () => {
    const input: Trace = { id: "demo_product", steps: [
      { id: "product", action: "get-product", input: {}, output: { name: "Ember Large Serving Platter" } },
      { id: "reply", action: "reply", input: { text: "Your Ember serving platter arrived chipped." }, output: null },
    ] };
    const result = inferBindings(input, {});
    expect(result.steps[1]!.args.text).toEqual({ mode: "fixed", value: "Your Ember serving platter arrived chipped." });
    expect(result.ambiguities.some(item => item.kind === "request-specific-text")).toBe(true);
  });
});
