/* oxlint-disable unicorn/no-thenable -- Recipe branches have a non-callable `then` step array. */
import { parseRecipeVersion, type JsonValue } from "@muscle-memory/recipe-engine";

// Hand-written scenario fixtures. Production/demo intake NEVER installs these;
// later drafting/activation tasks provide real catalog authoring workflows.
const fixed = (value: JsonValue) => ({ mode: "fixed" as const, value });
const path = (value: string) => ({ mode: "path" as const, path: value });
const refundAmount = { round: [{ "*": [{ var: "steps.order.output.items[0].unitPrice.amountMinor" }, { var: "trigger.quantity" }, 0.5] }] };
export const damagedItemFixture = parseRecipeVersion({
  id: "ver_fixture_damaged", recipeId: "recipe_fixture_damaged", version: 1, name: "Damaged item: 50% refund",
  trigger: { event: "request.created", match: { "===": [{ var: "trigger.type" }, "damaged_item"] } },
  steps: [
    { id: "order", kind: "action", action: "get-order", args: { orderId: path("trigger.orderId") } },
    { id: "first_item", kind: "branch", condition: { "===": [{ var: "trigger.productId" }, { var: "steps.order.output.items[0].productId" }] }, then: [
      { id: "refund", kind: "action", action: "issue-refund",
        approval: { and: [{ "===": [{ var: "steps.order.output.items[0].unitPrice.currency" }, "USD"] }, { ">": [refundAmount, 10000] }] },
        args: {
          orderId: path("trigger.orderId"), reason: fixed("Damaged item: 50% refund"),
          amount: { amountMinor: { mode: "expr", expr: refundAmount }, currency: path("steps.order.output.items[0].unitPrice.currency") },
        } },
      { id: "reply", kind: "action", action: "send-reply", args: {
        requestId: path("trigger.requestId"), template: fixed("We refunded {{amount}} minor units for your damaged item."),
        variables: { amount: path("steps.refund.output.amount.amountMinor") },
      } },
      { id: "tag", kind: "action", action: "tag-request", args: { requestId: path("trigger.requestId"), tag: fixed("recipe-handled") } },
    ], else: [{ id: "other_item", kind: "handoff", to: "agent", note: fixed("Fixture only supports the first order line; inspect the damaged product.") }] },
  ],
});
export const whereIsMyOrderFixture = parseRecipeVersion({
  id: "ver_fixture_shipment", recipeId: "recipe_fixture_shipment", version: 1, name: "Where is my order?",
  trigger: { event: "request.created", match: { "===": [{ var: "trigger.type" }, "where_is_my_order"] } },
  steps: [
    { id: "shipment", kind: "action", action: "get-shipment-status", args: { orderId: path("trigger.orderId") } },
    { id: "reply", kind: "action", action: "send-reply", args: {
      requestId: path("trigger.requestId"), template: fixed("Order {{orderId}} is {{status}}."),
      variables: { orderId: path("trigger.orderId"), status: path("steps.shipment.output.orderStatus") },
    } },
    { id: "tag", kind: "action", action: "tag-request", args: { requestId: path("trigger.requestId"), tag: fixed("recipe-handled") } },
  ],
});
