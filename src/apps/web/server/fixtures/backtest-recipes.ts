import { parseRecipeVersion, type JsonValue } from "@muscle-memory/recipe-engine";

// Hand-written seeded-history fixture, never automatically installed/activated.
// Half-prices in the seed are whole USD dollars; this formatting is deliberately
// fixture-specific. All bindings use trigger/read data, not dry-run write outputs.
const fixed = (value: JsonValue) => ({ mode: "fixed" as const, value });
const path = (value: string) => ({ mode: "path" as const, path: value });
const amount = { floor: [{ "*": [{ var: "steps.order.output.items[0].unitPrice.amountMinor" }, 0.5] }] };
export const damagedItemBacktestFixture = parseRecipeVersion({
  id: "ver_backtest_damaged", recipeId: "recipe_backtest_damaged", version: 1, name: "Seeded damaged item: half refund",
  trigger: { event: "request.created", match: { "===": [{ var: "trigger.type" }, "damaged_item"] } },
  steps: [
    { id: "order", kind: "action", action: "get-order", args: { orderId: path("trigger.orderId") } },
    { id: "customer", kind: "action", action: "get-customer", args: { customerId: path("trigger.customerId") } },
    { id: "refund", kind: "action", action: "issue-refund", approval: { ">": [amount, 10000] }, args: {
      orderId: path("trigger.orderId"), reason: fixed("Damaged item: 50% of one unit price"),
      amount: { amountMinor: { mode: "expr", expr: amount }, currency: path("steps.order.output.items[0].unitPrice.currency") },
    } },
    { id: "reply", kind: "action", action: "send-reply", args: {
      requestId: path("trigger.requestId"), template: fixed("Hello {{name}}, {{outcome}} — Kiln & Co."),
      variables: { name: path("steps.customer.output.name"), outcome: { mode: "expr", expr: { cat: [
        "I'm sorry one ", { var: "steps.order.output.items[0].name" }, " arrived damaged. I've refunded USD ",
        { "/": [amount, 100] }, ".00, half of that piece's price, for ", { var: "trigger.orderId" }, ".",
      ] } } },
    } },
    { id: "handled", kind: "action", action: "tag-request", args: { requestId: path("trigger.requestId"), tag: fixed("handled") } },
    { id: "type_tag", kind: "action", action: "tag-request", args: { requestId: path("trigger.requestId"), tag: fixed("damaged_item") } },
  ],
});
