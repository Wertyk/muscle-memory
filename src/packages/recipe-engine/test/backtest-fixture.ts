import { parseRecipeVersion, type HistoricalCase } from "../src/index.js";

/** Authored evidence, independent of the executor. Mirrors the three demo deviation types. */
export function brokenMugCases(): readonly HistoricalCase[] {
  return Array.from({ length: 10 }, (_, index): HistoricalCase => {
    const requestId = `req_${String(index + 31).padStart(4, "0")}`;
    const orderId = `ord_${1031 + index}`;
    const price = index === 8 ? 38_000 : 2400 + index * 200;
    const half = Math.floor(price / 2);
    const replacement = index === 7;
    const amountMinor = index === 8 ? price : half;
    const body = replacement ? `Replacement arranged for ${orderId}` : index === 9
      ? `Thank you for the photo. Partial refund arranged for ${orderId}; we will review packaging.`
      : `Refunded half of one piece for ${orderId}`;
    return {
      id: requestId, trigger: { requestId, orderId, category: "damaged", price },
      outcome: [replacement
        ? { action: "create-order", input: { replacementForOrderId: orderId, quantity: 1 } }
        : { action: "issue-refund", input: { orderId, amount: { amountMinor, currency: "USD" } } },
      { action: "send-reply", input: { requestId, body } }],
    };
  });
}

export const brokenMugRecipe = parseRecipeVersion({
  id: "ver_mug_1", recipeId: "recipe_mug", version: 1, name: "Half-price damage refund",
  trigger: { event: "request.created", match: { "===": [{ var: "trigger.category" }, "damaged"] } },
  steps: [
    { id: "order", kind: "action", action: "get-order", args: { orderId: { mode: "path", path: "trigger.orderId" } } },
    { id: "refund", kind: "action", action: "issue-refund", approval: { ">": [{ var: "steps.order.output.price" }, 20_000] },
      args: { orderId: { mode: "path", path: "trigger.orderId" }, amount: {
        amountMinor: { mode: "expr", expr: { floor: [{ "*": [{ var: "steps.order.output.price" }, 0.5] }] } },
        currency: { mode: "fixed", value: "USD" },
      } } },
    { id: "reply", kind: "action", action: "send-reply", args: {
      requestId: { mode: "path", path: "trigger.requestId" },
      body: { mode: "template", template: "Refunded half of one piece for {{trigger.orderId}}" },
    } },
  ],
});
