import { describe, expect, it } from "vitest";

import { actionLabel, backtestComparisonLabel, backtestSummary, candidateLabel, fieldLabel, moneyLabel, mutationSummary, presentationContext, resolvedCurrency, valueSummary } from "./recipe-presentation";
import { recipeMessages } from "../i18n/recipes-en";

describe("shared recipe presentation", () => {
  it("formats outcome counts and wording-only comparison labels with the shared catalog", () => {
    const t = (key: string, values: Record<string, number> = {}) => {
      const message = recipeMessages.backtests[key.replace("recipes.backtests.", "") as keyof typeof recipeMessages.backtests];
      if (typeof message !== "string") throw new Error("Expected a message");
      return message.replace(/\{\{(\w+)\}\}/g, (_match, field: string) => String(values[field]));
    };
    expect(backtestSummary({ total: 10, sameOutcome: 8, differentOutcome: 2, notHandled: 0, nonOutcomeOnly: 8 }, t))
      .toBe("8 same outcome · 2 different outcome · 0 not handled — 8 differ only in wording or tags · 10 requests");
    expect(backtestComparisonLabel({ changed: false, nonOutcomeOnly: true }, t)).toBe("Only wording or tags changed");
    expect(backtestComparisonLabel({ changed: true, nonOutcomeOnly: false }, t)).toBe("Outcome changed");
    expect(backtestComparisonLabel({ changed: false, nonOutcomeOnly: false }, t)).toBe("Unchanged");
  });

  it.each([
    ["orderId", "Order ID"], ["productId", "Product ID"], ["requestId", "Request ID"],
    ["unitPrice", "Unit price"], ["trackingURL", "Tracking URL"], ["URLValue", "URL value"],
    ["api_url", "API URL"], ["issue-refund", "Issue refund"],
  ])("labels %s as %s", (key, label) => expect(fieldLabel(key)).toBe(label));

  it("formats minor units with their currency, including zero and currency precision", () => {
    expect(moneyLabel(7000, "USD")).toBe("$70.00");
    expect(moneyLabel(0, "EUR")).toBe("€0.00");
    expect(moneyLabel(7000, "JPY")).toBe("¥7,000");
    expect(valueSummary({ order: { item: { unitPrice: { amountMinor: 28000, currency: "USD" } } } })).toBe("Order: Item: Unit price: $280.00");
    expect(valueSummary({ orderId: "ord_1001", requestId: "req_0001", productId: "prd_0016" })).toBe("Order ID: ord_1001 · Request ID: req_0001 · Product ID: prd_0016");
  });

  it("renders compact items, looks up missing names in saved evidence and bounds arrays and long values", () => {
    const item = { productId: "prd_0016", name: "Ember Large Serving Platter", quantity: 4, unitPrice: { amountMinor: 28000, currency: "USD" } };
    expect(valueSummary([item])).toBe("Ember Large Serving Platter × 4 ($280.00 each)");
    expect(valueSummary([{ productId: "prd_0016", quantity: 1 }], { productNames: { prd_0016: "Chalk Plate" } })).toBe("Chalk Plate × 1");
    expect(valueSummary([1, 2, 3, 4, 5])).toBe("1 · 2 · 3 · +2");
    expect(valueSummary("a".repeat(500))).toHaveLength(220);
    expect(valueSummary("a".repeat(500))).toMatch(/…$/);
    expect(valueSummary({ body: "a".repeat(500), note: "b".repeat(500) })).toHaveLength(350);
    expect(valueSummary({ body: "a".repeat(500), note: "b".repeat(500) })).toMatch(/…$/);
  });

  it("uses the newest run's resolved currency before the demonstration and shop fallback", () => {
    const demonstration = { trigger: {}, steps: [{ id: "refund", input: { amount: { amountMinor: 14000, currency: "GBP" } }, output: null }] };
    const run = { trigger: {}, steps: [
      { stepId: "refund", input: { amount: { amountMinor: 14000, currency: "USD" } }, output: null },
      { stepId: "refund", input: { amount: { amountMinor: 14000, currency: "EUR" } }, output: null },
    ] };
    const binding = { mode: "path", path: "steps.order.output.items[0].unitPrice.currency" };
    const context = presentationContext(run, demonstration);
    expect(moneyLabel(10000, resolvedCurrency(binding, context, "refund"))).toBe("€100.00");
    expect(resolvedCurrency(binding, presentationContext(null, demonstration), "refund")).toBe("GBP");
    expect(resolvedCurrency(binding)).toBe("USD");
    expect(resolvedCurrency({ mode: "fixed", value: "CAD" }, context, "refund")).toBe("CAD");
    expect(resolvedCurrency(binding, presentationContext({ trigger: {}, steps: [{ stepId: "order", input: {}, output: { items: [{ unitPrice: { amountMinor: 100, currency: "CHF" } }] } }] }))).toBe("CHF");
  });

  it("keeps keyed and positional refund choices distinct and drops path chains", () => {
    expect(candidateLabel({ mode: "expr", expr: { round: [{ "*": [0.5, { find: [{ var: "steps.order.output.items" }, "productId", { var: "trigger.productId" }, "unitPrice.amountMinor"] }] }] } }, "USD")).toBe("50% of the item's unit price");
    expect(candidateLabel({ mode: "expr", expr: { "*": [{ var: "steps.order.output.items[0].unitPrice.amountMinor" }, 0.5] } }, "USD")).toBe("50% of the first item's unit price");
    expect(candidateLabel({ mode: "fixed", value: 14000 }, "USD", {}, true)).toBe("a fixed $140.00");
    expect(actionLabel("unknown-action")).toBe("Unknown action");
    expect(mutationSummary("tag-request", { requestId: "req_0038", tag: "replacement" }, {}, () => "Add tag")).toBe("Add tag “replacement”");
  });
});
